// FlowBrowse 服务端主程序（单一 Go 二进制）
//
// 监听分工（域名/端口全部来自环境变量，零硬编码）：
//  1. TCP 443（FB_TCP_PORT）：普通站点——根路径空 200（复刻未配置 Caddy 的默认，防指纹）+ 密钥路径订阅静态文件。
//     域名对外就是一个正常 HTTPS 网站。
//  2. TCP 保密端口（FB_PROXY_PORT）：HTTPS 转发代理（CONNECT / 绝对形式）。默认【不鉴权】——
//     因为 Chrome 对 https 代理的 CONNECT 不支持扩展自动注入 BasicAuth（会弹框），故改用"非常规端口"做隐蔽；
//     仍可用 FB_PROXY_AUTH=on 开启 BasicAuth（若你换到 HTTP/SOCKS5 代理则能自动鉴权）。
//     CONNECT 目标在 TLS 内传输，对 GFW 隐藏（这是选 https 代理而非 http/socks5 的核心理由）。
//  3. UDP 443（FB_WT_PORT）：WebTransport（真 QUIC/h3），供扩展 RTT 探测/信令。
//  4. TCP 80：autocert HTTP-01，自动向 Let's Encrypt 申请/续期证书，供上面 TLS/QUIC 复用。
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

type config struct {
	domain      string
	siteAddr    string // 站点+订阅监听（TCP，默认 :443）
	proxyAddr   string // 转发代理监听（TCP 保密端口，默认 :2096）
	wtAddr      string // WebTransport 监听（UDP）
	acmeAddr    string // ACME HTTP-01（TCP :80）
	webRoot     string
	authUser    string
	authPass    string
	authEnabled bool // FB_PROXY_AUTH=on/1/true 时启用代理 BasicAuth
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
	domain := envOr("DOMAIN", "sel2.lkz.pub") // 测试默认，可换任意域名
	sitePort := envOr("FB_TCP_PORT", "443")
	proxyPort := envOr("FB_PROXY_PORT", "2096") // 转发代理的保密端口（非常规，隐蔽）
	wtPort := envOr("FB_WT_PORT", "443")
	return config{
		domain:      domain,
		siteAddr:    ":" + sitePort,
		proxyAddr:   ":" + proxyPort,
		wtAddr:      ":" + wtPort,
		acmeAddr:    ":" + envOr("FB_ACME_PORT", "80"),
		webRoot:     envOr("FB_WEB_ROOT", "/srv/flowbrowse"),
		authUser:    envOr("AUTH_USER", ""),
		authPass:    envOr("AUTH_PASS", ""),
		authEnabled: isOn(envOr("FB_PROXY_AUTH", "off")),
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
	log.Printf("[FlowBrowse] 启动 域名=%s 站点=%s 代理=%s UDP(wt)=%s ACME=%s 代理鉴权=%v webroot=%s",
		cfg.domain, cfg.siteAddr, cfg.proxyAddr, cfg.wtAddr, cfg.acmeAddr, cfg.authEnabled, cfg.webRoot)

	// autocert：自动申请/续期 LE 证书（HTTP-01）
	_ = os.MkdirAll(cfg.certCache, 0700)
	mgr := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(cfg.domain),
		Cache:      autocert.DirCache(cfg.certCache),
	}
	// 站点/代理都走 TLS 且强制 ALPN=http/1.1（https 代理用 HTTP/1.1 CONNECT 最稳）
	siteTLS := &tls.Config{GetCertificate: mgr.GetCertificate, NextProtos: []string{"http/1.1"}}
	proxyTLS := &tls.Config{GetCertificate: mgr.GetCertificate, NextProtos: []string{"http/1.1"}}
	wtTLS := &tls.Config{GetCertificate: mgr.GetCertificate}

	errc := make(chan error, 4)

	// ACME HTTP-01
	go func() {
		log.Printf("[FlowBrowse] ACME HTTP-01 监听 %s", cfg.acmeAddr)
		errc <- http.ListenAndServe(cfg.acmeAddr, mgr.HTTPHandler(nil))
	}()

	// 站点（TCP 443）：空200首页 + 订阅文件
	go func() {
		errc <- serveTLS(cfg.siteAddr, siteTLS, newSiteHandler(cfg))
	}()

	// 转发代理（TCP 保密端口）
	go func() {
		errc <- serveTLS(cfg.proxyAddr, proxyTLS, newProxyHandler(cfg))
	}()

	// WebTransport（UDP）
	go func() {
		errc <- runWebTransport(cfg, wtTLS)
	}()

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

// ===== 站点处理器：根=空200；其余=密钥路径订阅文件 =====
func newSiteHandler(cfg config) http.Handler {
	subFS := http.FileServer(http.Dir(cfg.webRoot))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "" {
			w.WriteHeader(http.StatusOK) // 空 body，等同未配置的 Caddy 默认，防指纹
			return
		}
		subFS.ServeHTTP(w, r) // 仅命中密钥路径；未知路径 404
	})
}

