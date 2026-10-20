# DEPLOY_CREDENTIALS.md — FlowBrowse 部署信息（仅非敏感项）

> ⚠️ 安全红线：本文件**绝不记录任何真实口令/私钥**。密码由运维现场提供，不入库、不入记忆。
> 这里只登记主机、域名、端口、路径、凭据项名称等非敏感信息，方便部署时对照。北京时间 / 2026-10-19。

## 测试环境

| 项 | 值 | 备注 |
|---|---|---|
| 主机 IP | `<服务器公网IP>` | Ubuntu 24.04 |
| SSH 用户 | `root` | 登录口令：现场提供，**不入库** |
| 域名 | `<你的域名>` | 已解析到该主机 |
| 站点证书 | Let's Encrypt | 由服务内 autocert 自动签发/续期（HTTP-01） |
| 代理+订阅+首页 | TCP 443 | 单一 Go 服务复用（CONNECT=代理、GET=订阅/首页） |
| 访问控制 | 自动 IP 白名单 | 拉到有效订阅 URL 的客户端 IP 自动放行（TTL 30天） |
| HTTP-01 需放行 | TCP 80 | 证书签发用；不可达则改 DNS-01 |

> 已放弃 QUIC/WebTransport，**不再需要 UDP 443**；也不再有 2096/62096 等额外代理端口。

## 需要准备的凭据项（值均为占位符，运行时注入 .env）

- `DOMAIN` = `<你的域名>`
- `NODE_NAME` = 节点显示名（例：`FlowBrowse-SG`）
- `AUTH_USER` / `AUTH_PASS` = 可选 Basic 凭据（默认 `FB_PROXY_AUTH=off` 不用；访问控制靠 IP 白名单）
- `NODE_TOKEN` = 订阅接口访问 token（密钥路径段，兼作白名单凭证；占位符，勿提交真实值）
- `FB_PROXY_ALLOW` = IP 白名单开关（默认 on）；`FB_PROXY_ALLOW_TTL_HOURS` = 放行时长（默认 720）

真实值写入服务器上的 `/etc/flowbrowse/.env`（已被 `.gitignore` 忽略），仓库内只保留 `server/config/.env.example`。

## 部署一句话流程（详见 docs/SERVER_DEPLOY.md）

上传 `server/` → 编辑 `.env` → `bash install.sh` → 复制脚本打印的订阅地址 → 插件"订阅管理"粘贴导入 → popup 一键连接。
