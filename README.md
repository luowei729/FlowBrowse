# FlowBrowse

无需本地客户端的 Chrome 浏览器网络代理扩展（Manifest V3）。提供节点管理、订阅导入、国内外规则分流与一键连接。（早期探索过 QUIC/WebTransport，因 Chrome 平台硬限制已收敛为单端口 TCP 代理，详见下。）

- 域名：`sel2.lkz.pub` ｜ 测试服务器：`193.123.230.166`
- 端口：**仅 TCP 443**（代理+订阅+首页复用）+ TCP 80（证书 ACME）

## 架构一句话

主干用 `chrome.proxy` → 远程 **HTTPS 转发代理（单端口 TCP 443）** 实现"零客户端 + 全量接管 + 国内外分流"；访问控制用 **自动 IP 白名单**（拉到含密钥订阅 URL 的 IP 才放行）。

> 为何不用 QUIC/密码：Chrome 不能把浏览器通用流量交给 UDP/QUIC；且 HTTPS 代理无法由扩展自动注入密码（会弹框）。二者均为平台硬限制（实测坐实）。

## 目录

- `server/` 远程服务端：单一 Go 程序（代理+订阅+首页+IP白名单+autocert）+ 一键安装脚本
- `extension/` Chrome MV3 扩展
- `docs/` 架构 / 威胁模型 / 规则格式 / 部署手册
- `AGENTS.md` `PROJECT_PLAN.md` `CHANGELOG.md` `DEVTIPS.md` `DEPLOY_CREDENTIALS.md` 开发协作与记录

## 快速开始

- 部署服务端：见 `docs/SERVER_DEPLOY.md`
- 加载扩展：`chrome://extensions` → 开发者模式 → 加载已解压的 `extension/`
- 重要边界与合规：先读 `AGENTS.md` 与 `docs/THREAT_MODEL.md`
