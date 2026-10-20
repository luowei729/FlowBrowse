# PORT_FORWARDING.md — 经其他服务器端口转发接入 FlowBrowse

> 适用「路线①」：**扩展里填的 SNI 域名不变，把该域名的 DNS 指向中转机，中转机用 iptables 把 TCP 透传到源站**。
> 这样即使"域名解析到的 IP ≠ 证书所属源站的 IP"也能正常握手——因为证书是按**域名(SNI)**校验、且 TLS 端到端在源站终结，中转机只搬字节。

## 1. 原理（为什么"域名和 IP 不对应"没问题）

- Chrome 连 HTTPS 代理：用节点里那个**主机名**做 SNI，并校验证书对该**主机名**有效——**与它解析到哪个 IP 无关**。
- `iptables` DNAT 是 **L3/L4 透传**：不拆 TLS、不改 HTTP。握手仍是 **客户端 ↔ 源站端到端**，中转机看不到内层 CONNECT 目标（防嗅探优势保留）。
- 结论：**别把节点填成中转机的裸 IP**（裸 IP 无法用 LE 域名证书、Chrome 校验会失败）。要填**域名**，并让该域名的 A 记录指向中转机。

```
Chrome ──TLS(SNI=hk1.lkz.pub)──▶ 中转机F:443 ──iptables DNAT(透传)──▶ 源站B:443(持有 hk1.lkz.pub 证书)
```

## 2. 前提

- 源站 B 已用 `flowbrowse.sh install` 装好，监听 TCP 443(代理+订阅+首页)/80(ACME)，`DOMAIN=hk1.lkz.pub`。
- 中转机 F 能连到 B（同内网走内网 IP；跨网走 B 公网 IP）。下面 `<B_IP>` 即 B 对 F 可达的地址。

## 3. 配置步骤

### 3.1 DNS
把节点要用的域名（如 `hk1.lkz.pub`）的 **A 记录改为指向中转机 F 的公网 IP**。（原本指 B 的话，改指 F 即可，证书不用动。）

### 3.2 中转机 F：iptables 端口透传
```bash
# 开启内核转发
sysctl -w net.ipv4.ip_forward=1

# 443 透传到源站（代理+订阅+首页都走它）
iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination <B_IP>:443
# MASQUERADE：让回包经 F，源站看到的来源=F 的出口 IP（白名单据此放行，见 3.4）
iptables -t nat -A POSTROUTING -p tcp -d <B_IP> --dport 443 -j MASQUERADE
iptables -A FORWARD -p tcp -d <B_IP> --dport 443 -j ACCEPT

# 80 透传（仅为 Let's Encrypt HTTP-01 续期；不续期可省）
iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination <B_IP>:80
iptables -t nat -A POSTROUTING -p tcp -d <B_IP> --dport 80 -j MASQUERADE
iptables -A FORWARD -p tcp -d <B_IP> --dport 80 -j ACCEPT

# 持久化（Debian/Ubuntu）
apt-get install -y iptables-persistent && netfilter-persistent save
```

### 3.2.1 中转机对外端口不是 443（如 59443）时—端口必须一致

若中转机因 443 被占、只能用高端口（例 `59443`）对外，则**浏览器拨的端口 = 订阅广播的端口 = 中转机对外端口**，三者必须一致，否则拨到中转机 443（未监听）会连不上。

源站程序用同一个 `FB_TCP_PORT` 既做监听口又做订阅里的广播口，故把它设成中转机的对外端口即可（无需改代码）：
```bash
# 源站：对外端口改为中转机的 59443（监听 59443 + 订阅广播 59443）；ACME 仍走 80 不动
sudo sed -i 's|^FB_TCP_PORT=.*|FB_TCP_PORT=59443|' /etc/flowbrowse/.env
cd ~/FlowBrowse/server && sudo bash flowbrowse.sh install   # 重新生成订阅(端口变 59443)并重启
# 中转机对应改为透传 59443 → 源站真实IP:59443
```
新订阅会变成 `https://<域名>:59443/<token>/<file>`，插件重新导入即可。（若希望源站仍监听 443、只对外广播 59443，需新增 FB_ADVERTISE_PORT 分离监听/广播端口，属后续可选项。）

