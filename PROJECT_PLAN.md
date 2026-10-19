# PROJECT_PLAN.md — FlowBrowse 项目计划

> 记录整体规划与阶段进度。北京时间 / 2026-10-19 初始化。

## 架构决策（路线 3 混合方案）

- **主干通道**：`chrome.proxy` → 远程 Caddy HTTPS 转发代理（TCP 443，TLS 到 `sel2.lkz.pub`）。全量接管 http/https/ftp/wss 页面流量，零本地客户端。
- **QUIC 通道**：offscreen 文档内 WebTransport（UDP 443，h3/QUIC）连远程 Go 服务，用于节点测速/健康探测/信令，及实验性白名单域名 h3 加速（Phase 4）。
- **分流**：浏览器侧 PAC 脚本，依据内置中国域名/IP CIDR 判定 国内→DIRECT、其余→PROXY。
- **订阅**：服务端输出借鉴 hy2 格式的 `fb://` 链接 + base64 订阅接口；插件粘贴订阅地址即导入节点。
- **证书**：Caddy automatic HTTPS（Let's Encrypt）签发与自动续期；域名未生效导致失败时中文日志提示。

## 阶段划分与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 可行性边界验证（quic scheme / WebTransport） | ✅ 完成，结论见 docs/ARCHITECTURE.md |
| Phase 1 | 服务端 Caddy 转发代理 + LE 证书 + 订阅接口 + 一键脚本 | ✅ 完成（本地静态/逻辑验证；Go/Caddy 实编在服务器） |
| Phase 2 | 服务端 Go WebTransport 服务（probe/session） | ✅ 完成（API 据官方示例核实，服务器构建验证） |
| Phase 3 | 扩展：manifest + lib 模块 + service-worker + offscreen | ✅ 完成（node 语法校验通过） |
| Phase 4 | 扩展：popup/options UI（一键连接、订阅、节点、分流、端口） | ✅ 完成（多订阅/多节点增删改/选节点/端口） |
| Phase 5 | 规则分流数据内置（CN 域名/IP CIDR） | ✅ 完成（内置起步版 + 可远程更新） |
| Phase 6 | 端到端联调验证（测试机 + 无头浏览器） | ⏳ 待办（需服务器实安装后进行） |
| Phase 7 | 实验性 h3 白名单域名加速（stretch） | ⏳ 待办 |

## 交付物清单

- server/：`install.sh` `uninstall.sh` `status.sh` `Caddyfile` `webtransport/{main.go,go.mod}` `scripts/gen-sub-link.sh` `systemd/*.service` `config/.env.example`
- extension/：`manifest.json` `lib/*` `background/service-worker.js` `offscreen/*` `popup/*` `options/*` `rules/*` `icons/*`
- 文档：根目录 5 个 md + docs/{ARCHITECTURE,THREAT_MODEL,RULES_FORMAT,SERVER_DEPLOY}.md

## 假设备忘

1. 自用/小范围自托管分发，暂不上架 Chrome Web Store。
2. 证书 HTTP-01（需放行 TCP 80）；80 不可达则改 DNS-01。
3. 主干代理默认 `https` scheme。
4. 分流默认浏览器侧 PAC。