// ===== 代理处理器：CONNECT / 绝对形式；其余 404 =====
func newProxyHandler(cfg config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodConnect:
			handleConnect(w, r, cfg)
		case r.URL.IsAbs() && r.URL.Host != "":
			handleAbsolute(w, r, cfg)
		default:
			http.NotFound(w, r) // 代理端口不对外提供站点内容
		}
	})
}

// authOK：未开启鉴权时直接放行（默认）；开启时校验 Basic。
func authOK(r *http.Request, cfg config) bool {
	if !cfg.authEnabled {
		return true // 免鉴权模式：靠保密端口隐蔽
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
	return subtle.ConstantTimeCompare([]byte(user), []byte(cfg.authUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(pass), []byte(cfg.authPass)) == 1
}

func challenge407(w http.ResponseWriter) {
	w.Header().Set("Proxy-Authenticate", `Basic realm="FlowBrowse"`)
	w.WriteHeader(http.StatusProxyAuthRequired)
}

// ===== CONNECT 隧道：（可选鉴权）→拨号→回 200→双向裸拷贝 =====
func handleConnect(w http.ResponseWriter, r *http.Request, cfg config) {
	if !authOK(r, cfg) {
		challenge407(w)
		return
	}
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
func handleAbsolute(w http.ResponseWriter, r *http.Request, cfg config) {
	if !authOK(r, cfg) {
		challenge407(w)
		return
	}
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
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

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

// ===== WebTransport（UDP443）=====
func runWebTransport(cfg config, wtTLS *tls.Config) error {
	mux := http.NewServeMux()
	h3Server := &http3.Server{
		Addr:      cfg.wtAddr,
		TLSConfig: http3.ConfigureTLSConfig(wtTLS),
		QUICConfig: &quic.Config{
			EnableDatagrams:                  true,
			EnableStreamResetPartialDelivery: true, // webtransport-go v0.13 必需，否则 Chrome "Opening handshake failed"
			MaxIdleTimeout:                   30 * time.Second,
		},
	}
	webtransport.ConfigureHTTP3Server(h3Server)
	server := webtransport.Server{H3: h3Server, CheckOrigin: allowOrigin()}

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
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, strings.NewReader(`{"status":"ok","service":"flowbrowse"}`))
	})
	h3Server.Handler = mux

	log.Printf("[FlowBrowse] WebTransport 监听 UDP %s", cfg.wtAddr)
	return server.ListenAndServe()
}

func allowOrigin() func(*http.Request) bool {
	allowed := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("FB_ALLOW_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return func(r *http.Request) bool {
		if len(allowed) == 0 {
			return true // 未配置则放行（联调期）
		}
		return allowed[r.Header.Get("Origin")]
	}
}

func datagramEcho(sess *webtransport.Session, remote string) {
	ctx := sess.Context()
	for {
		data, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		if err := sess.SendDatagram(data); err != nil {
			return
		}
	}
}

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
				if rerr != nil {
					return
				}
			}
		}(str)
	}
}
