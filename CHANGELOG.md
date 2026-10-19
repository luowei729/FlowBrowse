# CHANGELOG.md — FlowBrowse 变更日志

> 按北京时间倒序记录每次改动。格式：日期 + 功能域 + 具体变更 + 原因。

## 2026-10-19（初始化与骨架搭建）

- 【文档】新建根目录 `AGENTS.md`、`PROJECT_PLAN.md`、`CHANGELOG.md`、`DEVTIPS.md`、`DEPLOY_CREDENTIALS.md`，以及 `docs/` 下的设计文档。原因：项目全新，先固化架构边界与协作规范，便于后续定位与二次开发。
- 【Phase 0】完成可行性边界验证：
  - 确认 `chrome.proxy` 的 `"quic"` scheme 为历史遗留、现代 Chrome 不支持 QUIC 代理隧道，主干改用 TCP `https` 转发代理。
  - 确认 WebTransport 需安全上下文 + HTTPS URL、可在 offscreen 文档稳定使用；`chrome.sockets.udp` 在 MV3 已移除，不作为实现路径。
- 【服务端-设计】确定 Caddy 单站点三用策略：普通访问返回 Caddy 默认提示页（保证域名可被正常浏览器访问、降低指纹可疑度）、`/_flowbrowse/*` 提供订阅与状态接口、CONNECT/绝对形式请求走转发代理。
- 【订阅-设计】确定 `fb://` 链接格式与 base64 订阅接口，坚持零客户端、不实际运行 Hysteria2。

## 2026-10-19（服务端与扩展实现完成 + 安全加固）

- 【服务端-WebTransport】`server/webtransport/main.go` 基于官方最新 API（http3.Server + webtransport.ConfigureHTTP3Server + Session）实现 /wt 数据报回显(RTT)与双向流回显；go.mod 用 `#` 注释；证书/端口/域名均走环境变量。
- 【服务端-Caddy】`server/caddy/Caddyfile` 采用 NaiveProxy 范式（forward_proxy + hide_ip/hide_via），`route` 内 `respond / "" 200` **复刻原生 Caddy 空 200 默认页**（经核实 Caddy 无自带欢迎页），杜绝自定义页指纹。
- 【安全-防嗅探】订阅改为"密钥目录 $NODE_TOKEN + 随机文件名 $FB_SUB_FILE"静态文件，二者均可随机或自定义；转发代理三层隐蔽（TLS 内密文 + basic_auth 407 + hide_ip/hide_via）+ 不启用 access log，详见 docs/THREAT_MODEL.md 2.5 节。
- 【服务端-脚本】install/uninstall/status.sh + gen-sub-link.sh + systemd（caddy/wt/reload timer）；`urlencode` 修正为 python3 按 UTF-8 字节编码（修复中文按码点产生非法 %XXXX 的缺陷）。
- 【扩展】完成 MV3 全量：manifest、lib(config/rules/proxy-manager/auth/node-manager/subscription/probe)、service-worker、offscreen、popup、options、内置 CN 规则。主干 PAC 用 `HTTPS host:port` 保证 TLS；订阅/节点支持多订阅多节点的增删改、刷新、手动选节点、端口自定义。
- 【验证】所有扩展 JS 通过 node ESM 语法校验；manifest JSON 合法；生成的 PAC 通过 node --check；parseFbLink 与 gen-sub-link 编码/解析往返单测通过；4 个 shell 脚本 bash -n 通过。
- 【一致性】按最终"路径式订阅 + 空200默认页"同步更新 ARCHITECTURE / RULES_FORMAT / THREAT_MODEL / SERVER_DEPLOY / DEVTIPS。

## 2026-10-20（真机联调 + 架构改为单一 Go 服务）

- 【重大变更】部署联调中发现 Caddy 的 klzgrad/NaiveProxy forward_proxy fork **不兼容 Chrome 原生 https 代理**（CONNECT-over-TLS 隧道重置；且拦截全站导致首页/订阅 407）。经隔离测试定位为 fork 本质限制。
- 【重构】服务端从"Caddy + 独立 Go WebTransport"改为**单一 Go 程序** `server/flowbrowse`：
  - 标准 HTTPS 转发代理(TCP443, ALPN=http/1.1, CONNECT+绝对形式+BasicAuth恒定时间比较) — Chrome 原生兼容；
  - 同端口托管：根路径空 200(防指纹) + 密钥路径订阅静态文件(非代理请求不需代理鉴权)；
  - WebTransport(UDP443)；autocert 自动申请/续期 LE 证书(去掉 Caddy 依赖)。
  - 删除 server/caddy、server/systemd/{caddy,wt,reload}，新增 flowbrowse.service 单单元。
