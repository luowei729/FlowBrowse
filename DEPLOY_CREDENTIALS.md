# DEPLOY_CREDENTIALS.md — FlowBrowse 部署信息（仅非敏感项）

> ⚠️ 安全红线：本文件**绝不记录任何真实口令/私钥**。密码由运维现场提供，不入库、不入记忆。
> 这里只登记主机、域名、端口、路径、凭据项名称等非敏感信息，方便部署时对照。北京时间 / 2026-10-19。

## 测试环境

| 项 | 值 | 备注 |
|---|---|---|
| 主机 IP | `193.123.230.166` | Ubuntu 24.04 |
| SSH 用户 | `root` | 登录口令：现场提供，**不入库** |
| 域名 | `sel2.lkz.pub` | 已解析到该主机 |
| 站点证书 | Let's Encrypt | 由 Caddy automatic HTTPS 签发/续期 |
| 主干代理端口 | TCP 443 | Caddy HTTPS 转发代理 |
| WebTransport 端口 | UDP 443 | Go 服务（可自定义） |
| HTTP-01 需放行 | TCP 80 | 证书签发用；不可达则改 DNS-01 |

## 需要准备的凭据项（值均为占位符，运行时注入 .env）

- `DOMAIN` = `sel2.lkz.pub`
- `NODE_NAME` = 节点显示名（例：`FlowBrowse-SG`）
- `AUTH_USER` / `AUTH_PASS` = 代理 BasicAuth 凭据（占位符，勿提交真实值）
- `NODE_TOKEN` = 订阅接口访问 token（占位符，勿提交真实值）
- `WT_PORT` = WebTransport 端口，默认 `443`

真实值写入服务器上的 `/etc/flowbrowse/.env`（已被 `.gitignore` 忽略），仓库内只保留 `server/config/.env.example`。

## 部署一句话流程（详见 docs/SERVER_DEPLOY.md）

上传 `server/` → 编辑 `.env` → `bash install.sh` → 复制脚本打印的订阅地址 → 插件"订阅管理"粘贴导入 → popup 一键连接。
