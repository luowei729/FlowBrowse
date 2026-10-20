# FlowBrowse

无需本地客户端的 Chrome 浏览器网络代理扩展（Manifest V3）。提供节点管理、订阅导入、国内外规则分流与一键连接。（早期探索过 QUIC/WebTransport，因 Chrome 平台硬限制已收敛为单端口 TCP 代理，详见下。）

- 域名：`<你的域名>` ｜ 测试服务器：`<服务器公网IP>`
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

## 安装（一键）

### 1）服务端（Ubuntu 22.04/24.04，root）

> 自动从 GitHub Releases 下载预编译二进制（amd64/arm64，不在服务器编译）、装 systemd、autocert 自动申请证书、生成订阅地址。

```bash
git clone https://github.com/luowei729/FlowBrowse.git && cd FlowBrowse/server
sudo bash flowbrowse.sh install
```

装完会打印一个订阅地址（形如 `https://<域名>/<令牌>/<随机名>`），复制它到浏览器扩展导入。

常用管理（`flowbrowse.sh` 不带参数进交互菜单）：

```bash
sudo bash flowbrowse.sh status      # 服务/端口/证书/首页/订阅健康
sudo bash flowbrowse.sh sub         # 重新生成并打印订阅地址
sudo bash flowbrowse.sh restart     # 重启
sudo bash flowbrowse.sh logs        # 看日志
sudo bash flowbrowse.sh renew       # 手动触发证书续期
sudo bash flowbrowse.sh uninstall   # 卸载
```

首次需在域名服务商把域名 A 记录解析到服务器公网 IP，并放行 **TCP 80 与 TCP 443**（已不需 UDP）。

### 2）浏览器扩展（Chrome / Edge，开发者模式加载）

```bash
git clone https://github.com/luowei729/FlowBrowse.git
```

1. 地址栏打开 `chrome://extensions` → 右上角开启“开发者模式”。
2. 点“加载已解压的扩展程序” → 选 `FlowBrowse/extension` 目录。
3. 点工具栏图标→齿轮打开设置 → “订阅” → 粘贴上面服务端打印的订阅地址 → “添加/更新订阅”。
4. 回到弹窗选“自动分流”（或某个节点）→ 工具栏图标变蓝即已连接。

> 更新：`cd FlowBrowse && git pull`，再到 `chrome://extensions` 点扩展的 ↻ 重新加载（服务端则 `cd FlowBrowse/server && sudo bash flowbrowse.sh install` 重跑即可升级）。

### 3）可选：自己编译服务端二进制（需 Go 1.26+）

```bash
cd FlowBrowse/server/flowbrowse && CGO_ENABLED=0 go build -o flowbrowse-server .
# 或直接推 v* tag 由 GitHub Actions 交叉编译 amd64/arm64 并发布 Release
```
