#!/usr/bin/env bash
# install.sh —— FlowBrowse 服务端一键安装
#
# 做什么 & 为什么：
#   1) 安装/复用 Go 工具链：Caddy(forwardproxy 插件) 与 WebTransport 服务都用 Go 编译，服务器需具备 Go。
#   2) 编译带 forwardproxy 的 Caddy：Chrome 主干走 https 转发代理，需要 forward_proxy 模块。
#   3) 构建 WebTransport 服务：提供真 QUIC/h3 通道（测速/信令）。
#   4) 布置配置/systemd/静态站点：域名、端口、凭据全部来自 /etc/flowbrowse/.env，零硬编码。
#   5) 预检域名解析并在未生效时给出中文提示：LE 证书申请依赖域名已指向本机。
#   6) 生成订阅文件并打印订阅地址与 fb:// 链接，供插件粘贴导入。
#
# 用法：sudo bash install.sh   （可重复执行，幂等：占位凭据会自动补齐并写回 .env）
set -euo pipefail

# ---------- 基本路径与常量 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/flowbrowse/.env"
CADDYFILE_DST="/etc/flowbrowse/Caddyfile"
BIN_DIR="/opt/flowbrowse/bin"
WEB_ROOT_DEFAULT="/srv/flowbrowse"

log()  { printf '\033[1;36m[FlowBrowse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[FlowBrowse][警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FlowBrowse][错误]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 前置：root 与系统检查 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"
. /etc/os-release 2>/dev/null || true
log "目标系统：${PRETTY_NAME:-unknown}  架构：$(uname -m)"

# ---------- 1) 准备 /etc/flowbrowse/.env（不存在则从示例创建）----------
mkdir -p /etc/flowbrowse
if [ ! -f "${ENV_FILE}" ]; then
  cp "${SCRIPT_DIR}/config/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  warn "已生成默认 ${ENV_FILE}，其中 AUTH_PASS / NODE_TOKEN 为占位值，脚本会自动补齐随机值；也可自行编辑后重跑。"
fi

# 载入 .env 到当前 shell
set -a; . "${ENV_FILE}"; set +a
export FB_WEB_ROOT="${FB_WEB_ROOT:-$WEB_ROOT_DEFAULT}"

# ---------- 自动补齐占位密钥（提升一键体验，同时避免真实口令写入仓库）----------
changed_env=0
# NODE_TOKEN 同时作为订阅"密钥路径段"，必须是 URL 友好的随机串
if [ -z "${NODE_TOKEN:-}" ] || [ "${NODE_TOKEN}" = "CHANGE_ME_LONG_RANDOM" ]; then
  NODE_TOKEN="$(openssl rand -hex 16)"
  sed -i "s|^NODE_TOKEN=.*|NODE_TOKEN=${NODE_TOKEN}|" "${ENV_FILE}"
  changed_env=1
  log "已自动生成随机 NODE_TOKEN（订阅密钥路径段）。"
fi
# AUTH_PASS 若为占位则生成随机强口令，稍后提示到 .env 查看
if [ -z "${AUTH_PASS:-}" ] || [ "${AUTH_PASS}" = "CHANGE_ME_STRONG_PASSWORD" ]; then
  AUTH_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  sed -i "s|^AUTH_PASS=.*|AUTH_PASS=${AUTH_PASS}|" "${ENV_FILE}"
  changed_env=1
  log "已自动生成随机 AUTH_PASS，请前往 ${ENV_FILE} 查看（切勿外泄）。"
fi
[ "${changed_env}" -eq 1 ] && chmod 600 "${ENV_FILE}"

# FB_SUB_FILE：订阅文件名（防嗅探）——占位/缺失则随机、无扩展名；也支持自定义
if [ -z "${FB_SUB_FILE:-}" ] || [ "${FB_SUB_FILE}" = "CHANGE_ME_SUBFILE" ]; then
  FB_SUB_FILE="$(openssl rand -hex 8)"
  if grep -q '^FB_SUB_FILE=' "${ENV_FILE}"; then
    sed -i "s|^FB_SUB_FILE=.*|FB_SUB_FILE=${FB_SUB_FILE}|" "${ENV_FILE}"
  else
    echo "FB_SUB_FILE=${FB_SUB_FILE}" >> "${ENV_FILE}"
  fi
  log "已自动生成随机订阅文件名 FB_SUB_FILE（防被嗅探/枚举）。"
fi

: "${DOMAIN:?DOMAIN 未设置}"
: "${AUTH_USER:?AUTH_USER 未设置}"
export FB_TCP_PORT="${FB_TCP_PORT:-443}" FB_WT_PORT="${FB_WT_PORT:-443}" ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

# ---------- 5a) 预检域名解析（证书申请依赖它，未生效给中文提示但不中断）----------
if ! getent ahosts "${DOMAIN}" >/dev/null 2>&1; then
  warn "域名未生效：${DOMAIN} 当前无法解析。证书申请很可能失败。"
  warn "请将域名 A 记录指向本机公网 IP 后重跑 install.sh（服务会以受控方式自动重试签发）。"
else
  log "域名解析正常：${DOMAIN} -> $(getent ahosts "${DOMAIN}" | awk '{print $1; exit}')"
fi

# ---------- 2) 架构检测 + 二进制获取（优先下载预编译，回退本地编译）----------
# 为什么：预编译二进制由 GitHub Actions 产出，服务器无需装 Go/编译，秒级完成且天然支持 amd64/arm64；
#       下载不可用时回退本地编译，保证任何环境都能装上。
MARCH="$(uname -m)"
case "${MARCH}" in
  x86_64|amd64)  FB_ARCH=amd64 ;;
  aarch64|arm64) FB_ARCH=arm64 ;;
  *) die "不支持的架构 ${MARCH}（仅支持 amd64 / arm64）" ;;
