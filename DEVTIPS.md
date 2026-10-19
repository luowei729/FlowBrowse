# DEVTIPS.md — FlowBrowse 开发与调试技巧

> 记录开发/调试/排查经验，便于快速定位问题。北京时间 / 2026-10-19 初始化。

## 1. 关键坑位备忘

- **MV3 无持久后台**：Service Worker 空闲约 30s 休眠，内存态会丢。任何需要跨事件保存的状态（当前节点、连接模式、凭据引用）必须写 `chrome.storage`，唤醒即重建。
- **WebTransport 只能在 offscreen/普通扩展页面用**：SW 里用不稳。用 `chrome.offscreen` 建一个 DOM 文档承载 WT 会话，SW 通过 `chrome.runtime` 消息与它通信。
- **WebTransport URL 必须是 `https://`**：非 https 构造会抛 `SyntaxError`；带 `#fragment` 也会抛错，节点显示名不要塞进 WT URL。
- **代理鉴权**：MV3 用 `chrome.webRequest.onAuthRequired` 返回 `{authCredentials}`（异步回调），不要用已废弃的 blocking 模式。
- **Caddy 单端口三用**：转发代理、普通站点、`/_flowbrowse/*` 接口共用 TCP 443，靠请求形式区分（CONNECT/绝对形式=代理；origin 形式=站点/接口）。
- **h3/QUIC 必须同端口 TCP+UDP**：WebTransport 服务监听 UDP 443，Caddy 监听 TCP 443，端口号可相同（传输层不同）。

## 2. 本地调试

- 扩展：`chrome://extensions` → 开发者模式 → 加载已解压的 `extension/`。SW 报错点"服务工作进程"链接看专属 DevTools；WT 相关看 offscreen 文档的 DevTools。
- 验证代理是否生效：DevTools Network → Protocol 列；或 `chrome://net-export`。
- 验证证书与站点：浏览器访问 `https://sel2.lkz.pub` 应返回 200 且空 body（与原生 Caddy 默认一致）且证书有效。
- 验证 h3：`curl --http3 -I https://sel2.lkz.pub`（需支持 http3 的 curl）。
- 验证订阅：`curl 'https://<domain>/<NODE_TOKEN>/<FB_SUB_FILE>'` 看 base64；`/<FB_SUB_FILE>.json` 看结构化（token 为密钥目录、文件名为随机段）。

## 3. 无头浏览器（本代理可用于联调）

- 阶段联调时可启动无头浏览器访问页面，验证扩展 UI 与站点可达性；服务端部署用 SSH 到 `193.123.230.166`（口令由用户现场提供，绝不入库）。

## 4. 排查顺序模板

连不上时依次查：证书有效性 → DNS 是否解析到本机 → 防火墙 80/443(tcp)/443(udp) → Caddy/WT 服务状态 → 订阅 token → 扩展代理鉴权凭据 → GFW 侧 UDP 443 是否被限速/干扰（参见 docs/THREAT_MODEL.md）。
