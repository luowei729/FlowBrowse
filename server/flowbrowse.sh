#!/usr/bin/env bash
# flowbrowse.sh —— FlowBrowse 服务端"快速控制面板"
#
# 定位：把 install / uninstall / status / restart / 重新生成订阅 / 证书 / 日志 等操作聚合为一个可交互选择、
#       也可命令行直接调用的统一入口；底层仍调用各自单一职责脚本，本脚本只做编排，不复制业务逻辑。
#
# 用法：
#   sudo bash flowbrowse.sh                # 交互菜单
#   sudo bash flowbrowse.sh install        # 直接执行某动作：install|uninstall|status|restart|sub|renew|logs|info
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/flowbrowse/.env"

log()  { printf '\033[1;36m[FlowBrowse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[FlowBrowse][警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FlowBrowse][错误]\033[0m %s\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash flowbrowse.sh"; }

load_env() { [ -f "${ENV_FILE}" ] && { set -a; . "${ENV_FILE}"; set +a; } || return 1; }

# ===== 动作实现 =====
act_install() {
  log "执行安装/更新（可重复运行，幂等）..."
  bash "${SCRIPT_DIR}/install.sh"
}

act_uninstall() {
  need_root
  local purge=""
  read -r -p "是否连同配置/证书一并清除？输入 y 彻底清除(含 /etc/flowbrowse)，其它键保留： " ans
  [ "${ans}" = "y" ] && purge="--purge"
  bash "${SCRIPT_DIR}/uninstall.sh" ${purge}
}

act_status() { bash "${SCRIPT_DIR}/status.sh"; }

act_restart() {
  need_root
  log "重启 Caddy 与 WebTransport ..."
  systemctl restart flowbrowse-caddy flowbrowse-wt
  sleep 1
  systemctl --no-pager --full status flowbrowse-caddy flowbrowse-wt | grep -E "Active:|Main PID:" || true
  log "完成。"
}

# 重新生成订阅文件与链接（读取 .env 现有 NODE_TOKEN/FB_SUB_FILE，不改动它们，仅重写文件）
act_sub() {
  need_root
  load_env || die "未找到 ${ENV_FILE}，请先安装。"
  log "重新生成订阅文件与链接 ..."
  bash "${SCRIPT_DIR}/scripts/gen-sub-link.sh"
  [ -n "${FB_WEB_ROOT:-}" ] && chown -R caddy:caddy "${FB_WEB_ROOT}" 2>/dev/null || true
}

# 证书：重启 caddy 触发 automatic HTTPS 申请/续期；随后重启 wt 让其加载最新证书
act_renew() {
  need_root
  log "触发证书申请/续期（重启 caddy 与 wt）..."
  systemctl restart flowbrowse-caddy
  sleep 2
  systemctl restart flowbrowse-wt
  if load_env; then
    local cert="/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}/${DOMAIN}.crt"
    if [ -f "${cert}" ]; then
      log "证书已就绪："; openssl x509 -in "${cert}" -noout -subject -dates
    else
      warn "证书尚未生成：多为域名未解析或 80 端口不可达。检查：journalctl -u flowbrowse-caddy -n 40 --no-pager"
    fi
  fi
}

act_logs() {
  need_root
  local which="${1:-caddy}"
  case "${which}" in
    caddy) journalctl -u flowbrowse-caddy -n 50 --no-pager ;;
    wt)    journalctl -u flowbrowse-wt -n 50 --no-pager ;;
    *)     journalctl -u flowbrowse-caddy -u flowbrowse-wt -n 50 --no-pager ;;
  esac
}

# 显示当前配置摘要（脱敏：口令/token 只提示存在与否，不打印明文）
act_info() {
  if load_env; then
    echo "域名 DOMAIN        : ${DOMAIN:-<未设置>}"
    echo "TCP/UDP 端口       : ${FB_TCP_PORT:-443} / ${FB_WT_PORT:-443}"
    echo "ACME 邮箱          : ${ACME_EMAIL:-<未设置>}"
    echo "代理用户 AUTH_USER : ${AUTH_USER:-<未设置>}"
    echo "代理口令 AUTH_PASS : $( [ -n "${AUTH_PASS:-}" ] && echo '<已设置, 见 .env>' || echo '<未设置>' )"
    echo "订阅 token/文件名  : $( [ -n "${NODE_TOKEN:-}" ] && echo "<已设置, 见 .env>" ) / $( [ -n "${FB_SUB_FILE:-}" ] && echo "<已设置>" )"
    echo "节点名/地区        : ${NODE_NAME:-<未设置>} / ${NODE_REGION:-<未设置>}"
  else
    die "未找到 ${ENV_FILE}，请先安装。"
  fi
}

# ===== 交互菜单 =====
menu() {
  while true; do
    echo
    echo "================= FlowBrowse 控制面板 ================="
    echo "  1) 安装 / 更新     (调用 install.sh)"
    echo "  2) 卸载           (调用 uninstall.sh)"
    echo "  3) 状态自检       (调用 status.sh)"
    echo "  4) 重启服务       (caddy + webtransport)"
    echo "  5) 重新生成订阅   (写入订阅文件并打印链接)"
    echo "  6) 申请/续期证书  (重启 caddy 触发 ACME)"
    echo "  7) 查看日志       (caddy / wt)"
    echo "  8) 查看当前配置   (脱敏摘要)"
    echo "  0) 退出"
    echo "======================================================="
    read -r -p "请选择 [0-8]: " choice
    case "${choice}" in
      1) act_install ;;
      2) act_uninstall ;;
      3) act_status ;;
      4) act_restart ;;
      5) act_sub ;;
      6) act_renew ;;
      7) read -r -p "看哪个日志 (caddy/wt/all，默认 caddy): " j; act_logs "${j:-caddy}" ;;
      8) act_info ;;
      0) echo "再见。"; break ;;
      *) warn "无效选择" ;;
    esac
  done
}

# ===== 入口：有参数走子命令，无参数走菜单 =====
need_root
case "${1:-}" in
  install)   act_install ;;
  uninstall) act_uninstall ;;
  status)    act_status ;;
  restart)   act_restart ;;
  sub)       act_sub ;;
  renew)     act_renew ;;
  logs)      act_logs "${2:-caddy}" ;;
  info)      act_info ;;
  "")        menu ;;
  *)         die "未知子命令：${1}（可用 install|uninstall|status|restart|sub|renew|logs|info，或留空进入菜单）" ;;
esac
