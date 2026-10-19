// FlowBrowse 服务端主程序（单一 Go 二进制）
//
// 职责（一个进程内并发）：
//  1. TCP 443：标准 HTTPS 转发代理（CONNECT / 绝对形式 + BasicAuth），Chrome chrome.proxy 原生兼容。
//     —— 关键点：代理监听强制 ALPN=http/1.1，避免 h2 CONNECT 的兼容坑（klzgrad naive fork 正是栽在这里）。
//  2. TCP 443 上同一监听还处理"普通 origin 形式请求"：根路径返回空 200（复刻原生 Caddy 默认，防指纹），
//     其余按"密钥目录/随机文件名"提供订阅静态文件（这些非代理请求不要求代理鉴权）。
//  3. UDP 443：WebTransport（真 QUIC/h3），供扩展 RTT 探测/信令。
//  4. TCP 80 + autocert：向 Let's Encrypt 自动申请并续期证书（HTTP-01），443 的 TLS/QUIC 复用同一证书。
//
// 设计边界（务必牢记）：全量接管走这里的 TCP 代理（TCP+TLS，非 QUIC）；QUIC 只在 UDP443 的 WebTransport 通道，
//  二者不可兼得（见 docs/ARCHITECTURE.md）。域名、端口、凭据全部来自环境变量，零硬编码。
package main

import (
	"crypto/tls"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
	"golang.org/x/crypto/acme/autocert"
)

// 全局配置（启动时从环境变量读取）
type config struct {
	domain    string // 服务域名（可自定义）
	tcpAddr   string // HTTPS 转发代理 + 站点监听地址，如 :443
	wtAddr    string // WebTransport 监听地址，如 :443（UDP）
	acmeAddr  string // ACME HTTP-01 监听地址，如 :80
	webRoot   string // 订阅静态文件根目录
	authUser  string // 代理 BasicAuth 用户
	authPass  string // 代理 BasicAuth 口令
	certCache string // autocert 证书缓存目录
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	domain := envOr("DOMAIN", "sel2.lkz.pub") // 测试默认，可换任意域名
	tcpPort := envOr("FB_TCP_PORT", "443")
	wtPort := envOr("FB_WT_PORT", "443")
	return config{
		domain:    domain,
		tcpAddr:   ":" + tcpPort,
		wtAddr:    ":" + wtPort,
		acmeAddr:  ":" + envOr("FB_ACME_PORT", "80"),
		webRoot:   envOr("FB_WEB_ROOT", "/srv/flowbrowse"),
		authUser:  envOr("AUTH_USER", ""),
		authPass:  envOr("AUTH_PASS", ""),
		certCache: envOr("FB_CERT_CACHE", "/var/lib/flowbrowse/certcache"),
	}
}

// hop-by-hop 头部：转发代理必须剥离，避免连接语义错乱
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func main() {
	cfg := loadConfig()
	log.Printf("[FlowBrowse] 启动 域名=%s TCP=%s UDP(wt)=%s ACME=%s webroot=%s",
		cfg.domain, cfg.tcpAddr, cfg.wtAddr, cfg.acmeAddr, cfg.webRoot)

	// ===== autocert：自动申请/续期 Let's Encrypt 证书（HTTP-01）=====
	_ = os.MkdirAll(cfg.certCache, 0700)
	mgr := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(cfg.domain),
		Cache:      autocert.DirCache(cfg.certCache),
	}

	// 代理 TLS：强制 ALPN=http/1.1（标准 https 代理走 HTTP/1.1 CONNECT，最稳），证书由 autocert 动态提供
	proxyTLS := &tls.Config{GetCertificate: mgr.GetCertificate, NextProtos: []string{"http/1.1"}}
	// WebTransport TLS：QUIC/h3 用同一 autocert 证书；ALPN 由 http3.ConfigureTLSConfig 统一设置
	wtTLS := &tls.Config{GetCertificate: mgr.GetCertificate}

	errc := make(chan error, 3)

	// —— ACME HTTP-01（80 端口）——
	go func() {
		log.Printf("[FlowBrowse] ACME HTTP-01 监听 %s", cfg.acmeAddr)
		errc <- http.ListenAndServe(cfg.acmeAddr, mgr.HTTPHandler(nil))
	}()

	// —— HTTPS 转发代理 + 站点（TCP 443）——
	go func() {
		ln, err := net.Listen("tcp", cfg.tcpAddr)
		if err != nil {
			errc <- fmt.Errorf("TCP 监听失败: %w", err)
			return
		}
		tlsLn := tls.NewListener(ln, proxyTLS)
		srv := &http.Server{
			Handler:           newProxyHandler(cfg),
			ReadHeaderTimeout: 20 * time.Second,
		}
		log.Printf("[FlowBrowse] HTTPS 转发代理+站点 监听 %s (TLS, ALPN http/1.1)", cfg.tcpAddr)
		errc <- srv.Serve(tlsLn)
	}()

	// —— WebTransport（UDP 443）——
	go func() {
		errc <- runWebTransport(cfg, wtTLS)
	}()

	// 任一子系统致命错误即退出，交由 systemd 受控重启
	log.Fatal(<-errc)
}

