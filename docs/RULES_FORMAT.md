# RULES_FORMAT.md — 订阅链接与分流规则格式

## 1. FlowBrowse 节点链接 `fb://`（借鉴 hy2 URI 约定，非 Hysteria2 协议）

```
fb://<USER>:<PASS>@<domain>:<tcp_port>/?region=<地区>&name=<节点显示名>
```

| 组成 | 含义 | 默认/示例 |
|---|---|---|
| `USER:PASS` | 可选 Basic 凭据（默认服务靠 IP 白名单，不强制校验） | `u1:p2` |
| `domain:tcp_port` | HTTPS 转发代理地址（与订阅共用同一 TCP 443） | `sel2.lkz.pub:443` |
| `region=` | 地区标签（UI 展示、分组） | `SG` |
| `name=` | 节点显示名 | `FlowBrowse-新加坡` |

> v0.4.0 起已放弃 QUIC，**不再有 `udp=` 字段**（旧链接若带 `udp=` 会被忽略，向后兼容）。

### 解析规则
1. scheme 必须为 `fb`，否则忽略。
2. userinfo 取 `USER:PASS`；host:port 取 TCP 代理地址。
3. query 解析 `region`/`name`；`name` 缺失时默认 host。
4. `name`/`region` 需 URL 解码（支持中文）。
5. 生成节点对象：`{source:'subscribe', name, region, proxy:{host,port,scheme:'https',user,pass}, wtPort}`。

### 示例
```
fb://u1:p2@sel2.lkz.pub:443/?udp=443&region=SG&name=FlowBrowse-%E6%96%B0%E5%8A%A0%E5%9D%A1
```

## 2. 订阅接口

订阅采用"密钥路径 + 随机文件名"方案（契合 NaiveProxy 的隐藏链接思路）：`$NODE_TOKEN` 是不可猜的路径段、`$FB_SUB_FILE` 是不可猜的文件名，两者均可随机生成或自定义，整条 URL 不可预测以防被嗅探/枚举。安装时由 `gen-sub-link.sh` 在站点根下生成 `$NODE_TOKEN/$FB_SUB_FILE` 与 `$NODE_TOKEN/$FB_SUB_FILE.json`。

- `GET https://<domain>:<tcp_port>/<NODE_TOKEN>/<FB_SUB_FILE>`
  - 返回**多条 `fb://` 链接换行拼接后再 base64** 的文本（兼容主流订阅客户端习惯），`Content-Type: text/plain`。
- `GET https://<domain>:<tcp_port>/<NODE_TOKEN>/<FB_SUB_FILE>.json`
  - 返回结构化：
    ```json
    { "nodes": [ { "name":"FlowBrowse-SG","region":"SG","host":"<domain>","tcp_port":443,"udp_port":443,"scheme":"https","user":"u1","has_pass":true } ] }
    ```
- 未知/错误 token 路径 → 命中不到文件 → `404`，不泄露任何节点信息。
- 域名与 tcp/udp 端口均来自 `.env`（`DOMAIN`/`FB_TCP_PORT`/`FB_WT_PORT`），无硬编码；测试默认域名 `sel2.lkz.pub`。

## 3. 分流规则（PAC 生成输入）

### `rules/cn-domains.txt`
- 每行一个域名后缀，命中即视为"中国/直连"。支持 `.` 前缀表示子域。
```
cn
.taobao.com
.bilibili.com
.qq.com
```

### `rules/cn-ip-cidr.txt`
- 每行一个 IPv4 CIDR，命中即直连。
```
114.114.114.114/32
223.5.5.5/32
```

### PAC 判定逻辑
- `mode=关闭` → 不设置代理。
- `mode=全局` → 全部 `PROXY <domain>:<tcp_port>`。
- `mode=分流`（默认）：
  - host 命中 CN 域名 / IP 命中 CN CIDR / 内网与回环 → `DIRECT`
  - 其余 → `PROXY <domain>:<tcp_port>`
- 数据来源：公开 geosite/geoip（`Rules: Loyalsoldier/v2ray-rules-dat`），更新方式见 options「更新规则」。

## 4. 版本与兼容

- `fb://` 字段只增不改语义，旧扩展遇到未知 query 应忽略而非报错。
- 未来若引入需本地客户端的专有协议，必须另立 scheme，不复用 `fb`。
