#!/usr/bin/env bash
# uninstall.sh —— 卸载 FlowBrowse 服务端
# 作用：停止并删除 systemd 单元、二进制、配置与静态站点；默认保留证书与 .env 便于以后重装（可用 --purge 彻底清除）。
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "[FlowBrowse] 请用 root 运行"; exit 1; }

PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1

for u in flowbrowse-wt-reload.timer flowbrowse-wt-reload.service flowbrowse-wt flowbrowse-caddy; do
  systemctl disable --now "${u}.service" 2>/dev/null || systemctl disable --now "${u}" 2>/dev/null || true
done
rm -f /etc/systemd/system/flowbrowse-caddy.service \
      /etc/systemd/system/flowbrowse-wt.service \
      /etc/systemd/system/flowbrowse-wt-reload.service \
      /etc/systemd/system/flowbrowse-wt-reload.timer
systemctl daemon-reload

# 二进制与站点（.env 与证书默认保留，避免误删；--purge 才清）
rm -f /opt/flowbrowse/bin/flowbrowse-wt /usr/local/bin/caddy
rm -rf /srv/flowbrowse
if [ "${PURGE}" -eq 1 ]; then
  rm -rf /etc/flowbrowse
  echo "[FlowBrowse] 已彻底清除（含 /etc/flowbrowse）。"
else
  echo "[FlowBrowse] 已卸载服务与程序；保留 /etc/flowbrowse（配置/证书）。彻底清除请加 --purge。"
fi
