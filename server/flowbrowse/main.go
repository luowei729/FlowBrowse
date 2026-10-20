// FlowBrowse 单文件服务（TCP 443）：转发代理 + 订阅站点 + ACME 自动证书 + IP 白名单。
//
// 架构（放弃 QUIC/WebTransport，只用 TCP 443）：
//   - TCP 443 一个 TLS 监听按请求类型复用：
//       CONNECT  → 标准 HTTPS 转发代理（Chrome https 代理，ALPN http/1.1）
//       GET /密钥/… → 订阅文件（命中即把客户端 IP 加入白名单）
//       GET /<管理密钥>/allow → IP 白名单上报（add/del/list，适配端口转发下动态放行）
//       GET /    → 空 200（无指纹，等同未配置的 Caddy）
//   - TCP 80  → autocert HTTP-01（签发/续期 LE 证书）
// 安全：代理免密码，用「IP 白名单」放行 CONNECT——自动学习(拉过订阅的 IP) + 静态网段(FB_PROXY_ALLOW_STATIC) + 上报接口(FB_ADMIN_TOKEN 保护)。
package main

import (
	"crypto/tls"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

type config struct {
	domain      string
	addr        string // TCP 443：代理 + 订阅 + 站点（复用）
	acmeAddr    string // TCP 80：ACME HTTP-01
	webRoot     string
	authUser    string
	authPass    string
	authEnabled bool   // FB_PROXY_AUTH=on 时额外要求 Basic（默认 off，靠白名单）
	allowOn     bool   // FB_PROXY_ALLOW：是否启用 IP 白名单（默认 on）
	allowTTL    time.Duration
	allowFile   string
	allowStatic []string // FB_PROXY_ALLOW_STATIC：静态放行的 IP/CIDR（永久、不过期）
	adminToken  string   // FB_ADMIN_TOKEN：白名单上报接口令牌（空=禁用上报接口）
	certCache   string
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func isOn(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return v == "on" || v == "1" || v == "true" || v == "yes"
}

// splitList：把逗号/空格分隔的列表切成非空项（用于 FB_PROXY_ALLOW_STATIC 的 IP/CIDR）。
func splitList(v string) []string {
	fields := strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == ';' })
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

func loadConfig() config {
	// 解析 TTL（小时数，默认 720h=30 天）
	ttlH := 720
	if v := os.Getenv("FB_PROXY_ALLOW_TTL_HOURS"); v != "" {
		fmt.Sscanf(v, "%d", &ttlH)
	}
	return config{
		domain:      envOr("DOMAIN", "sel2.lkz.pub"),
		addr:        ":" + envOr("FB_TCP_PORT", "443"),
		acmeAddr:    ":" + envOr("FB_ACME_PORT", "80"),
		webRoot:     envOr("FB_WEB_ROOT", "/srv/flowbrowse"),
		authUser:    envOr("AUTH_USER", ""),
		authPass:    envOr("AUTH_PASS", ""),
		authEnabled: isOn(envOr("FB_PROXY_AUTH", "on")), // 默认开启密码鉴权（主访问控制）
		allowOn:     isOn(envOr("FB_PROXY_ALLOW", "off")), // IP 白名单为可选加固，默认关
		allowTTL:    time.Duration(ttlH) * time.Hour,
		allowFile:   envOr("FB_PROXY_ALLOW_FILE", "/var/lib/flowbrowse/allowlist.json"),
		allowStatic: splitList(envOr("FB_PROXY_ALLOW_STATIC", "")),
		adminToken:  strings.TrimSpace(envOr("FB_ADMIN_TOKEN", "")),
		certCache:   envOr("FB_CERT_CACHE", "/var/lib/flowbrowse/certcache"),
	}
}

// hop-by-hop 头部：转发代理必须剥离
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func main() {
	cfg := loadConfig()
	log.Printf("[FlowBrowse] 启动 域名=%s 监听=%s(代理+订阅) ACME=%s 白名单=%v(TTL=%s) 鉴权=%v webroot=%s",
		cfg.domain, cfg.addr, cfg.acmeAddr, cfg.allowOn, cfg.allowTTL, cfg.authEnabled, cfg.webRoot)

	al := newAllowList(cfg)

	// 白名单上报接口启动提示（不打印管理密钥明文，避免落入日志造成泄露）
	if cfg.allowOn && cfg.adminToken == "" {
		log.Printf("[FlowBrowse][警告] 白名单已开启但未设 FB_ADMIN_TOKEN：上报接口不可用（仅自动学习+静态列表）")
	} else if cfg.adminToken != "" {
		log.Printf("[FlowBrowse] 白名单上报接口已启用：GET /<FB_ADMIN_TOKEN>/allow（管理密钥见 .env，勿外泄）")
	}

	// autocert：自动申请/续期 LE 证书（HTTP-01，走 :80）
	_ = os.MkdirAll(cfg.certCache, 0700)
	mgr := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(cfg.domain),
		Cache:      autocert.DirCache(cfg.certCache),
	}

	errc := make(chan error, 2)
	// ACME HTTP-01（TCP 80）
	go func() {
		log.Printf("[FlowBrowse] ACME HTTP-01 监听 %s", cfg.acmeAddr)
		errc <- http.ListenAndServe(cfg.acmeAddr, mgr.HTTPHandler(nil))
	}()

	// TCP 443：代理 + 订阅 + 站点（复用），强制 ALPN=http/1.1（https 代理用 HTTP/1.1 CONNECT 最稳）
	tlsConf := &tls.Config{GetCertificate: mgr.GetCertificate, NextProtos: []string{"http/1.1"}}
	go func() { errc <- serveTLS(cfg.addr, tlsConf, newRootHandler(cfg, al)) }()

	log.Fatal(<-errc)
}

