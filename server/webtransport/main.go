// FlowBrowse WebTransport 服务
//
// 功能：在 UDP 端口（默认 443，可通过环境变量自定义）上提供基于 QUIC/HTTP3 的 WebTransport 端点，
//       供 Chrome 扩展的 offscreen 文档连接，用于节点 RTT 测速、健康探测与控制信令。
//
// 为什么这样做：Chrome 的 chrome.proxy 不支持 QUIC 隧道，主干接管只能走 TCP；
//       真正能"原生跑 QUIC"的浏览器 API 只有 WebTransport，因此单独起一个 h3 服务承担 QUIC 通道职责，
//       与主干 TCP 代理各司其职（混合双通道，见 docs/ARCHITECTURE.md）。
//
// 证书：复用与 Caddy 同一套 Let's Encrypt 证书（由 install.sh 通过 acme.sh 申请并写入 FB_CERT/FB_KEY），
//       浏览器对受信证书无需 serverCertificateHashes，握手更稳。
package main

import (
	"crypto/tls"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// envOrDefault 读取环境变量，缺省时返回默认值。
// 目的：域名、端口、证书路径全部可自定义，测试默认值不等于硬编码。
func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// ===== 可自定义的运行参数（域名仅测试用，全部来自环境变量）=====
	domain := envOrDefault("FB_DOMAIN", "sel2.lkz.pub")                 // 服务域名（用于日志/证书用途标识）
	addr := envOrDefault("FB_WT_ADDR", ":443")                          // WebTransport 监听地址，端口可自定义
	certFile := envOrDefault("FB_CERT", "/etc/flowbrowse/certs/"+domain+".crt") // 证书文件（acme.sh 签发）
	keyFile := envOrDefault("FB_KEY", "/etc/flowbrowse/certs/"+domain+".key")   // 私钥文件
	allowOrigins := envOrDefault("FB_ALLOW_ORIGINS", "")                // 允许的 Origin 白名单，逗号分隔；空=放行全部（测试用）

	// ===== 加载证书 =====
	// 证书缺失/未生效时打印中文提示，方便运维快速定位"域名未生效导致无法签发证书"的问题。
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Printf("[FlowBrowse-WT] 证书加载失败：%v。请确认域名 %s 已解析到本机且已由 install.sh 成功签发证书（路径 %s / %s）",
			err, domain, certFile, keyFile)
		// 不直接退出：交由 systemd 受控重启重试，避免首次签发与启动的竞态导致永久失败。
		time.Sleep(10 * time.Second)
		os.Exit(1)
	}

	// ===== 构造 HTTP/3 (QUIC) 服务器 =====
	// EnableDatagrams=true 是 WebTransport 数据报（不可靠低延迟通道）的前提。
	h3Server := &http3.Server{
		Addr:      addr,
		TLSConfig: http3.ConfigureTLSConfig(&tls.Config{Certificates: []tls.Certificate{cert}}),
		QUICConfig: &quic.Config{
			EnableDatagrams: true, // 允许数据报，供 RTT 探测使用
			MaxIdleTimeout:  30 * time.Second,
		},
	}
	// ConfigureHTTP3Server 打开 WebTransport 所需的传输参数（enable_webtransport / h3 datagram）。
	webtransport.ConfigureHTTP3Server(h3Server)

	// ===== 构造 WebTransport 服务并挂到 h3 服务器 =====
	server := webtransport.Server{
		H3:          h3Server,
		CheckOrigin: makeOriginChecker(allowOrigins), // 浏览器扩展Origin校验
	}

	mux := http.NewServeMux()
	// /wt：WebTransport 会话升级入口（扩展连接 https://<domain>:<port>/wt）
	mux.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		handleSession(&server, w, r, domain)
	})
	// /healthz：普通 h3 GET 健康检查，便于 status.sh / 浏览器验证服务存活与证书有效
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"flowbrowse-webtransport"}`))
	})
	h3Server.Handler = mux

	log.Printf("[FlowBrowse-WT] WebTransport 监听 %s (域名 %s)，端点 /wt、/healthz", addr, domain)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[FlowBrowse-WT] 启动失败：%v", err)
	}
}

// makeOriginChecker 返回 Origin 校验函数。
// 为什么：WebTransport 会收到浏览器发来的 Origin 头；扩展的 Origin 形如 chrome-extension://<id>。
// allowOrigins 为空时放行全部并告警，仅便于测试；生产应配置白名单。
func makeOriginChecker(allowOrigins string) func(*http.Request) bool {
	allowed := map[string]bool{}
	for _, o := range strings.Split(allowOrigins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return func(r *http.Request) bool {
		if len(allowed) == 0 {
			log.Printf("[FlowBrowse-WT] 警告：未配置 FB_ALLOW_ORIGINS，已放行全部 Origin（仅测试用）：当前 Origin=%q", r.Header.Get("Origin"))
			return true
		}
		origin := r.Header.Get("Origin")
		ok := allowed[origin]
		if !ok {
			log.Printf("[FlowBrowse-WT] 拒绝未授权 Origin=%q", origin)
		}
		return ok
	}
}

// handleSession 处理一个 WebTransport 会话：升级后启动数据报回显与双向流回显协程。
// 用途：数据报回显让扩展发送一个带时间戳的数据报、原样收回即可测算 RTT；
//       双向流回显用于后续信令/加速功能的预留通道。
func handleSession(server *webtransport.Server, w http.ResponseWriter, r *http.Request, domain string) {
	sess, err := server.Upgrade(w, r)
	if err != nil {
		log.Printf("[FlowBrowse-WT] 会话升级失败(域名 %s)：%v", domain, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	remote := sess.RemoteAddr().String()
	log.Printf("[FlowBrowse-WT] 新会话来自 %s", remote)

	// 协程1：数据报回显（RTT 探测核心）
	go datagramEcho(sess, remote)

	// 协程2：双向流回显（信令/加速预留）
	go streamEcho(sess, remote)

	// 会话生命周期：直到客户端关闭或超时
	<-sess.Context().Done()
	log.Printf("[FlowBrowse-WT] 会话结束 %s：%v", remote, sess.Context().Err())
}

// datagramEcho 循环接收数据报并原样回发。
// 为什么原样回发：扩展写入 8 字节时间戳，收回后 now-时间戳 即 RTT，服务端无需解析内容。
func datagramEcho(sess *webtransport.Session, remote string) {
	ctx := sess.Context()
	for {
		data, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			// 会话关闭/超时属正常，静默退出协程
			return
		}
		if err := sess.SendDatagram(data); err != nil {
			log.Printf("[FlowBrowse-WT] 数据报回发失败 %s：%v", remote, err)
			return
		}
	}
}

// streamEcho 循环接受双向流并把数据原样回传（io.Copy）。
// 为什么用 io.Copy：webtransport.Stream 内嵌 QUIC 流，实现 io.Reader/io.Writer，可直接双向拷贝。
func streamEcho(sess *webtransport.Session, remote string) {
	ctx := sess.Context()
	for {
		str, err := sess.AcceptStream(ctx)
		if err != nil {
			return
		}
		go func(s *webtransport.Stream) {
			defer s.Close()
			if _, err := io.Copy(s, s); err != nil && !strings.Contains(err.Error(), "closed") && !strings.Contains(err.Error(), "canceled") {
				log.Printf("[FlowBrowse-WT] 流回显异常 %s：%v", remote, err)
			}
		}(str)
	}
}