esac
export FB_ARCH
log "本机架构：${FB_ARCH}"

# 取二进制方式：prebuilt=仅从 GitHub Release 下载预编译(默认，服务器不编译) | auto=先下后编译 | build=仅本地编译
# 默认 prebuilt：按用户要求，二进制由 GitHub Actions 编译，服务器不本地编译。
BIN_MODE="${FB_BIN_MODE:-prebuilt}"
export DEBIAN_FRONTEND=noninteractive
# 基础工具：curl 供下载/证书校验，openssl 供证书检查（编译模式再额外装 build-essential）
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y curl openssl >/dev/null 2>&1 || true

CADDY_BIN_PATH="/usr/local/bin/caddy"
WT_BIN_PATH="${BIN_DIR}/flowbrowse-wt"
mkdir -p "${BIN_DIR}"

# download_prebuilt：从 GitHub Release 拉取对应架构二进制（仓库/基址可用 .env 覆盖）
download_prebuilt() {
  local base="${FB_DL_BASE:-}"
  local repo="${FB_REPO:-}"
  # 未显式给基址时，用仓库 latest release 的直链约定
  [ -z "${base}" ] && [ -n "${repo}" ] && base="https://github.com/${repo}/releases/latest/download"
  if [ -z "${base}" ]; then warn "未配置 FB_REPO / FB_DL_BASE，无法下载预编译二进制"; return 1; fi
  log "下载预编译二进制(架构 ${FB_ARCH})：${base}"
  curl -fL --retry 3 "${base}/flowbrowse-caddy-linux-${FB_ARCH}"  -o "${CADDY_BIN_PATH}" || { warn "下载 caddy 失败"; return 1; }
  curl -fL --retry 3 "${base}/flowbrowse-wt-linux-${FB_ARCH}"      -o "${WT_BIN_PATH}"   || { warn "下载 webtransport 失败"; return 1; }
  chmod +x "${CADDY_BIN_PATH}" "${WT_BIN_PATH}"
  # 校验下载的 caddy 确含 forward_proxy 模块，避免拿到无插件的普通 caddy
  "${CADDY_BIN_PATH}" list-modules | grep -q forward_proxy || { warn "下载的 caddy 不含 forward_proxy"; return 1; }
  log "预编译二进制就绪：caddy=$(${CADDY_BIN_PATH} version 2>/dev/null | head -1) wt=${WT_BIN_PATH}"
  return 0
}

# ensure_go_toolchain：仅本地编译模式才需要 Go，按需安装官方最新版
ensure_go_toolchain() {
  if command -v go >/dev/null 2>&1; then
    local gov; gov="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
    if printf '%s\n1.23\n' "${gov}" | sort -V | head -1 | grep -q '^1.23$'; then
      log "已存在 Go ${gov}，满足要求。"; return 0
    fi
  fi
  local GO_VER; GO_VER="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)"
  log "安装 Go ${GO_VER}（官方 tarball）到 /usr/local/go ..."
  curl -fsSL "https://go.dev/dl/${GO_VER}.linux-${FB_ARCH}.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  log "Go 安装完成：$(go version)"
}

# build_from_source：本地编译带 forwardproxy 的 Caddy 与 WebTransport 服务
build_from_source() {
  ensure_go_toolchain
  export PATH="/usr/local/go/bin:${PATH}"
  export GOPATH="${GOPATH:-/root/go}"
  log "编译 Caddy（集成 klzgrad/forwardproxy）..."
  apt-get install -y build-essential gnupg >/dev/null 2>&1 || apt-get install -y build-essential gnupg
  GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
  cd /tmp
  xcaddy build \
    --with github.com/caddyserver/forwardproxy@caddy2=github.com/klzgrad/forwardproxy@naive \
    --output "${CADDY_BIN_PATH}"
  "${CADDY_BIN_PATH}" list-modules | grep -q forward_proxy || die "Caddy 未集成 forward_proxy 模块，编译异常"
  log "Caddy 就绪：$(${CADDY_BIN_PATH} version)"
  log "构建 WebTransport 服务..."
  cd "${SCRIPT_DIR}/webtransport"
  go mod tidy
  go build -o "${WT_BIN_PATH}" .
  log "WebTransport 二进制就绪：${WT_BIN_PATH}"
}