// serveTLS 在 addr 上以 TLS(h1) 提供 http.Handler。
func serveTLS(addr string, tlsConf *tls.Config, h http.Handler) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", addr, err)
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 20 * time.Second}
	log.Printf("[FlowBrowse] HTTPS 监听 %s (TLS, ALPN http/1.1)", addr)
	return srv.Serve(tls.NewListener(ln, tlsConf))
}

// newRootHandler：TCP 443 单入口，按方法/路径分流。
func newRootHandler(cfg config, al *allowList) http.Handler {
	subFS := http.FileServer(http.Dir(cfg.webRoot))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1) CONNECT = 转发代理请求
		if r.Method == http.MethodConnect {
			allowed := al.allowed(r)
			authed := authOK(r, cfg)
			// 只在“被拒”时记一行安全事件（不落任何凭据明文，只记是否带头），便于排查滥用/掉线
			if !allowed || !authed {
				pa := r.Header.Get("Proxy-Authorization")
				if pa == "" {
					pa = r.Header.Get("Authorization")
				}
				log.Printf("[CONNECT拒绝] from=%s target=%s allowed=%v authOK=%v hasAuth=%v", clientIP(r), r.Host, allowed, authed, pa != "")
			}
			if !allowed {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !authed {
				challenge407(w)
				return
			}
			handleConnect(w, r)
			return
		}
		// 2) 绝对形式 http:// 目标（少数客户端用）也当代理处理
		if r.URL.IsAbs() && r.URL.Host != "" {
			if !al.allowed(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !authOK(r, cfg) {
				challenge407(w)
				return
			}
			handleAbsolute(w, r)
			return
		}
		// 3) 白名单上报接口：/<adminToken>/allow?...（受管理密钥保护，动态增删查放行项）
		if cfg.adminToken != "" && strings.HasPrefix(r.URL.Path, "/"+cfg.adminToken+"/") {
			if strings.TrimPrefix(r.URL.Path, "/"+cfg.adminToken+"/") == "allow" {
				al.handleAdmin(w, r)
				return
			}
		}
		// 4) 普通 GET：站点/订阅
		if r.URL.Path == "/" || r.URL.Path == "" {
			w.WriteHeader(http.StatusOK) // 空 body，防指纹
			return
		}
		// 订阅文件：命中 200 说明对方知道密钥路径 → 记录其 IP 进白名单
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		subFS.ServeHTTP(rec, r)
		if rec.status == http.StatusOK {
			al.addIP(clientIP(r))
		}
	})
}

// statusRecorder 捕获响应状态码，用于判断订阅文件是否命中（仅包装 GET 订阅路径，不需 Hijack）。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

// authOK：未开启鉴权时直接放行（默认，靠白名单）；开启时校验 Basic。
func authOK(r *http.Request, cfg config) bool {
	if !cfg.authEnabled {
		return true
	}
	val := r.Header.Get("Proxy-Authorization")
	if val == "" {
		val = r.Header.Get("Authorization")
	}
	if !strings.HasPrefix(val, "Basic ") {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(val, "Basic "))
	if err != nil {
		return false
	}
	user, pass, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return false
	}
	// 仅用户名模式：AUTH_PASS 为空时只校验用户名（用户名即密钥，密码留空）
	if cfg.authPass == "" {
		return subtle.ConstantTimeCompare([]byte(user), []byte(cfg.authUser)) == 1
	}
	return subtle.ConstantTimeCompare([]byte(user), []byte(cfg.authUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(pass), []byte(cfg.authPass)) == 1
}

