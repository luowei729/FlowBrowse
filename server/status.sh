#!/usr/bin/env bash
# status.sh —— FlowBrowse 运行状态自检（单一服务端）
# 作用：一眼看清服务状态、端口、首页/订阅/健康检查可达性，便于排障（证书由程序内 autocert 管理）。
set -uo pipefail
ENV_FILE="/etc/flowbrowse/.env"
[ -f "${ENV_FILE}" ] && { set -a; . "${ENV_FILE}"; set +a; } || echo "[FlowBrowse] 未找到 ${ENV_FILE}，可能尚未安装。"

DOMAIN="${DOMAIN:-}"; FB_TCP_PORT="${FB_TCP_PORT:-443}"; FB_PROXY_PORT="${FB_PROXY_PORT:-2096}"; FB_WT_PORT="${FB_WT_PORT:-443}"; FB_ACME_PORT="${FB_ACME_PORT:-80}"
NODE_TOKEN="${NODE_TOKEN:-}"; FB_SUB_FILE="${FB_SUB_FILE:-}"

echo "===== 服务状态 ====="
printf '%-24s : %s\n' "flowbrowse" "$(systemctl is-active flowbrowse 2>/dev/null || echo unknown)"

echo "===== 端口监听 ====="
ss -ltnp "sport = :${FB_TCP_PORT}" 2>/dev/null | tail -n +2 | head -1 || echo "TCP ${FB_TCP_PORT}(站点) 未监听"
ss -ltnp "sport = :${FB_PROXY_PORT}" 2>/dev/null | tail -n +2 | head -1 || echo "TCP ${FB_PROXY_PORT}(代理) 未监听"
ss -lunp "sport = :${FB_WT_PORT}"  2>/dev/null | tail -n +2 | head -1 || echo "UDP ${FB_WT_PORT} 未监听"
ss -ltnp "sport = :${FB_ACME_PORT}" 2>/dev/null | tail -n +2 | head -1 || echo "TCP ${FB_ACME_PORT}(ACME) 未监听"

echo "===== 证书(autocert 缓存目录) ====="
CACHE="${FB_CERT_CACHE:-/var/lib/flowbrowse/certcache}"
if ls "${CACHE}"/*"${DOMAIN}"* >/dev/null 2>&1 || [ -n "$(ls -A "${CACHE}" 2>/dev/null)" ]; then
  echo "证书缓存非空：${CACHE}（autocert 已申请证书）"
else
  echo "[FlowBrowse] 证书缓存为空：${CACHE}，多为域名未解析或 80 不可达。查看：journalctl -u flowbrowse -n 40 --no-pager"
fi

echo "===== 站点/订阅/健康可达性 ====="
echo "-- 默认页(应 200 空 body，复刻原生 Caddy) --"
curl -sS -m 10 -o /dev/null -w "GET / => HTTP %{http_code} size=%{size_download}\n" "https://${DOMAIN}:${FB_TCP_PORT}/" || echo "访问失败"
if [ -n "${NODE_TOKEN}" ] && [ -n "${FB_SUB_FILE}" ]; then
  curl -sS -m 10 -o /dev/null -w "订阅 => HTTP %{http_code} size=%{size_download}\n" "https://${DOMAIN}:${FB_TCP_PORT}/${NODE_TOKEN}/${FB_SUB_FILE}" || echo "订阅访问失败"
fi
curl -sS -m 10 --http3 -o /dev/null -w "healthz(h3) => HTTP %{http_code}\n" "https://${DOMAIN}:${FB_WT_PORT}/healthz" 2>/dev/null || echo "h3 healthz 探测不可用(UDP ${FB_WT_PORT})"
echo "-- 代理转发(CONNECT 到保密端口) --"
curl -sS -m 12 -x "https://${DOMAIN}:${FB_PROXY_PORT}" -o /dev/null -w "proxy->example.com => HTTP %{http_code}\n" https://www.example.com/ 2>/dev/null || echo "代理测试不可用(TCP ${FB_PROXY_PORT})"
echo "完成。"
