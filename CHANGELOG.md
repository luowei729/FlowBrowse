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
- 【真实服务器验证通过】在 <服务器公网IP> / <你的域名> 实测：
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

## 2026-10-20（UI 推翻重做：套用 Zero Omega 风格“情景模式”+浅色主题）

- 【需求】用户要求推翻现有 UI，套用 Zero Omega 的 UI 与功能范式，选“连功能范式一起改 + 浅色”。
- 【功能范式】新增“情景模式”抽象（config.js `profileList`/`resolveProfile`）：`直接连接`/`自动分流`/`每个节点` 统一为可切换项；`settings.activeProfile` 为唯一开关，派生旧 mode+node（兼容旧数据）。SW 新增 `selectProfile`/`applyActiveProfile`，启动即套用当前情景（Zero Omega 式常驻）；connect/disconnect/setMode 保留为映射。
- 【popup】重写为 Zero Omega 式情景切换列表（当前高亮 + 徒章）+ 齿轮；不再用“连接/断开”按钮。
- 【options】重写为左侧栏分页 SPA（情景模式/订阅/分流规则/通用/导入导出）+ 代理表格（协议/服务器/地区/状态/操作）；新增导入导出 JSON（SW 加 `importConfig`）。
- 【主题】popup/options 均改浅色（白底 + #1a73e8 蓝强调），贴近 Zero Omega。
- 【保留】白名单+心跳、角标 ON/OFF、内置全量规则、Set 父域匹配均不变。
- 【验证】无头 e2e（导入订阅→connect→example.com=200）全绿；JS 语法均过。

## 2026-10-20（分流规则：不代理列表 + 更新优化缓存）

- 【不代理列表】新增用户自定义 `customDirect`（强制直连）与 `customProxy`（强制代理），每行一条，支持 `example.com`/`*.example.com`/`1.2.3.4`/`10.0.0.0/8`；裸域自动补 `*.域` 覆盖子域。`parseCustomList` 拆为 glob（交 shExpMatch）+ CIDR 数值段；PAC 在全局/分流两模式都优先应自定义（先不代理、再强制代理，然后才 CN/默认）。
- 【更新优化】远程规则改为**缓存**：`fetchAndCacheRules` 拉取→写 `fb_rules_cache`；`loadCnData` 连接时只读本地缓存（离线可用、不再每次 fetch）。options 分流规则页新增“立即更新”按钮 + 最近更新时间/条数显示；SW 新增 `updateRules` 动作。
- 【验证】自定义匹配正确（子域/CIDR/强制代理均命中）；e2e 无回归。
- 【修复】切换报“PAC 含非 ASCII”：原因是我在 split 模式 PAC 模板里写了一行**中文注释**（chrome.proxy 仅允许 ASCII）。改为英文注释；验证 global/split PAC 均无 ASCII 外字符。（教训：PAC 模板内注释必须英文，proxy-manager 的 ASCII 校验会兜底报错）
- 【优化】域名远程源默认预填推荐地址（jsDelivr Loyalsoldier/clash-rules direct.txt），与 IP 框 china.txt 对称；两框都预填但“使用远程”默认关=用内置。

## 2026-10-20（修复一键安装 .env 报错 + 图标/README）

- 【修复】`flowbrowse.sh install` 报 `.env: line 8: syntax error near unexpected token 'newline'`：因 `.env.example` 用了 `<随机用户名>` 尖括号占位符，而 .env 会被 `set -a; . .env` source，`<` 是重定向符。且旧占位不匹配 install.sh 的 `CHANGE_ME_*` 检测。→ 改为 shell 安全且匹配的 `CHANGE_ME_LONG_RANDOM`/`CHANGE_ME_SUBFILE`/`CHANGE_ME_STRONG_PASSWORD`（AUTH_USER=fbuser）。
- 【自愈】install.sh source 前加 `bash -n` 校验：若旧 .env 含元字符则备份为 .env.bak 并从示例重建，免手动删。
- 【图标】生成蓝/灰⇄图标，manifest 配 icons+default_icon，updateIcon 用 setIcon(getURL 绝对路径)换色代替大角标。
- 【文档】README 加一键安装命令；全仓 md 脱敏 sel2 域名/测试 IP 为占位符。
- 【交互】`install.sh` 在安装最初询问真实域名：当 `DOMAIN` 为空或仍是示例 `example.com` 时，tty 下提示输入并 `sed` 写回 `.env`；非交互终端则明确报错引导手动改 `.env`。（解决“拿示例 example.com 解析到 Cloudflare 当自己域名签证书必失败”）

