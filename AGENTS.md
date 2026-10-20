# AGENTS.md — FlowBrowse 开发协作规范

> 本文件是所有开发者（含 AI 代理）接手项目的第一入口。请先通读本文件与 `docs/` 下相关文档，再动手改代码。

## 1. 项目定位

FlowBrowse 是一个**无需本地客户端**的 Chrome 浏览器网络代理扩展（Manifest V3）。
核心思路：优先研究并落地 HTTP/3、QUIC 与 WebTransport，提供节点管理、订阅导入、国内外规则分流与一键连接。

- 域名：`<你的域名>`
- 测试服务器：`<服务器公网IP>`（Ubuntu 24.04）
- 端口：**仅 TCP 443**（代理+订阅+首页复用）+ TCP 80（证书 ACME）；已放弃 QUIC/UDP

## 2. 关键技术边界（务必牢记，防止过度承诺）

1. **浏览器扩展里"全量接管"与"全程 QUIC"不可兼得**：
   - `chrome.proxy` 的 `"quic"` scheme 是历史遗留枚举，现代 Chrome **不支持 QUIC 代理隧道**，主干只能走 TCP（`https`/`socks5`）远程代理。
   - WebTransport（真 QUIC/h3）是**应用层 API**，无法透明接管所有标签页流量；本项目已于 v0.4.0 **完全放弃 QUIC 通道**。
   - **HTTPS 代理无法由扩展自动注入密码**：`onAuthRequired` 返回正确凭据仍 `ERR_INVALID_AUTH_CREDENTIALS`（实测），故访问控制用 **自动 IP 白名单**。
   - 详见 `docs/ARCHITECTURE.md` 的"边界验证"小节。
2. **不实际运行 Hysteria2**：Chrome 无法原生连 hy2。仅借用其 `scheme://auth@host:port?query#name` 的链接/订阅**格式约定**，坚持零客户端。
3. **GFW 现实**：有效证书 + UDP 443 不保证穿透，仅降低指纹。详见 `docs/THREAT_MODEL.md`。
4. `chrome.sockets.udp/tcp` 在 MV3 **已移除**，不能作为实现路径。

## 3. 架构与目录约定

```
FlowBrowse/
├── AGENTS.md  CHANGELOG.md  DEPLOY_CREDENTIALS.md  DEVTIPS.md  PROJECT_PLAN.md  README.md
├── docs/                 # 细分设计文档（除根目录 5 个 md 外，其余 md 均放这里）：ARCHITECTURE/THREAT_MODEL/SERVER_DEPLOY/PORT_FORWARDING/RULES_FORMAT 等
├── server/               # 远程服务端：单一 Go 程序（代理+订阅+首页+IP白名单+autocert）+ 一键安装脚本
└── extension/            # Chrome MV3 扩展
```

功能域划分规则（不得擅改）：
- **服务端**：转发代理（主干，TCP 443）、订阅接口、首页防指纹、IP 白名单、证书、一键安装。
- **扩展**：`lib/`（配置、规则、代理管理、鉴权、节点、订阅、探测、白名单上报）、`background/`（编排+角标+keepalive）、`popup/`、`options/`（含 IP 白名单管理页）、`rules/`（分流数据）。
- 模块按功能区域解耦，禁止跨域随意耦合或把功能塞进错误的目录。

## 4. 编码规范

- **每一步都要中文注释**：说明"做了什么功能"和"为什么这么做"，方便后期排查与二次开发。
- 遵循 MV3 约束：Service Worker 无状态、随时休眠，关键状态一律持久化到 `chrome.storage`，唤醒时重建。
- 连接期间用轻量 keepalive 降低 SW 休眠，保证代理鉴权/探测及时响应（已无 offscreen/WebTransport）。
- 不在代码或仓库中硬编码任何密钥、token、口令；用占位符 + `.env`（已在 `.gitignore` 中忽略）。

## 5. 文档维护要求

- 每次改动按中文写入根目录 `CHANGELOG.md`、`DEVTIPS.md`、`DEPLOY_CREDENTIALS.md`（如涉及部署/凭据非敏感信息）、`PROJECT_PLAN.md`，记录**北京时间与日期**。
- 开发节奏：动手前给"改动前总结"，完成后给"改动后总结"。
- `DEPLOY_CREDENTIALS.md` 只记录主机、域名、端口、路径、token 名称等**非敏感**信息；**真实口令绝不入库**。

## 6. 交接与排查

- 部署/运行/调试步骤见 `DEVTIPS.md` 与 `docs/SERVER_DEPLOY.md`；经其他服务器端口转发接入见 `docs/PORT_FORWARDING.md`。
- 遇到协议/兼容性问题先查 `docs/ARCHITECTURE.md` 与 `docs/THREAT_MODEL.md`。