func challenge407(w http.ResponseWriter) {
	w.Header().Set("Proxy-Authenticate", `Basic realm="FlowBrowse"`)
	w.WriteHeader(http.StatusProxyAuthRequired)
}

// ===== CONNECT 隧道：拨号→回 200→双向裸拷贝 =====
func handleConnect(w http.ResponseWriter, r *http.Request) {
	up, err := net.DialTimeout("tcp", r.Host, 15*time.Second)
	if err != nil {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	client, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		up.Close()
		return
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		up.Close()
		client.Close()
		return
	}
	go func() { io.Copy(up, client); up.Close() }()
	io.Copy(client, up)
	client.Close()
	up.Close()
}

// ===== 绝对形式请求（http:// 目标）=====
func handleAbsolute(w http.ResponseWriter, r *http.Request) {
	outreq := r.Clone(r.Context())
	outreq.URL.Fragment = ""
	for _, h := range hopHeaders {
		outreq.Header.Del(h)
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		MaxIdleConnsPerHost:   16,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}}
	resp, err := client.Do(outreq)
	if err != nil {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// ===== IP 白名单（自动学习 + 静态网段 + 管理密钥上报；支持 IP 与 CIDR）=====
// 为什么这么设计：客户端经 iptables 端口转发到达时，FlowBrowse 看到的来源 IP 可能是转发机/出口 IP，
//   与“拉订阅”那条连接不一致，纯靠自动学习会误拦。故提供：静态网段(写死转发机)、上报接口(动态加 IP/网段)。
type allowEntry struct {
	ipnet *net.IPNet // 归一化网段（精确 IP 记作 /32 或 /128）；用 ipnet 避免与包名 net 混淆
	exp   time.Time  // 过期时间（动态项用；静态项不存这里、永不过期）
}

type allowList struct {
	cfg        config
	mu         sync.RWMutex
	entries    map[string]allowEntry // 动态项：key=归一化 CIDR 串（自动学习 + 上报）
	staticNets []*net.IPNet          // 静态项：来自 FB_PROXY_ALLOW_STATIC，构造时解析，不再变化
}

func newAllowList(cfg config) *allowList {
	a := &allowList{cfg: cfg, entries: map[string]allowEntry{}}
	// 解析静态网段（配置来的，永久放行）；非法条目只告警不中断，便于运维排查拼写
	for _, s := range cfg.allowStatic {
		if n, err := toNet(s); err == nil {
			a.staticNets = append(a.staticNets, n)
		} else {
			log.Printf("[FlowBrowse][警告] FB_PROXY_ALLOW_STATIC 无法解析条目 %q: %v", s, err)
		}
	}
	if len(a.staticNets) > 0 {
		log.Printf("[FlowBrowse] 静态白名单网段 %d 个（永久放行）", len(a.staticNets))
	}
	a.load()
	// 后台定期清理过期项
	go func() {
		for {
			time.Sleep(6 * time.Hour)
			a.cleanup()
		}
	}()
	return a
}

// toNet：把 "1.2.3.4" 归一化为 /32、"10.0.0.0/8" 原样、"::1"→/128。统一便于 Contains 匹配与持久化去重。
func toNet(s string) (*net.IPNet, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("空")
	}
	if strings.Contains(s, "/") {
		_, n, err := net.ParseCIDR(s)
		return n, err
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return nil, fmt.Errorf("非法 IP: %s", s)
	}
	bits := 128
	if ip.To4() != nil {
		bits = 32
	}
	return &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)}, nil
}

func (a *allowList) load() {
	b, err := os.ReadFile(a.cfg.allowFile)
	if err != nil {
		return // 文件不存在：首次为空
	}
	m := map[string]int64{}
	if json.Unmarshal(b, &m) == nil {
		now := time.Now()
		for k, exp := range m {
			n, err := toNet(k)
			if err != nil {
				continue
			}
			if time.Unix(exp, 0).After(now) {
				a.entries[n.String()] = allowEntry{ipnet: n, exp: time.Unix(exp, 0)}
			}
		}
	}
}

func (a *allowList) save() {
	m := map[string]int64{}
	for k, e := range a.entries {
		m[k] = e.exp.Unix()
	}
	b, _ := json.Marshal(m)
	_ = os.MkdirAll(dirName(a.cfg.allowFile), 0700)
	_ = os.WriteFile(a.cfg.allowFile, b, 0600)
}