- 【快速脚本】`flowbrowse.sh` 菜单/子命令改为单服务(install/uninstall/status/restart/sub/renew/logs/info)；install.sh 支持预编译下载(GitHub Actions)+回退编译、按 amd64/arm64 自动选、覆盖前停服务、UDP 缓冲区 sysctl。
- 【GitHub Actions】`.github/workflows/build.yml`：按 tag 交叉编译 linux amd64/arm64 单一二进制并发布 Release；服务器纯下载不编译。
- 【真实服务器验证通过】在 193.123.230.166 / sel2.lkz.pub 实测：
  - 首页 GET→200 空body；无凭据 CONNECT→407；有凭据 CONNECT example→200、gstatic→204（转发真实可用）；
  - 错误 token→404（防枚举）；autocert 成功签发 LE 证书；UDP443 WebTransport 监听。
  - 真实 Chrome 内核端到端：导入真机订阅→connect→chrome.proxy=pac_script 生效→断开还原，全通过。
- 【遗留】WebTransport 探测在本沙箱报 "Opening handshake failed"（服务器无任何 QUIC 会话日志 + TCP 全通、UDP 不达），判定为**沙箱出站 UDP/443 受限**，非代码问题；需在用户本机真实 Chrome 复核。offscreen 探测已加 ping 就绪等待修复竞态。
- 【go.mod 坑】注释行 `#` 被 Go 1.26 mod 解析拒绝，已去除注释；Actions 曾因此失败。

## 2026-10-20（代理鉴权方案改为免鉴权+保密端口）

- 【根因】真机实测：`onAuthRequired` 触发且返回凭据，但服务器 **0 条带凭据 CONNECT**——Chrome 对 **https 代理的 CONNECT 不支持扩展自动注入 BasicAuth**（只会弹框）。“HTTPS 代理隐蔽 + BasicAuth 免弹框”在 Chrome 扩展不可兼得。
- 【决策】用户选定：HTTPS 代理 **免鉴权 + 保密端口**。重构单一 Go 服务为分端口：
  - TCP 443 = 站点（空200首页 + 密钥路径订阅），对外像正常网站；
  - TCP `FB_PROXY_PORT`（默认2096，可自定义）= HTTPS 转发代理，`FB_PROXY_AUTH=off` 默认不鉴权（靠非常规端口隐蔽）；
  - CONNECT 目标仍在 TLS 内→对 GFW 隐藏；保留 FB_PROXY_AUTH=on 开关（若换 HTTP/SOCKS5 代理可启用）。
- 【fb://】链接代理端口改用 FB_PROXY_PORT；订阅 URL 仍在站点端口 443。gen-sub-link/install/status/.env 同步。
- 【验证 v0.3.0】服务器实测：单进程监听 443/2096/udp443/80；GET /→200空、订阅→200、**代理 CONNECT(2096,免鉴权)→200**；WebTransport 真机 RTT 199ms（上一轮已验）。
- 【安全权衡】免鉴权转发代理有被滥用风险，缓解：非常规端口+自有域名隐蔽；后续可加 IP 白名单（拉过订阅的 IP 才放行）。

## 2026-10-20（内置全量分流规则）

- 用户反馈 .dat 二进制过重（geoip 16MB），改找纯文本规则源。**内置全量 CN IP 段**：从国内可直连的 jsDelivr `gaoyifan/china-operator-ip china.txt` 下载 6527 条 CIDR 写入 `extension/rules/cn-ip-cidr.txt`，默认离线即有完整规则。
- 域名：geosite:cn 的 Suffix/Plain 有 11万条，全塞 PAC 太大太慢，保留内置精简域名列表；远程可选。
- rules.js：远程解析器健壮化（兼容纯文本/Clash YAML/DOMAIN-SUFFIX）；PAC 生成时**预计算 CIDR→[base,mask] 数值对**，避免每请求重复 ip2long。
- 验证：生成 PAC 158KB、语法合法；1.0.1.5→DIRECT、8.8.8.8→代理、baidu→DIRECT、google→代理均正确。

