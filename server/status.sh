#!/usr/bin/env bash
# status.sh —— FlowBrowse 运行状态自检
# 作用：一眼看清 caddy/wt 服务状态、证书是否就绪、订阅是否可达，便于排障（按 DEVTIPS 的排查顺序）。
set -uo pipefail
ENV_FILE="/etc/flowbrowse/.env"
[ -f "${ENV_FILE}" ] && { set -a; . "${ENV_FILE}"; set +a; } || echo "[FlowBrowse] 未找到 ${ENV_FILE}，可能尚未安装。"

DOMAIN="${DOMAIN:-}"; FB_TCP_PORT="${FB_TCP_PORT:-443}"; FB_WT_PORT="${FB_WT_PORT:-443}"
NODE_TOKEN="${NODE_TOKEN:-}"; FB_SUB_FILE="${FB_SUB_FILE:-}"

echo "===== systemd 服务状态 ====="
for u in flowbrowse-caddy flowbrowse-wt flowbrowse-wt-reload.timer; do
  printf '%-28s : %s\n' "${u}" "$(systemctl is-active "${u}" 2>/dev/null || echo unknown)"
done

echo "===== 证书状态（Caddy 数据目录）====="
CERT="${FB_CERT:-/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}/${DOMAIN}.crt}"
if [ -f "${CERT}" ]; then
  echo "证书文件存在：${CERT}"
  openssl x509 -in "${CERT}" -noout -subject -dates 2>/dev/null || echo "openssl 解析证书失败"
else
  echo "[FlowBrowse] 证书尚未生成：${CERT}"
  echo "常见原因：域名 ${DOMAIN} 未解析生效 / TCP 80 被占用 / ACME 邮箱无效。请检查：journalctl -u flowbrowse-caddy --no-pager | tail -40"
fi

echo "===== 站点与订阅可达性 ====="
echo "-- 默认页（应与原生 Caddy 一致：200 空 body）--"
curl -sS -o /dev/null -w 'HTTP %{http_code}  size=%{size_download} bytes\n' "https://${DOMAIN}:${FB_TCP_PORT}/" || echo "访问失败"
if [ -n "${NODE_TOKEN}" ] && [ -n "${FB_SUB_FILE}" ]; then
  echo "-- 订阅地址 --"
  curl -sS -o /dev/null -w 'HTTP %{http_code}  size=%{size_download} bytes\n' "https://${DOMAIN}:${FB_TCP_PORT}/${NODE_TOKEN}/${FB_SUB_FILE}" || echo "订阅访问失败"
fi

echo "===== WebTransport /healthz（h3，需支持 http3 的 curl）====="
curl -sS --http3 -o /dev/null -w 'HTTP %{http_code}\n' "https://${DOMAIN}:${FB_WT_PORT}/healthz" 2>/dev/null || echo "http3 探测不可用或端口未就绪（UDP ${FB_WT_PORT}）"

echo "完成。"
