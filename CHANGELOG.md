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
