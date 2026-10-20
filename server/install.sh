#!/usr/bin/env bash
# install.sh —— FlowBrowse 服务端一键安装（单一 Go 二进制）
#
# 做什么 & 为什么：
#   1) 准备 /etc/flowbrowse/.env（占位密钥自动生成随机值；域名/端口全部可自定义）。
#   2) 预检域名解析并给中文提示（autocert 申请 LE 证书依赖域名已指向本机）。
#   3) 获取二进制：默认从 GitHub Actions Release 下载预编译(amd64/arm64)，服务器不本地编译；可回退编译。
#   4) 布置用户/目录/systemd 单元并启动；证书由程序内 autocert 自动申请续期。
#   5) 生成订阅文件并打印订阅地址与 fb:// 链接。
#
# 用法：sudo bash install.sh  （幂等，可重复执行做更新）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/flowbrowse/.env"
BIN_DIR="/opt/flowbrowse/bin"
SERVER_BIN="${BIN_DIR}/flowbrowse-server"
DATA_DIR="/var/lib/flowbrowse"
WEB_ROOT_DEFAULT="/srv/flowbrowse"

log()  { printf '\033[1;36m[FlowBrowse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[FlowBrowse][警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FlowBrowse][错误]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"
. /etc/os-release 2>/dev/null || true
log "目标系统：${PRETTY_NAME:-unknown}  架构：$(uname -m)"

# ---------- 1) 准备 .env ----------
mkdir -p /etc/flowbrowse
if [ ! -f "${ENV_FILE}" ]; then
  cp "${SCRIPT_DIR}/config/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  warn "已生成默认 ${ENV_FILE}，占位密钥会被自动替换为随机值。"
fi
# 自愈：.env 会被 source，若含 shell 元字符（如旧版 <占位符>）会语法报错；校验不过则备份并从示例重建
if ! bash -n "${ENV_FILE}" 2>/dev/null; then
  warn "${ENV_FILE} 语法异常（可能含 < > 等元字符），已备份为 .env.bak 并从示例重建。"
  mv "${ENV_FILE}" "${ENV_FILE}.bak"
  cp "${SCRIPT_DIR}/config/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi
set -a; . "${ENV_FILE}"; set +a
export FB_WEB_ROOT="${FB_WEB_ROOT:-$WEB_ROOT_DEFAULT}"

# 域名必填：若仍是示例占位 example.com 或为空，交互式提示输入真实域名并写回 .env。
#   为什么：autocert 靠域名签发 LE 证书，示例 example.com 是别人的域名（会解析到 Cloudflare），
#   直接拿去签证书必失败；故在安装最初就把真实域名问出来，后续预检/订阅/证书都用它。
#   非交互 tty（如管道/CI）无法读取输入，则明确报错引导你手动编辑 .env，避免静默用错域名。
if [ -z "${DOMAIN:-}" ] || [ "${DOMAIN}" = "example.com" ]; then
  if [ -t 0 ]; then
    printf '\033[1;36m[FlowBrowse]\033[0m 请输入你的域名（A 记录已解析到本机公网 IP，用于 autocert 签发证书）: '
    read -r DOMAIN
    if [ -z "${DOMAIN:-}" ]; then
      die "域名不能为空，结束安装。"
    fi
    sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "${ENV_FILE}"
    log "已写入域名 ${DOMAIN} 到 ${ENV_FILE}。"
  else
    die "DOMAIN 仍是示例 example.com 且当前非交互终端。请先编辑 ${ENV_FILE} 把 DOMAIN 改为真实域名后重跑（或直接在终端 sudo bash install.sh 交互式安装）。"
  fi
fi

changed=0
if [ -z "${NODE_TOKEN:-}" ] || [ "${NODE_TOKEN}" = "CHANGE_ME_LONG_RANDOM" ]; then
  NODE_TOKEN="$(openssl rand -hex 16)"; sed -i "s|^NODE_TOKEN=.*|NODE_TOKEN=${NODE_TOKEN}|" "${ENV_FILE}"; changed=1
  log "已生成随机 NODE_TOKEN(订阅密钥目录段)。"
fi
if [ -z "${FB_SUB_FILE:-}" ] || [ "${FB_SUB_FILE}" = "CHANGE_ME_SUBFILE" ]; then
  FB_SUB_FILE="$(openssl rand -hex 8)"
  grep -q '^FB_SUB_FILE=' "${ENV_FILE}" && sed -i "s|^FB_SUB_FILE=.*|FB_SUB_FILE=${FB_SUB_FILE}|" "${ENV_FILE}" || echo "FB_SUB_FILE=${FB_SUB_FILE}" >> "${ENV_FILE}"
  log "已生成随机 FB_SUB_FILE(订阅文件名，防嗅探)。"
fi
if [ -z "${AUTH_PASS:-}" ] || [ "${AUTH_PASS}" = "CHANGE_ME_STRONG_PASSWORD" ]; then
  AUTH_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"; sed -i "s|^AUTH_PASS=.*|AUTH_PASS=${AUTH_PASS}|" "${ENV_FILE}"; changed=1
  log "已生成随机 AUTH_PASS，请前往 ${ENV_FILE} 查看(勿外泄)。"
fi
[ "${changed}" -eq 1 ] && chmod 600 "${ENV_FILE}"

: "${DOMAIN:?DOMAIN 未设置}"
: "${AUTH_USER:?AUTH_USER 未设置}"
export FB_TCP_PORT="${FB_TCP_PORT:-443}" FB_ACME_PORT="${FB_ACME_PORT:-80}" FB_CERT_CACHE="${FB_CERT_CACHE:-${DATA_DIR}/certcache}" FB_PROXY_ALLOW="${FB_PROXY_ALLOW:-on}" FB_PROXY_ALLOW_TTL_HOURS="${FB_PROXY_ALLOW_TTL_HOURS:-720}"

# 确保 .env 内含白名单开关，避免与程序默认值漂移
grep -q '^FB_PROXY_ALLOW=' "${ENV_FILE}" || echo "FB_PROXY_ALLOW=${FB_PROXY_ALLOW}" >> "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# ---------- 2) 预检域名解析 ----------
if ! getent ahosts "${DOMAIN}" >/dev/null 2>&1; then
  warn "域名未生效：${DOMAIN} 无法解析。autocert 申请证书会失败。"
  warn "请将域名 A 记录指向本机公网 IP 后重跑（服务会受控重试）。"
else
  log "域名解析正常：${DOMAIN} -> $(getent ahosts "${DOMAIN}" | awk '{print $1; exit}')"
fi

# ---------- 3) 架构 + 二进制获取 ----------
MARCH="$(uname -m)"
case "${MARCH}" in
  x86_64|amd64)  FB_ARCH=amd64 ;;
  aarch64|arm64) FB_ARCH=arm64 ;;
  *) die "不支持的架构 ${MARCH}（仅 amd64/arm64）" ;;
