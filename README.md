# FlowBrowse

无需本地客户端的 Chrome 浏览器网络代理扩展（Manifest V3）。优先落地 HTTP/3、QUIC 与 WebTransport，提供节点管理、订阅导入、国内外规则分流与一键连接。

- 域名：`sel2.lkz.pub` ｜ 测试服务器：`193.123.230.166`
- 默认端口：UDP 443（WebTransport）/ TCP 443（Caddy HTTPS 转发代理），均可自定义

## 架构一句话

主干用 `chrome.proxy` → 远程 Caddy HTTPS 转发代理实现"零客户端 + 全量接管 + 国内外分流"；同时用 WebTransport(h3/QUIC/UDP443) 作为真实 QUIC 通道做节点测速/信令/实验性加速。**"全量接管"与"全程 QUIC"在 Chrome 平台不可兼得**，故采用混合双通道。

## 目录

- `server/` 远程服务端：Caddy + Go WebTransport + 一键安装脚本 + 订阅接口
- `extension/` Chrome MV3 扩展
- `docs/` 架构 / 威胁模型 / 规则格式 / 部署手册
- `AGENTS.md` `PROJECT_PLAN.md` `CHANGELOG.md` `DEVTIPS.md` `DEPLOY_CREDENTIALS.md` 开发协作与记录

## 快速开始

- 部署服务端：见 `docs/SERVER_DEPLOY.md`
- 加载扩展：`chrome://extensions` → 开发者模式 → 加载已解压的 `extension/`
- 重要边界与合规：先读 `AGENTS.md` 与 `docs/THREAT_MODEL.md`