// newProxyHandler 返回路由处理器，按请求形态分派：CONNECT / 绝对形式 / origin 站点
func newProxyHandler(cfg config) http.Handler {
	subFS := http.FileServer(http.Dir(cfg.webRoot)) // 订阅文件只含密钥路径下的文件，不泄露其它
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodConnect:
			handleConnect(w, r, cfg)
		case r.URL.IsAbs() && r.URL.Host != "":
			handleAbsolute(w, r, cfg, subFS)
		default:
			handleSite(w, r, subFS)
		}
	})
}

// ===== 代理鉴权：读取 Proxy-Authorization（或 Authorization）做 Basic 校验 =====
func authOK(r *http.Request, cfg config) bool {
	// Chrome 的 https 代理会发 Proxy-Authorization；兼容 Authorization
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
	// 恒定时间比较，避免时序侧信道
	return subtle.ConstantTimeCompare([]byte(user), []byte(cfg.authUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(pass), []byte(cfg.authPass)) == 1
}

func challenge407(w http.ResponseWriter) {
	w.Header().Set("Proxy-Authenticate", `Basic realm="FlowBrowse"`)
	w.WriteHeader(http.StatusProxyAuthRequired)
}

// ===== CONNECT 隧道：鉴权→拨号目标→回 200→双向裸拷贝 =====
func handleConnect(w http.ResponseWriter, r *http.Request, cfg config) {
	authed := authOK(r, cfg)
	// 诊断日志：记录来源、目标、是否带鉴权头、鉴权结果，便于定位 Chrome 与 curl 的差异
	log.Printf("[FlowBrowse-PROXY] CONNECT from=%s target=%s hasProxyAuth=%v hasAuth=%v authed=%v",
		r.RemoteAddr, r.Host, r.Header.Get("Proxy-Authorization") != "", r.Header.Get("Authorization") != "", authed)
	if !authed {
		challenge407(w)
		return
	}
	target := r.Host // 形如 host:port
	up, err := net.DialTimeout("tcp", target, 15*time.Second)
	if err != nil {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	// 劫持客户端底层连接，手动回 200 后进入原始字节转发（这才是 Chrome 原生隧道可用的关键）
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
	go func() { io.Copy(up, client); up.Close() }() // 客户端→上游
	io.Copy(client, up)                              // 上游→客户端
	client.Close()
	up.Close()
}

// ===== 绝对形式请求（http:// 目标）：鉴权→改写请求→转发→回传 =====
func handleAbsolute(w http.ResponseWriter, r *http.Request, cfg config, subFS http.Handler) {
	if !authOK(r, cfg) {
		challenge407(w)
		return
	}
	// 复制请求，剥离 hop-by-hop 与代理鉴权头
	outreq := r.Clone(r.Context())
	// 目标即 r.URL（含 scheme/host），去掉 fragment
	outreq.URL.Fragment = ""
	for _, h := range hopHeaders {
		outreq.Header.Del(h)
	}
	// 用不带自动代理的独立 transport，避免二次代理
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
	// 回传状态与头部（去掉 hop-by-hop）
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ===== 站点：根=空200（复刻原生 Caddy 默认，防指纹）；其余走订阅文件 =====
func handleSite(w http.ResponseWriter, r *http.Request, subFS http.Handler) {
	if r.URL.Path == "/" || r.URL.Path == "" {
		w.WriteHeader(http.StatusOK) // 空 body，size=0，与普通未配置 Caddy 一致
		return
	}
	subFS.ServeHTTP(w, r) // 仅命中"密钥目录/随机文件名"，未知路径自然 404
}

// copyHeaders 复制响应头，跳过 hop-by-hop
func copyHeaders(dst, src http.Header) {
	skip := map[string]bool{}
	for _, h := range hopHeaders {
		skip[http.CanonicalHeaderKey(h)] = true
	}
	for k, vs := range src {
		if skip[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// ===== WebTransport（UDP443）：会话建立后数据报回显(RTT)+双向流回显；API 与 quic-go/webtransport-go v0.13 对齐 =====
func runWebTransport(cfg config, wtTLS *tls.Config) error {
	mux := http.NewServeMux()
	h3Server := &http3.Server{
		Addr:      cfg.wtAddr,
		TLSConfig: http3.ConfigureTLSConfig(wtTLS),
		QUICConfig: &quic.Config{
			EnableDatagrams:                  true, // WebTransport 数据报（RTT 探测）前提
			EnableStreamResetPartialDelivery: true, // webtransport-go v0.13 必需：缺失会导致 Chrome "Opening handshake failed"（回环实测已验证）
			MaxIdleTimeout:                   30 * time.Second,
		},
	}
	webtransport.ConfigureHTTP3Server(h3Server)

	server := webtransport.Server{
		H3:          h3Server,
		CheckOrigin: allowOrigin(cfg),
	}
	mux.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		sess, err := server.Upgrade(w, r)
		if err != nil {
			log.Printf("[FlowBrowse-WT] 会话升级失败: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		remote := sess.RemoteAddr().String()
		log.Printf("[FlowBrowse-WT] 新会话 %s", remote)
		go datagramEcho(sess, remote)
		go streamEcho(sess, remote)
		<-sess.Context().Done()
		log.Printf("[FlowBrowse-WT] 会话结束 %s", remote)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, strings.NewReader(`{"status":"ok","service":"flowbrowse"}`))
	})
	h3Server.Handler = mux

	log.Printf("[FlowBrowse] WebTransport 监听 UDP %s (域名 %s)，端点 /wt /healthz", cfg.wtAddr, cfg.domain)
	return server.ListenAndServe()
}

// allowOrigin：WebTransport 校验浏览器 Origin（扩展为 chrome-extension://<id>）。
// 未配 FB_ALLOW_ORIGINS 时放行全部并告警，便于联调；生产应设白名单。
func allowOrigin(cfg config) func(*http.Request) bool {
	allowed := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("FB_ALLOW_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return func(r *http.Request) bool {
		if len(allowed) == 0 {
			log.Printf("[FlowBrowse-WT] 未配置 FB_ALLOW_ORIGINS，放行全部 Origin（仅联调）：%q", r.Header.Get("Origin"))
			return true
		}
		return allowed[r.Header.Get("Origin")]
	}
}

// datagramEcho：原样回发数据报，扩展据此测 RTT。
func datagramEcho(sess *webtransport.Session, remote string) {
	ctx := sess.Context()
	for {
		data, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		if err := sess.SendDatagram(data); err != nil {
			log.Printf("[FlowBrowse-WT] 数据报回发失败 %s: %v", remote, err)
			return
		}
	}
}

// streamEcho：双向流原样回传（信令/加速预留）。
func streamEcho(sess *webtransport.Session, remote string) {
	ctx := sess.Context()
	for {
		str, err := sess.AcceptStream(ctx)
		if err != nil {
			return
		}
		go func(s *webtransport.Stream) {
			defer s.Close()
			var buf [4096]byte
			for {
				n, rerr := s.Read(buf[:])
				if n > 0 {
					if _, werr := s.Write(buf[:n]); werr != nil {
						return
					}
				}
				if rerr != nil && rerr != io.EOF && !strings.Contains(rerr.Error(), "closed") && !strings.Contains(rerr.Error(), "cancel") {
					log.Printf("[FlowBrowse-WT] 流回显异常 %s: %v", remote, rerr)
					return
				}
				if rerr != nil {
					return
				}
			}
		}(str)
	}
}