esac
export FB_ARCH
BIN_MODE="${FB_BIN_MODE:-prebuilt}"
log "架构 ${FB_ARCH}，二进制模式 ${BIN_MODE}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y curl openssl >/dev/null 2>&1 || true

# 更新场景：覆盖二进制前先停旧服务，避免 "Text file busy"
systemctl stop flowbrowse 2>/dev/null || true

download_prebuilt() {
  local base="${FB_DL_BASE:-}" repo="${FB_REPO:-}"
  [ -z "${base}" ] && [ -n "${repo}" ] && base="https://github.com/${repo}/releases/latest/download"
  [ -z "${base}" ] && { warn "未配置 FB_REPO/FB_DL_BASE"; return 1; }
  log "下载预编译二进制(arch ${FB_ARCH})：${base}"
  curl -fL --retry 3 "${base}/flowbrowse-server-linux-${FB_ARCH}" -o "${SERVER_BIN}" || { warn "下载失败"; return 1; }
  chmod +x "${SERVER_BIN}"
  return 0
}

ensure_go_toolchain() {
  if command -v go >/dev/null 2>&1; then
    local gov; gov="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
    if printf '%s\n1.26\n' "${gov}" | sort -V | head -1 | grep -q '^1.26$'; then log "已存在 Go ${gov}。"; return 0; fi
  fi
  local GO_VER; GO_VER="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)"
  log "安装 Go ${GO_VER} ..."
  curl -fsSL "https://go.dev/dl/${GO_VER}.linux-${FB_ARCH}.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
}