## 2026-10-20（v0.4.0 放弃 QUIC，回归单端口 TCP 443 + IP 白名单）

- 【架构收敛】用户决定放弃 QUIC/WebTransport（因 Chrome 不能把浏览器通用流量交给 UDP/QUIC，且代理必须走 TCP）。删除整个 WebTransport/offscreen 子系统（`extension/offscreen/`、probe 改 HTTPS 延迟、manifest 去 offscreen 权限）。
- 【单端口复用】服务端改为 **仅 TCP 443**（代理+订阅+首页按请求形态分流：CONNECT=代理、GET=订阅/空200）+ TCP 80(ACME)；不再有 2096/62096 等额外端口。go.mod 去掉 quic-go/webtransport-go，仅留 autocert。
- 【鉴权定论】用户先想要密码鉴权；实测（无头 Chrome 端到端）：`onAuthRequired` 能触发且拿到正确凭据（isProxy=true hasCreds=true），但 **Chrome 对 HTTPS(TLS) 代理仍拒绝采纳，报 ERR_INVALID_AUTH_CREDENTIALS**（curl 同凭据能过，证明服务端无误）——确认是 Chrome MV3 对 HTTPS 代理鉴权的硬限制。
- 【方案】改用 **自动 IP 白名单**：拉到有效订阅 URL（密钥路径即凭证）的客户端 IP 自动放行（TTL 30天、持久化 allowlist.json）；仅作用于代理。默认 `FB_PROXY_ALLOW=on`、`FB_PROXY_AUTH=off`。
- 【验证 v0.4.0】服务端：仅监听 443+80；未拉订阅 CONNECT→403、拉订阅后 CONNECT→200；首页 200 空。无头 Chrome 端到端：导入订阅→连接→经代理访问 example.com=200 **无弹框**。
- 【UI】popup/options 重写为深色高级主题（渐变/卡片/状态胶囊）；工具栏角标 ON/OFF 一眼判开关；内置全量 CN IP 段 + 补字节跳动/抖音等域名修“抖音走代理”。

## 2026-10-20（v0.4.2 仅用户名鉴权实测 + IP 心跳自动上报）

- 【实测定论】用户追问“仅用户名”能否鉴权。服务端加 CONNECT 诊断日志后无头实测：Chrome 发来的 CONNECT **`hasAuth=false`**——即 `onAuthRequired` 虽触发并返回正确凭据，**Chrome 对 HTTPS 代理根本不上送任何 Proxy-Authorization 头**（与用户名/密码无关）。确认 HTTPS 代理下密码/用户名鉴权均不可行；HTTP 明文代理虽可行但会暴露目标+凭据，不可取。
- 【换 IP 自动回白名单】新增 **IP 心跳**：连接时每 2 分钟直连拉一次订阅 URL，服务器重新登记当前客户端 IP（TTL 续期）。配套：PAC 将代理域名本身设为 DIRECT（控制面直连），避免心跳绕经代理导致服务器只看到 127.0.0.1。
- 【验证】e2e 全绿；`allowlist.json` 含真实客户端 IP（非 127.0.0.1）；服务端 CONNECT 日志收敛为“仅被拒时记一行安全事件”（不落凭据）。
- 【默认】`FB_PROXY_ALLOW=on`、`FB_PROXY_AUTH=off`。

## 2026-10-20（分流准确率：内置全量 CN 域名表 + Set 父域匹配）

- 【根因】“很多国内流量走代理”：PAC 只能拿域名、geoip 段对域名请求无效；旧内置域名表仅 ~150 条，大量国内站/CDN 未覆盖。
- 【为何不用 dnsResolve 分流】在 PAC 里 `dnsResolve` 会把境外目标变成**本地明文 DNS 查询**→ GFW 看到目标域名，等于把 HTTPS 代理藏起来的目标又泄露，自废武功。故坚持按域名判定、不本地解析。
- 【方案】内置表换为 **geosite:cn Suffix/Plain 全量 109919 条**（含显式 TLD cn/com.cn 等）；`rules.js` 域匹配改为 **Set 父域逐层查找**（O(标签数) 哈希，11 万条仍快）。
- 【实测】Chrome 接受 1.76MB PAC（`chrome.proxy.set` ok）；sf-express.com/深层子域/x.cn/CN IP→DIRECT，google/youtube/8.8.8.8→代理均正确。
