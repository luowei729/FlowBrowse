#!/usr/bin/env bash
# uninstall.sh —— 卸载 FlowBrowse 服务端（单一服务）
# 作用：停止并删除 systemd 单元、二进制、站点；默认保留 /etc/flowbrowse 与证书缓存便于重装（--purge 彻底清除）。
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "[FlowBrowse] 请用 root 运行"; exit 1; }
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1

systemctl disable --now flowbrowse 2>/dev/null || true
rm -f /etc/systemd/system/flowbrowse.service
systemctl daemon-reload

# 二进制与站点（配置/证书默认保留）
rm -rf /opt/flowbrowse/bin /usr/local/bin/caddy /usr/local/bin/flowbrowse-wt /srv/flowbrowse
if [ "${PURGE}" -eq 1 ]; then
  rm -rf /etc/flowbrowse /var/lib/flowbrowse
  echo "[FlowBrowse] 已彻底清除（含 /etc/flowbrowse、/var/lib/flowbrowse）。"
else
  echo "[FlowBrowse] 已卸载服务与程序；保留 /etc/flowbrowse(配置) 与 /var/lib/flowbrowse(证书)。彻底清除加 --purge。"
fi