### 3.3 防火墙 / 云安全组
- 中转机 F：放行 **TCP 443**（+ TCP 80 若续期走它）。
- 源站 B：安全组放行来自 **F** 的 TCP 443/80（若 B 仅对内网开放则更隐蔽）。

### 3.4 源站 B 的 IP 白名单（转发场景关键）
因为 F 做了 MASQUERADE，B 看到的 CONNECT 来源都是 **F 的出口 IP**。三种放行方式，任选/叠加：

1. **自动学习**（默认可用）：客户端经**同一 F**拉一次订阅 → B 登记 F 的出口 IP。由于"拉订阅"和"走代理"都经 F、来源 IP 一致，通常开箱即用。
2. **静态兜底**（推荐写死 F，抗重启/过期）：编辑 B 的 `/etc/flowbrowse/.env`：
   ```
   FB_PROXY_ALLOW_STATIC=<F出口IP 或 10.0.0.0/8>
   ```
   改完 `systemctl restart flowbrowse`。静态项永久放行、不过期。
3. **动态上报**（带管理密钥，运行时增删）：
   ```
   curl "https://hk1.lkz.pub/<FB_ADMIN_TOKEN>/allow?add=auto"        # 上报调用方来源IP
   curl "https://hk1.lkz.pub/<FB_ADMIN_TOKEN>/allow?add=<F_IP>"       # 指定IP
   curl "https://hk1.lkz.pub/<FB_ADMIN_TOKEN>/allow?add=203.0.113.0/24&ttl=720"  # 网段+小时
   curl "https://hk1.lkz.pub/<FB_ADMIN_TOKEN>/allow?list=1"           # 查看当前白名单
   curl "https://hk1.lkz.pub/<FB_ADMIN_TOKEN>/allow?del=<IP>"         # 删除动态项(静态不可删)
   ```
   `FB_ADMIN_TOKEN` 由 install 自动生成在 `.env`，**属机密、勿外泄**（留空则上报接口禁用）。
   > 无需 curl 的图形化方式：浏览器扩展 options → “IP 白名单”页，填入服务器与同一管理密钥，即可“上报我当前IP”/按 IP或CIDR 添加/刷新列表/删除动态项。

## 4. 验证

```bash
# 从外网：域名应解析到 F，且经 F 透传能取到订阅/走通代理
dig +short hk1.lkz.pub                       # 期望 = F 的公网 IP
curl -sk https://hk1.lkz.pub/ -o /dev/null -w '%{http_code}\n'          # 期望 200(空body)
curl -sk "https://hk1.lkz.pub/<NODE_TOKEN>/<SUB_FILE>" -o /dev/null -w '%{http_code}\n'  # 期望 200
# 代理连通（F 的 IP 已在 B 白名单后）
curl -s --max-time 15 -x https://hk1.lkz.pub:443 https://www.example.com -o /dev/null -w '%{http_code}\n'
```
源站侧：`systemctl status flowbrowse`、`journalctl -u flowbrowse -n`（看 `[CONNECT拒绝]`/白名单登记）、`curl "https://.../<FB_ADMIN_TOKEN>/allow?list=1"`。

## 5. 注意事项

- **中转机不终结 TLS**：只 L4 透传，看不到也改不了内层目标域名，防嗅探优势保留。若改成正则"中转机解密再转发"，需在中转机另装证书、且失去端到端隐藏，不推荐。
- **白名单粒度变粗**：MASQUERADE 下所有订阅者共享 F 的出口 IP，一旦放行 F 即放行其后所有人——靠"知道密钥订阅 URL 才能触发/才能调上报接口 + 非常规使用"来隐蔽控流。要更细可让 F 不做 SNAT（纯 DNAT+回程路由），使 B 看到真实客户端 IP，但那需要 F/B 二层可达或配 TOA，较复杂。
- **HTTP-01 续期依赖 80**：域名指到 F 后，Let's Encrypt 回调 `http://域名:80` 会打到 F，需 F 透传 80→B，否则证书续期失败。不便透传 80 时可考虑 DNS-01（当前未实现）。