// addIP：记录一个客户端 IP（订阅命中用），按默认 TTL 续期。白名单关闭时无操作。
func (a *allowList) addIP(ip string) {
	if !a.cfg.allowOn || ip == "" {
		return
	}
	if _, err := a.addNet(ip, a.cfg.allowTTL); err != nil {
		log.Printf("[FlowBrowse][警告] 自动登记 IP 失败 %q: %v", ip, err)
	}
}

// addNet：加入 IP 或 CIDR（上报接口用）。ttl<=0 用默认 TTL。返回归一化后的键。
func (a *allowList) addNet(s string, ttl time.Duration) (string, error) {
	n, err := toNet(s)
	if err != nil {
		return "", err
	}
	if ttl <= 0 {
		ttl = a.cfg.allowTTL
	}
	key := n.String()
	a.mu.Lock()
	a.entries[key] = allowEntry{ipnet: n, exp: time.Now().Add(ttl)}
	a.save()
	a.mu.Unlock()
	return key, nil
}

// del：删除一个动态放行项（静态项来自配置、不可运行时删除）。命中返回 true。
func (a *allowList) del(s string) bool {
	n, err := toNet(s)
	if err != nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.entries[n.String()]; ok {
		delete(a.entries, n.String())
		a.save()
		return true
	}
	return false
}

// allowed：白名单关闭=全放行；开启=静态网段命中 或 动态项未过期命中。支持 CIDR 包含判断。
func (a *allowList) allowed(r *http.Request) bool {
	if !a.cfg.allowOn {
		return true
	}
	ip := net.ParseIP(clientIP(r))
	if ip == nil {
		return false
	}
	now := time.Now()
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, n := range a.staticNets { // 静态：永久放行
		if n.Contains(ip) {
			return true
		}
	}
	for _, e := range a.entries { // 动态：未过期且网段包含
		if e.exp.After(now) && e.ipnet.Contains(ip) {
			return true
		}
	}
	return false
}

// listJSON：返回当前白名单快照（供上报接口 ?list=1 查看）。
func (a *allowList) listJSON() map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	sn := make([]string, 0, len(a.staticNets))
	for _, n := range a.staticNets {
		sn = append(sn, n.String())
	}
	dy := map[string]string{}
	for k, e := range a.entries {
		dy[k] = e.exp.Format(time.RFC3339)
	}
	return map[string]any{"static": sn, "dynamic": dy}
}

// handleAdmin：白名单上报接口。GET/POST /<adminToken>/allow
//   ?list=1        查看当前白名单（静态+动态）
//   ?del=<ip|cidr> 删除一个动态放行项（静态项不可删）
//   ?add=<ip|cidr> 添加；add=auto 表示添加调用方来源 IP；&ttl=<小时> 覆盖有效期
//   无参数          默认 add=auto（上报自己来源 IP，适配端口转发下的固定出口）
func (a *allowList) handleAdmin(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// 1) 查询
	if q.Get("list") != "" {
		b, _ := json.Marshal(a.listJSON())
		w.Write(b)
		return
	}
	// 2) 删除
	if d := q.Get("del"); d != "" {
		if a.del(d) {
			fmt.Fprintf(w, "deleted %s\n", d)
			return
		}
		http.Error(w, "not found 或为静态项(不可运行时删除)\n", http.StatusNotFound)
		return
	}
	// 3) 添加（无 add 参数时默认上报自己）
	addv := q.Get("add")
	if addv == "" || addv == "auto" {
		addv = clientIP(r)
	}
	ttl := a.cfg.allowTTL
	if hv := q.Get("ttl"); hv != "" {
		var h int
		if _, err := fmt.Sscanf(hv, "%d", &h); err == nil && h > 0 {
			ttl = time.Duration(h) * time.Hour
		}
	}
	key, err := a.addNet(addv, ttl)
	if err != nil {
		http.Error(w, "非法 IP/CIDR: "+err.Error()+"\n", http.StatusBadRequest)
		return
	}
	log.Printf("[FlowBrowse] 白名单上报：加入 %s（调用来源=%s）", key, clientIP(r))
	fmt.Fprintf(w, "allowed %s\n", key)
}

func (a *allowList) cleanup() {
	a.mu.Lock()
	now := time.Now()
	for k, e := range a.entries {
		if now.After(e.exp) {
			delete(a.entries, k)
		}
	}
	a.save()
	a.mu.Unlock()
}

// clientIP 从 RemoteAddr 取纯 IP（云 NAT 为 IP 级，RemoteAddr 即真实客户端 IP）
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func dirName(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "."
}
