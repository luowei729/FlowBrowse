# ARCHITECTURE.md — FlowBrowse 架构设计

## 1. 总览：路线 3 混合双通道

```
                         ┌───────────────────────── 远程服务器 (sel2.lkz.pub / 193.123.230.166) ─────────────────────────┐
                         │                                                                                              │
  Chrome 扩展 (MV3)      │   flowbrowse-server (TCP 443)         同进程 WebTransport (UDP 443)                        │
 ┌────────────────┐      │  ┌───────────────────────            ┌──────────────────────────┐                         │
 │ 标签页全部流量  │──────┼─▶│ ① 普通访问 / → 空200(复刻Caddy) │  ③ /wt  WebTransport 会话 │  真 QUIC / h3          │
 │ (chrome.proxy) │ TCP  │  │ ② CONNECT/绝对形式 → HTTPS 转发代理│     probe / session 流     │  (测速/信令/加速)      │
 └────────────────┘  443 │  └───────────────────────            │  /<token>/<随机名> 订阅      │                        │
        ▲                │        │  BasicAuth 鉴权             └──────────────────────────┘                        │
        │  ② 主干通道     │        │                                 ▲ ③ QUIC 通道(offscreen WebTransport)          │
        │  全量接管+分流  │   Let's Encrypt 证书 (程序内 autocert 自动签发/续期)  │                                       │
 ┌──────┴───────┐        │        │                                 │                                              │
 │ popup/options│        │   订阅地址: fb://USER:PASS@sel2.lkz.pub:443/?udp=443&region=&name=                       │
 │ offscreen(WT)│        └─────────────────────────────────────────────────────────────────────────────────────┘
 └──────────────┘
```

## 2. 通道职责

### 主干通道（全量接管，TCP）
- 扩展用 `chrome.proxy.settings.set` 配置 PAC 脚本，把"非中国"流量指向 `<域名>:<FB_PROXY_PORT>` 的 HTTPS 转发代理（单一 Go 服务，ALPN=http/1.1，Chrome 原生兼容）。
- **代理默认免鉴权 + 保密端口**：Chrome 对 https 代理 CONNECT 不支持扩展自动注入 BasicAuth（会弹框），故代理走非常规端口 `FB_PROXY_PORT`、不鉴权（靠端口隐蔽）；站点与订阅在 443（对外像正常网站）。服务端对 CONNECT/绝对形式做转发；根路径返回空 200（逐字节等同未配置的 Caddy 默认，防指纹），订阅走密钥路径静态文件。
- 覆盖 http/https/ftp/wss。**这一跳是 TCP+TLS，不是 QUIC**——这是 Chrome 平台的硬约束。

### QUIC 通道（应用层，UDP/h3）
- offscreen 文档用 `new WebTransport('https://sel2.lkz.pub:443/wt')` 建立真 QUIC/h3 会话。
- 用途：节点 RTT 测速、健康探测、控制信令；Phase 7 做白名单域名的 h3 加速（stretch）。
- **不做全量接管**：浏览器无法把标签页流量透明灌进 WebTransport 会话。

## 3. 分流（PAC）

- `rules.js` 读取内置 `rules/cn-domains.txt`（中国域名后缀）与 `rules/cn-ip-cidr.txt`（中国 IP CIDR）。
- 生成 PAC `FindProxyForURL`：命中 CN 域名/IP → `DIRECT`；否则 → `PROXY sel2.lkz.pub:443`（即"HTTPS 代理"）。
- 模式：`关闭` / `全局（全部走代理）` / `智能分流（默认）`。

## 4. 订阅与节点

- `fb://<USER>:<PASS>@<domain>:<tcp_port>/?udp=<udp_port>&region=<地区>&name=<显示名>`
- 服务端 `<NODE_TOKEN>/<FB_SUB_FILE>` 静态返回 base64（`.json` 可选）；`subscription.js` 解析合并进节点列表。两者均随机/可自定义，整条 URL 不可猜以防嗅探。
- 详见 `docs/RULES_FORMAT.md`。

## 5. 边界验证（Phase 0 结论，2026-10-19）

| 命题 | 结论 | 依据 |
|---|---|---|
| `chrome.proxy` 支持 QUIC 代理隧道 | ❌ 不可用 | 官方 Scheme 枚举含 `quic` 但默认端口表无它；Chrome 仅在"直连源站"经 Alt-Svc 用 QUIC，代理通道不支持 QUIC 隧道 |
| WebTransport 可在扩展中用 | ✅ 可用（走 offscreen） | MDN/W3C：需安全上下文 + `https://` URL，可在 Web Worker；`chrome-extension://` 为可信源，offscreen 为完整 DOM |
| `chrome.sockets.udp/tcp` 可建自定义 QUIC | ❌ 不可用 | MV3 已移除该 API |
| 全量接管 + 全程 QUIC 可兼得 | ❌ 物理不可 | 见上；故采用混合双通道 |

## 6. 模块与功能域（不得擅改划分）

- `extension/lib/`：config / rules / proxy-manager / auth / node-manager / subscription / probe —— 各管一职。
- `extension/background/service-worker.js`：编排、状态持久化与重建、alarms 周期探测、维持 offscreen。
- `extension/offscreen/`：WebTransport 宿主。
- `server/`：`flowbrowse/`(单一 Go 主程序:代理+站点+订阅+WebTransport+autocert)、`install/uninstall/status/flowbrowse.sh`、`scripts/gen-sub-link`、`systemd/flowbrowse.service`、`config/.env.example`。（已移除 Caddy/NaiveProxy 依赖。）
