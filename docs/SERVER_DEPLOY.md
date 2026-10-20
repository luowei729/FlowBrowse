# SERVER_DEPLOY.md — FlowBrowse 服务端部署手册（单一 Go 服务）

## 0. 前置

- 服务器：Ubuntu 22.04/24.04（测试机 `<服务器公网IP>`），amd64 或 arm64
- 域名（如 `<你的域名>`）已解析到服务器公网 IP
- 放行端口：**仅需 TCP 80(ACME) 与 TCP 443（代理+订阅+首页复用）**。已放弃 QUIC，无需再放行 UDP 443。
- 代理与订阅共用 TCP 443：服务端按请求形态分流（CONNECT=代理、GET=订阅/首页），对外像一个正常 HTTPS 网站。

## 1. 二进制来源：GitHub Actions 预编译（服务器不编译）

推代码到 GitHub → 打 `v*` tag 触发 `.github/workflows/build.yml` → 交叉编译 `flowbrowse-server-linux-{amd64,arm64}` 并发布 Release。
`install.sh` 默认 `FB_BIN_MODE=prebuilt` 直接从 `https://github.com/<FB_REPO>/releases/latest/download/` 按架构下载。
（如不便用 Actions，可设 `FB_BIN_MODE=build` 让服务器本地编译，会临时装 Go。）

## 2. 一键安装

```bash
# 上传 server/ 到服务器后：
sudo bash flowbrowse.sh install      # 或 sudo bash install.sh
# 配置在 /etc/flowbrowse/.env；口令/NODE_TOKEN/FB_SUB_FILE 占位时自动生成随机值
```
`flowbrowse.sh`（无参数进菜单，或带子命令 install/uninstall/status/restart/sub/renew/logs/info）为统一入口。

安装会：装 systemd 单元 `flowbrowse.service`、设 UDP 缓冲区 sysctl、创建 `flowbrowse` 用户与 `/opt/flowbrowse /var/lib/flowbrowse /srv/flowbrowse`、生成订阅文件并打印订阅地址与 `fb://` 链接。

## 3. 证书（autocert 自动）

服务端程序内用 `golang.org/x/crypto/acme/autocert`（HTTP-01，走 80 端口）自动申请并续期 Let's Encrypt，缓存于 `FB_CERT_CACHE`（默认 `/var/lib/flowbrowse/certcache`）。**无需 Caddy/certbot。**

## 4. 域名未生效的失败提示

若域名未解析，autocert 无法签发证书。`install.sh` 预检并中文提示：
> [FlowBrowse][警告] 域名未生效：<域名> 无法解析。autocert 申请证书会失败。请将域名 A 记录指向本机后重跑。
服务 `Restart=always` 会受控重试；DNS 生效后 `flowbrowse.sh renew` 或 `systemctl restart flowbrowse`。

## 5. 验证

```bash
bash status.sh                                   # 服务/端口/证书/首页/订阅/健康
curl -o /dev/null -w '%{http_code}\n' https://<域名>/            # 期望 200 空body(防指纹)
curl '<订阅URL>' -o /dev/null -w '%{http_code}\n'              # 先拉一次订阅，把本机 IP 登记进白名单
curl -x https://<域名>:443 -o /dev/null -w '%{http_code}\n' https://www.example.com   # 期望 2xx(白名单已放行本机 IP)
```

## 5.1 自定义 IP 白名单 / 端口转发接入

需经**另一台服务器 iptables 端口转发**接入（入口 IP 与证书域名不对应）：把域名 A 记录指到中转机、中转机透传 TCP 443(+80) 到源站，证书按域名(SNI)校验、TLS 端到端仍在源站。完整步骤与命令见 **`docs/PORT_FORWARDING.md`**。

转发后源站看到的来源是**中转机出口 IP**，用以下任一方式放行（可叠加）：
- **静态**（写死、永久）：`.env` 里 `FB_PROXY_ALLOW_STATIC=<中转机IP或CIDR>`（逗号分隔），`systemctl restart flowbrowse`。
- **动态上报**（带管理密钥）：`curl "https://<域名>/<FB_ADMIN_TOKEN>/allow?add=auto"`（或 `?add=<IP|CIDR>&ttl=小时` / `?list=1` / `?del=<IP>`）。`FB_ADMIN_TOKEN` 由 install 自动生成，**机密勿泄**，留空=禁用。
- 二者均需 `FB_PROXY_ALLOW=on`（白名单开启）才起作用。

## 6. 卸载

```bash
sudo bash flowbrowse.sh uninstall       # 保留配置/证书；菜单会询问是否 --purge
```

## 7. 安全

- 真实口令/token 只在服务器 `/etc/flowbrowse/.env`（600），不入仓库/记忆/日志。
- 代理强制 BasicAuth，未授权一律 407，端口不表现为开放代理（也抵御扫描探测）。
- 订阅走"密钥目录/随机文件名"，未知路径 404，整条 URL 不可猜以防嗅探/枚举。