## 2026-10-20（修复预编译下载 FB_REPO 缺失 + 清除遗留 QUIC sysctl）

- 【修复】全新 clone 跑 `flowbrowse.sh install` 报“未配置 FB_REPO/FB_DL_BASE → 预编译下载失败”：`.env.example` 和 `install.sh` 都没给 `FB_REPO` 默认值。→ `download_prebuilt` 里 `repo="${FB_REPO:-luowei729/FlowBrowse}"` 兜底（仍可被 .env 的 FB_REPO/FB_DL_BASE 覆盖）；实测拼出的 GitHub Release 地址 HTTP 200。旧 .env 无此键也能工作（代码默认兜底）；`FB_BIN_MODE=build/auto` 回退编译的能力保留。
- 【文档】`.env.example` 新增“预编译二进制下载源”段（FB_BIN_MODE/FB_REPO/FB_DL_BASE 及注释），方便 fork/自建 Release 用户覆盖。
- 【清理】移除 install.sh 里遗留的 QUIC UDP 缓冲区 sysctl 段（v0.4.x 已纯 TCP 443，不再需要）及其误导日志。

## 2026-10-20（自定义 IP 白名单上报 + 端口转发域名/IP 不对应）

- 【背景】用户要用其他服务器 iptables 端口转发接入，导致：①白名单只能自动登记“拉订阅那条”的 IP，与转发后的代理来源 IP 不一致而误拦；②担心域名与 IP 不对应导致证书失败。
- 【定性】证书按 **域名(SNI)** 校验、与解析到哪个 IP 无关；DNAT 是 L4 透传、TLS 端到端在源站。→ 路线①：域名 A 记指到中转机、中转机透传 443(+80)，无需改代码（节点必须填域名、不能填裸 IP）。
- 【服务端 main.go】白名单重构为**静态网段 + 动态项(IP/CIDR)**：新增 config `FB_PROXY_ALLOW_STATIC`/`FB_ADMIN_TOKEN`+`splitList`；`allowList` 改为 `staticNets`+`entries[allowEntry{ipnet,exp}]`，`allowed()` 用 `net.IPNet.Contains` 支持 CIDR；新增 `toNet/addIP/addNet/del/listJSON/handleAdmin`。
- 【上报接口】`GET/POST /<FB_ADMIN_TOKEN>/allow`：`add=auto|<ip|cidr>`(&`ttl=`小时)/`del=`/`list=1`，无参默认上报调用来源 IP。由独立管理密钥保护，留空=禁用。
- 【安装】`.env.example` 新增两键；install.sh 自动随机化 `FB_ADMIN_TOKEN`（旧 .env 无此键也能补写）、确保 `FB_PROXY_ALLOW_STATIC` 键存在、完成横幅打印上报 URL。
- 【文档】新建 `docs/PORT_FORWARDING.md`（DNS+iptables+安全组+白名单放行全步骤）；SERVER_DEPLOY/THREAT_MODEL/DEPLOY_CREDENTIALS/DEVTIPS/AGENTS 同步。（待 Actions 编译新二进制后部署到服务器）

## 2026-10-20（扩展新增 IP 白名单管理页）

- 【需求】用户要在插件上直接管理 IP 白名单（而非只能 curl 上报接口）。
- 【实现】options 新增侧栏页“IP 白名单”：服务器 host:port + 管理密钥输入与保存、“上报我当前IP”、按 IP/CIDR(+选填 TTL)添加、刷新列表、动态项逐行删除；静态项只展不可删。
- 【新模块】`extension/lib/whitelist.js` 封装 `/<FB_ADMIN_TOKEN>/allow` 的 list/add/del（fetch no-store、token 路径段编码、非2xx带提示抛错）。SW 新增动作 wlSave/wlList/wlAdd/wlDel；`buildState` 回传 wl；服务器留空时 `defaultWlServer()` 取当前节点 host:port。因 PAC 已将代理域名设 DIRECT，“上报我当前IP”带的是本机真实出口 IP。
- 【安全】管理密钥单独存 `fb_wl` 键（config.js 新增 getWl/setWl），**不进“导入/导出”的 settings JSON**，防泄密。
- 【验证】无头 smoke：选项页加载无错、白名单页可切换、控件齐备、fb_wl 落盘正确且 token 未混入 settings、无可用地址时优雅报错。（端到端成功需目标服务器已部 v0.4.3 带上报接口的二进制）
