# DEVTIPS.md — FlowBrowse 开发与调试技巧

> 记录开发/调试/排查经验，便于快速定位问题。北京时间 / 2026-10-19 初始化。

## 1. 关键坑位备忘

- **MV3 无持久后台**：Service Worker 空闲约 30s 休眠，内存态会丢。任何需要跨事件保存的状态（当前节点、连接模式、凭据引用）必须写 `chrome.storage`，唤醒即重建。
- **WebTransport 只能在 offscreen/普通扩展页面用**：SW 里用不稳。用 `chrome.offscreen` 建一个 DOM 文档承载 WT 会话，SW 通过 `chrome.runtime` 消息与它通信。
- **WebTransport URL 必须是 `https://`**：非 https 构造会抛 `SyntaxError`；带 `#fragment` 也会抛错，节点显示名不要塞进 WT URL。
- **代理鉴权**：MV3 用 `chrome.webRequest.onAuthRequired` 返回 `{authCredentials}`（异步回调），不要用已废弃的 blocking 模式。
- **单一 Go 服务多用途**：一个进程同时监听 TCP443(转发代理+首页+订阅)、UDP443(WebTransport)、TCP80(ACME)；靠请求形态区分（CONNECT/绝对形式=代理；origin 形式 GET=站点/订阅）。
- **代理监听强制 ALPN=http/1.1**：Chrome https 代理走 HTTP/1.1 CONNECT；不用 h2 CONNECT 以免兼容坑（NaiveProxy fork 正是此病）。
- **Caddy/NaiveProxy 不可用教训**：klzgrad/forwardproxy 与 Chrome 原生 https 代理不兼容（CONNECT-over-TLS 隧道重置 + 拦截全站 407），故改自实现标准代理。
- **WebTransport 需 UDP 大缓冲区**：quic-go 会告警接收缓冲不足；install.sh 已写 `/etc/sysctl.d/99-flowbrowse.conf`(rmem/wmem_max)。**沙箱/弱网下出站 UDP/443 可能受限**，表现为 "Opening handshake failed" 且服务端无会话日志——属环境非代码，需在正常网络真实 Chrome 复核。

## 2. 本地调试

- 扩展：`chrome://extensions` → 开发者模式 → 加载已解压的 `extension/`。SW 报错点"服务工作进程"链接看专属 DevTools；WT 相关看 offscreen 文档的 DevTools。
- 验证代理是否生效：DevTools Network → Protocol 列；或 `chrome://net-export`。
- 验证证书与站点：浏览器访问 `https://<域名>` 应返回 200 且空 body（程序根路径 `WriteHeader(200)`）且证书由 autocert 有效。
- 验证代理：`curl -x https://<域名>:443 --proxy-user U:P -o /dev/null -w '%{http_code}\n' https://www.example.com` 期望 2xx；不带凭据应 407。
- 验证订阅：`curl 'https://<域名>/<NODE_TOKEN>/<FB_SUB_FILE>'` 看 base64；`/<FB_SUB_FILE>.json` 看结构化（token 为密钥目录、文件名为随机段）；错 token 应 404。

## 3. 无头浏览器（本代理可用于联调）

- 阶段联调时可启动无头浏览器访问页面，验证扩展 UI 与站点可达性；服务端部署用 SSH 到 `<服务器公网IP>`（口令由用户现场提供，绝不入库）。

## 4. 排查顺序模板

连不上时依次查：证书有效性 → DNS 是否解析到本机 → 防火墙 80/443(tcp)/443(udp) → `systemctl status flowbrowse` 与 `journalctl -u flowbrowse` → 订阅 token → 扩展 代理鉴权凭据 → GFW 侧 UDP 443 是否被限速/干扰（参见 docs/THREAT_MODEL.md）。

## 5. Chrome 代理鉴权硬限制（重要，多次实测坐实）

- **HTTPS(TLS) 代理无法用扩展自动注入 BasicAuth**：`chrome.webRequest.onAuthRequired` 对代理 CONNECT 会触发（`isProxy=true`）、即使返回完全正确的 `{authCredentials}`，Chrome 仍报 `ERR_INVALID_AUTH_CREDENTIALS`。无头/有头一致。curl 用同凭据能过 → 确认是 **Chrome 端限制**，非服务端/代码 bug。
- 因此：要“私密（TLS）+免弹框”就不能靠密码；Zero Omega 能填用户名是因为它常走 **HTTP 明文代理**（CONNECT 与目标会被网络看到，对翻墙不利）。
- **正解：自动 IP 白名单**。拉到含密钥订阅 URL 即视为已认证，服务端记下该客户端 IP 并放行其 CONNECT（TTL 30天、存 `/var/lib/flowbrowse/allowlist.json`）。换 IP 后需重拉/刷新一次订阅。
- **代理必须走 TCP**：`chrome.proxy` 不支持把流量交给 UDP/QUIC；WebTransport 只能承载扩展自身 fetch，接管不了标签页通用流量。故已放弃 QUIC 主干，单端口 TCP 443（CONNECT=代理、GET=订阅/首页）。