case "${BIN_MODE}" in
  prebuilt) download_prebuilt || die "预编译下载失败：请确认已把代码推送到 GitHub、打了 v* tag 触发 Actions 生成 Release，且 FB_REPO/FB_DL_BASE 正确（本模式不会在服务器编译）" ;;
  build)    build_from_source ;;
  *)        download_prebuilt || { warn "预编译不可用，回退本地编译"; build_from_source; } ;;
esac

# ---------- 布置证书复用路径（指向 Caddy 数据目录里签发的 LE 证书）----------
CERT_DIR="/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}/${DOMAIN}"
if ! grep -q '^FB_CERT=' "${ENV_FILE}"; then
  { echo "FB_CERT=${CERT_DIR}.crt"; echo "FB_KEY=${CERT_DIR}.key"; } >> "${ENV_FILE}"
else
  sed -i "s|^FB_CERT=.*|FB_CERT=${CERT_DIR}.crt|; s|^FB_KEY=.*|FB_KEY=${CERT_DIR}.key|" "${ENV_FILE}"
fi
set -a; . "${ENV_FILE}"; set +a
log "证书复用路径已写入 .env（Caddy 签发后 Go 服务读取同一套）。"

# ---------- 复制配置与静态站点 ----------
# Caddyfile：把仓库模板放到 /etc/flowbrowse，域名/端口/凭据用 {$VAR} 由 Caddy 运行时展开
cp "${SCRIPT_DIR}/caddy/Caddyfile" "${CADDYFILE_DST}"
chmod 644 "${CADDYFILE_DST}"
# 站点根：保持为空，不放任何自定义首页（避免 /index.html 泄露指纹）。
# 根路径的“默认页”由 Caddyfile 的 `respond "" 200` 复刻原生 Caddy 默认行为（空 200）。
mkdir -p "${FB_WEB_ROOT}"
rm -f "${FB_WEB_ROOT}/index.html"   # 清理历史遗留，确保站点内无自定义 HTML 可被访问

# ---------- 创建 caddy 系统用户与服务身份 ----------
id -u caddy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy "${FB_WEB_ROOT}"

# ---------- 安装 systemd 单元 ----------
log "安装 systemd 单元..."
install -m 644 "${SCRIPT_DIR}/systemd/flowbrowse-caddy.service" /etc/systemd/system/
install -m 644 "${SCRIPT_DIR}/systemd/flowbrowse-wt.service" /etc/systemd/system/
install -m 644 "${SCRIPT_DIR}/systemd/flowbrowse-wt-reload.service" /etc/systemd/system/
install -m 644 "${SCRIPT_DIR}/systemd/flowbrowse-wt-reload.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now flowbrowse-caddy.service
systemctl enable --now flowbrowse-wt.service
systemctl enable --now flowbrowse-wt-reload.timer

# ---------- 6) 生成订阅文件并打印结果 ----------
log "生成订阅文件..."
SUB_OUT="$(AUTH_USER="${AUTH_USER}" AUTH_PASS="${AUTH_PASS}" DOMAIN="${DOMAIN}" \
  FB_TCP_PORT="${FB_TCP_PORT}" FB_WT_PORT="${FB_WT_PORT}" NODE_TOKEN="${NODE_TOKEN}" FB_SUB_FILE="${FB_SUB_FILE}" \
  NODE_NAME="${NODE_NAME:-FlowBrowse}" NODE_REGION="${NODE_REGION:-N/A}" FB_WEB_ROOT="${FB_WEB_ROOT}" \
  bash "${SCRIPT_DIR}/scripts/gen-sub-link.sh")"
chown -R caddy:caddy "${FB_WEB_ROOT}"
echo "${SUB_OUT}"

SUB_URL="$(echo "${SUB_OUT}" | sed -n 's/^SUB_URL=//p')"
FB_LINK="$(echo "${SUB_OUT}" | sed -n 's/^FB_LINK=//p')"

cat <<EOF

=================== FlowBrowse 安装完成 ===================
主干 HTTPS 代理 : ${DOMAIN}:${FB_TCP_PORT}  (TCP, Caddy forwardproxy)
QUIC 通道       : ${DOMAIN}:${FB_WT_PORT}  (UDP, WebTransport)

订阅地址(粘贴进插件"订阅管理")：
  ${SUB_URL}

单节点链接(可直接手动添加)：
  ${FB_LINK}

⚠️ 上面链接内嵌代理凭据，属敏感信息，请勿公开分享。
⚠️ 若之前提示"域名未生效"，证书可能仍在重试；DNS 生效后执行：
     systemctl restart flowbrowse-caddy && cat ${ENV_FILE}
可用 bash status.sh 查看服务与证书状态。
===========================================================
EOF
