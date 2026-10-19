# SERVER_DEPLOY.md — FlowBrowse 服务端部署手册

## 0. 前置

- 服务器：Ubuntu 24.04（测试机 `193.123.230.166`）
- 域名 `sel2.lkz.pub` 已解析到服务器公网 IP
- 放行端口：TCP 80（HTTP-01 证书）、TCP 443（Caddy）、UDP 443（WebTransport）

## 1. 一键安装

```bash
# 上传 server/ 到服务器后：
cd server
cp config/.env.example /etc/flowbrowse/.env   # 或由 install.sh 自动创建
vim /etc/flowbrowse/.env                        # 填 DOMAIN / AUTH_USER / AUTH_PASS / NODE_TOKEN / NODE_NAME
sudo bash install.sh
```

`install.sh` 会：
1. 安装/放置 Caddy 与 WebTransport 二进制到 `/opt/flowbrowse/bin`。
2. 写配置到 `/etc/flowbrowse`，生成 systemd 单元并开机自启。
3. 通过 Caddy automatic HTTPS 申请 Let's Encrypt 证书。
4. 结束时打印：订阅地址 + `fb://` 单节点链接 + `NODE_TOKEN`。

## 2. 域名未生效的失败提示

若 `sel2.lkz.pub` 未解析/解析未生效，Caddy 申请证书会失败。脚本与 `journalctl -u flowbrowse-caddy` 会输出中文提示：

> [FlowBrowse] 域名未生效，证书申请失败，请将域名 A 记录指向本机后重跑 install.sh

服务会以受控方式重试；DNS 生效后可重新 `bash install.sh` 或 `systemctl restart flowbrowse-caddy`。

## 3. 验证

```bash
bash status.sh                                   # 汇总服务状态与证书
curl -I https://sel2.lkz.pub                     # 应 200 且空 body（与原生 Caddy 默认行为一致，无自定义页）
curl --http3 -I https://sel2.lkz.pub             # 支持 http3 的 curl 验证 h3
curl 'https://sel2.lkz.pub/<NODE_TOKEN>/<FB_SUB_FILE>'   # 返回 base64 订阅（密钥目录/随机文件名）
```

## 4. 证书自动续期

Caddy automatic HTTPS 内置 ACME 自动续期，无需 cron。确保证书目录持久、80 端口可被 LE 访问即可。

## 5. 卸载

```bash
sudo bash uninstall.sh
```

## 6. 安全

- 真实口令只存在于 `/etc/flowbrowse/.env`（权限 600），不入仓库、不入记忆、不入日志。
- 转发代理强制 BasicAuth，避免开放代理滥用。
- 建议后续为 `/_flowbrowse/*` 接口配 fail2ban / 速率限制。
