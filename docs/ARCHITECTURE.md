# ARCHITECTURE.md — FlowBrowse 架构设计

> 版本说明：v0.4.0 起**放弃 QUIC/WebTransport 通道**，回归**单一 TCP 443**（代理与订阅复用）。
> 原因见 `docs/THREAT_MODEL.md` 与 `DEVTIPS.md` 第 5 节：Chrome 不能把浏览器通用流量交给 UDP/QUIC，
> 且 HTTPS 代理无法用扩展自动注入密码（弹框）。故主干 = TCP 代理，访问控制 = 自动 IP 白名单。

## 1. 总览：单端口 TCP 443 + IP 白名单

```
                         ┌──────────────── 远程服务器 (<你的域名> / <服务器公网IP>) ────────────────┐
  Chrome 扩展 (MV3)      │   flowbrowse-server（单一 Go 进程）                                          │
 ┌────────────────      │                                                                             │
 │ 标签页全部流量  │ TCP  │   TCP 443（TLS, ALPN http/1.1，一个监听按请求形态复用）：                    │
 │ (chrome.proxy) │ 443  │     ① CONNECT/绝对形式  → HTTPS 转发代理（先查 IP 白名单，不在则 403）      │
 └────────────────┘      │     ② GET /<token>/<随机名> → 订阅文件（命中即把客户端 IP 加入白名单）       │
        ▲                │     ③ GET /            → 空 200（无指纹，等同未配置的 Caddy 默认）          │
        │ 主干：全量接管  │   TCP 80 → autocert HTTP-01（Let's Encrypt 自动签发/续期）                  │
        │ +国内外分流     │   订阅: fb://USER:PASS@<你的域名>:443/?region=&name=                      │
 ┌─────────────┐        ─────────────────────────────────────────────────────────────────────┘
 │ popup/options│
 └──────────────┘
```

## 2. 访问控制：自动 IP 白名单（替代密码）

- **为什么不用密码**：Chrome 对 HTTPS(TLS) 代理的 CONNECT 不支持扩展自动注入 BasicAuth——`onAuthRequired` 即便返回正确凭据，Chrome 仍报 `ERR_INVALID_AUTH_CREDENTIALS`（实测坐实）。免弹框 + 私密二者不可兼得于"密码"。
- **白名单机制**：只有成功拉到有效订阅 URL（含密钥路径，本身就是凭证）的客户端 IP，才被服务端记入白名单并放行其 CONNECT。TTL 默认 30 天，持久化到 `/var/lib/flowbrowse/allowlist.json`。
- **换 IP**：家庭宽带 IP 变动后，在扩展里"刷新订阅"即可重新登记新 IP。
- 配置：`FB_PROXY_ALLOW=on`（默认）、`FB_PROXY_ALLOW_TTL_HOURS=720`。`FB_PROXY_AUTH=on` 为可选叠加 Basic（会弹框，默认 off）。

## 3. 主干通道（全量接管，TCP）

- 扩展用 `chrome.proxy.settings.set` 配置 PAC，把"非中国"流量指向 `<域名>:443` 的 HTTPS 转发代理（单一 Go，ALPN=http/1.1，Chrome 原生兼容）。
- 服务端对 CONNECT 做双向裸拷贝隧道、对绝对形式做转发；根路径空 200 防指纹；订阅走密钥路径静态文件。
- **这一跳是 TCP+TLS，不是 QUIC**——CONNECT 目标与内容都在 TLS 内，对中间网络隐藏。

## 4. 分流（PAC）

- `rules.js` 读取内置 `rules/cn-domains.txt`（中国域名后缀，已含字节跳动/抖音等生态）与 `rules/cn-ip-cidr.txt`（全量 CN IPv4 段 6527 条）。
- 生成 PAC `FindProxyForURL`：命中 CN 域名/IP → `DIRECT`；否则 → `HTTPS <域名>:443`。IP 段在生成时**预计算为 [base,mask] 数值对**，请求时仅整数比较，保证性能。
- 可选远程更新（`FB_PROXY_*` 规则 URL，解析兼容纯文本/Clash YAML/DOMAIN-SUFFIX）。
- 模式：`关闭` / `全局（全部走代理）` / `智能分流（默认）`。

## 5. 订阅与节点

- `fb://<USER>:<PASS>@<domain>:<tcp_port>/?region=<地区>&name=<显示名>`（代理端口=站点端口=443）。
- 服务端 `<NODE_TOKEN>/<FB_SUB_FILE>` 静态返回 base64（`.json` 可选）；`subscription.js` 解析合并进节点列表。token 与文件名均随机/可自定义，整条 URL 不可猜以防嗅探。
- 详见 `docs/RULES_FORMAT.md`。

## 6. 边界验证（Phase 0 结论，2026-10-19）

| 命题 | 结论 | 依据 |
|---|---|---|
| `chrome.proxy` 支持 QUIC 代理隧道 | ❌ 不可用 | 官方枚举含 `quic` 但代理通道不支持 QUIC 隧道；Chrome 仅"直连源站"经 Alt-Svc 用 QUIC |
| WebTransport 可在扩展中用 | ⚠️ 能建会话但**不能接管流量** | offscreen 可建 h3 会话，但只承载扩展自身 fetch，无法灌入标签页通用流量 |
| HTTPS 代理扩展自动注入 BasicAuth | ❌ 不可用 | `onAuthRequired` 返回正确凭据仍 `ERR_INVALID_AUTH_CREDENTIALS`（v0.4.0 实测） |
| `chrome.sockets.udp/tcp` 建自定义 QUIC | ❌ 不可用 | MV3 已移除 |
| 全量接管 + 全程 QUIC 可兼得 | ❌ 物理不可 | 故最终采用 TCP 主干 + IP 白名单 |

## 7. 模块与功能域（不得擅改划分）

- `extension/lib/`：config / rules / proxy-manager / auth / node-manager / subscription / probe —— 各管一职。
- `extension/background/service-worker.js`：编排、状态持久化与重建、alarms 周期探测、工具栏角标(ON/OFF)、连接期 keepalive。
- `server/flowbrowse/`：单一 Go 主程序（TCP 443 复用：代理+订阅+首页+IP白名单；TCP 80 autocert）。已移除 Caddy/NaiveProxy/WebTransport 依赖。
- `server/`：`install/uninstall/status/flowbrowse.sh`、`scripts/gen-sub-link`、`systemd/flowbrowse.service`、`config/.env.example`。