build_from_source() {
  ensure_go_toolchain
  export PATH="/usr/local/go/bin:${PATH}"; export GOPATH="${GOPATH:-/root/go}"
  apt-get install -y build-essential >/dev/null 2>&1 || true
  log "本地编译 flowbrowse-server ..."
  cd "${SCRIPT_DIR}/flowbrowse"
  go mod tidy
  CGO_ENABLED=0 go build -o "${SERVER_BIN}" .
}

mkdir -p "${BIN_DIR}"
case "${BIN_MODE}" in
  prebuilt) download_prebuilt || die "预编译下载失败：请确认已推送并打 v* tag 触发 Actions 生成 Release，且 FB_REPO/FB_DL_BASE 正确（本模式不在服务器编译）" ;;
  build)    build_from_source ;;
  *)        download_prebuilt || { warn "预编译不可用，回退本地编译"; build_from_source; } ;;
esac
[ -x "${SERVER_BIN}" ] || die "未取得可执行二进制"

# ---------- 4) 用户/目录/systemd ----------
id -u flowbrowse >/dev/null 2>&1 || useradd --system --home-dir /var/lib/flowbrowse --shell /usr/sbin/nologin flowbrowse
mkdir -p "${DATA_DIR}" "${FB_CERT_CACHE}" "${FB_WEB_ROOT}"
chown -R flowbrowse:flowbrowse "${DATA_DIR}" "${FB_CERT_CACHE}"

# quic-go 官方建议调大 UDP 接收/发送缓冲区，否则 WebTransport(QUIC) 握手 Initial 包易丢→"Opening handshake failed"
cat > /etc/sysctl.d/99-flowbrowse.conf <<'SYSCTL'
net.core.rmem_max = 7550000
net.core.rmem_default = 7550000
net.core.wmem_max = 7550000
SYSCTL
sysctl --system >/dev/null 2>&1 || true
log "已设置 UDP 缓冲区(sysctl)以保障 QUIC 握手"

install -m 644 "${SCRIPT_DIR}/systemd/flowbrowse.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable flowbrowse >/dev/null 2>&1 || true

# ---------- 5) 生成订阅（先起服务可能还没证书，订阅文件独立生成）----------
log "生成订阅文件..."
SUB_OUT="$(AUTH_USER="${AUTH_USER}" AUTH_PASS="${AUTH_PASS}" DOMAIN="${DOMAIN}" \
  FB_TCP_PORT="${FB_TCP_PORT}" NODE_TOKEN="${NODE_TOKEN}" FB_SUB_FILE="${FB_SUB_FILE}" \
  NODE_NAME="${NODE_NAME:-FlowBrowse}" NODE_REGION="${NODE_REGION:-N/A}" FB_WEB_ROOT="${FB_WEB_ROOT}" \
  bash "${SCRIPT_DIR}/scripts/gen-sub-link.sh")"
chown -R flowbrowse:flowbrowse "${FB_WEB_ROOT}"
echo "${SUB_OUT}"

systemctl restart flowbrowse

SUB_URL="$(echo "${SUB_OUT}" | sed -n 's/^SUB_URL=//p')"
FB_LINK="$(echo "${SUB_OUT}" | sed -n 's/^FB_LINK=//p')"

cat <<EOF

=================== FlowBrowse 安装完成 ===================
站点+代理(共用)   : ${DOMAIN}:${FB_TCP_PORT}  (TCP 443；CONNECT=代理、GET=订阅/首页)
IP 白名单         : ${FB_PROXY_ALLOW}（拉过订阅的 IP 自动放行，TTL ${FB_PROXY_ALLOW_TTL_HOURS}h）
ACME(证书)        : ${DOMAIN}:${FB_ACME_PORT} -> Let's Encrypt 自动申请/续期

订阅地址(粘贴进插件"订阅管理")：
  ${SUB_URL}
单节点链接(可直接手动添加)：
  ${FB_LINK}

⚠️ 链接内嵌代理凭据属敏感信息，勿公开分享。
⚠️ 若之前提示"域名未生效"，证书/服务可能仍在重试；DNS 生效后：systemctl restart flowbrowse
可用 bash status.sh 查看服务与证书状态；日常操作用 bash flowbrowse.sh（菜单）。
===========================================================
EOF
