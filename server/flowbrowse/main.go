// FlowBrowse 单文件服务（TCP 443）：转发代理 + 订阅站点 + ACME 自动证书 + IP 白名单。
//
// 架构（放弃 QUIC/WebTransport，只用 TCP 443）：
//   - TCP 443 一个 TLS 监听按请求类型复用：
//       CONNECT  → 标准 HTTPS 转发代理（Chrome https 代理，ALPN http/1.1）
//       GET /密钥/… → 订阅文件（命中即把客户端 IP 加入白名单）
//       GET /    → 空 200（无指纹，等同未配置的 Caddy）
//   - TCP 80  → autocert HTTP-01（签发/续期 LE 证书）
// 安全：代理免密码，但用「自动 IP 白名单」——只有成功拉过订阅（知道密钥 URL）的客户端 IP 才放行 CONNECT。
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
			// 临时鉴权诊断：只记录“是否带凭据/凭据长度/校验结果”，不落任何密钥明文
			pa := r.Header.Get("Proxy-Authorization")
			if pa == "" {
				pa = r.Header.Get("Authorization")
			}
			authLen := 0
			if strings.HasPrefix(pa, "Basic ") {
				if d, e := base64.StdEncoding.DecodeString(strings.TrimPrefix(pa, "Basic ")); e == nil {
					authLen = len(d)
				}
			}
			log.Printf("[CONNECT] from=%s target=%s hasAuth=%v authLen=%d allowed=%v authOK=%v",
				clientIP(r), r.Host, pa != "", authLen, al.allowed(r), authOK(r, cfg))
			if !al.allowed(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !authOK(r, cfg) {
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
		// 3) 普通 GET：站点/订阅
		if r.URL.Path == "/" || r.URL.Path == "" {
			w.WriteHeader(http.StatusOK) // 空 body，防指纹
			return
		}
		// 订阅文件：命中 200 说明对方知道密钥路径 → 记录其 IP 进白名单
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		subFS.ServeHTTP(rec, r)
		if rec.status == http.StatusOK {
			al.add(clientIP(r))
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

// ===== 自动 IP 白名单 =====
// allowList：内存 map[ip]过期时间 + 文件持久化；订阅命中即 add，代理请求校验 allowed。
type allowList struct {
	cfg config
	mu  sync.RWMutex
	ips map[string]time.Time
}

func newAllowList(cfg config) *allowList {
	a := &allowList{cfg: cfg, ips: map[string]time.Time{}}
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

func (a *allowList) load() {
	b, err := os.ReadFile(a.cfg.allowFile)
	if err != nil {
		return // 文件不存在：首次为空
	}
	m := map[string]int64{}
	if json.Unmarshal(b, &m) == nil {
		now := time.Now()
		for ip, exp := range m {
			if time.Unix(exp, 0).After(now) {
				a.ips[ip] = time.Unix(exp, 0)
			}
		}
	}
}

func (a *allowList) save() {
	m := map[string]int64{}
	for ip, exp := range a.ips {
		m[ip] = exp.Unix()
	}
	b, _ := json.Marshal(m)
	_ = os.MkdirAll(dirName(a.cfg.allowFile), 0700)
	_ = os.WriteFile(a.cfg.allowFile, b, 0600)
}

// add 记录一个客户端 IP（TTL 续期）。白名单关闭时无操作。
func (a *allowList) add(ip string) {
	if !a.cfg.allowOn || ip == "" {
		return
	}
	a.mu.Lock()
	a.ips[ip] = time.Now().Add(a.cfg.allowTTL)
	a.save()
	a.mu.Unlock()
	log.Printf("[FlowBrowse] 白名单加入 IP=%s（订阅命中）", ip)
}

// allowed：白名单关闭=全放行；开启=仅放行未过期的 IP。
func (a *allowList) allowed(r *http.Request) bool {
	if !a.cfg.allowOn {
		return true
	}
	ip := clientIP(r)
	a.mu.RLock()
	exp, ok := a.ips[ip]
	a.mu.RUnlock()
	return ok && time.Now().Before(exp)
}

func (a *allowList) cleanup() {
	a.mu.Lock()
	now := time.Now()
	for ip, exp := range a.ips {
		if now.After(exp) {
			delete(a.ips, ip)
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
