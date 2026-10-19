#!/usr/bin/env bash
# gen-sub-link.sh —— 生成 FlowBrowse 节点订阅文件与链接
#
# 功能：根据环境变量拼出 fb:// 节点链接，写入两处静态订阅文件（文件名均为随机/可自定义，防被嗅探枚举）：
#       - $FB_WEB_ROOT/$NODE_TOKEN/$FB_SUB_FILE      （多条 fb:// 换行拼接后 base64，兼容主流订阅客户端）
#       - $FB_WEB_ROOT/$NODE_TOKEN/$FB_SUB_FILE.json  （结构化节点信息，可选）
#       并把"完整订阅地址"和"单节点 fb:// 链接"打印到标准输出，供 install.sh 展示给用户粘贴进插件。
#
# 为什么要静态文件 + 密钥路径 + 随机文件名：$NODE_TOKEN 为不可猜路径段、$FB_SUB_FILE 为不可猜文件名，Caddy file_server 直接服务，
#       无需动态后端与条件匹配，最简可靠；未知 token/文件名命中不到即 404，整条 URL 不可预测以防被嗅探/枚举。
#
# 依赖环境变量（均由 .env 提供，域名/端口零硬编码）：
#   DOMAIN, FB_TCP_PORT, FB_WT_PORT, AUTH_USER, AUTH_PASS, NODE_TOKEN(=密钥路径段), NODE_NAME, NODE_REGION
set -euo pipefail

# ---- 读取配置，端口给出合理默认 ----
DOMAIN="${DOMAIN:?DOMAIN 未设置}"
FB_TCP_PORT="${FB_TCP_PORT:-443}"
FB_WT_PORT="${FB_WT_PORT:-443}"
AUTH_USER="${AUTH_USER:?AUTH_USER 未设置}"
AUTH_PASS="${AUTH_PASS:?AUTH_PASS 未设置}"
NODE_TOKEN="${NODE_TOKEN:?NODE_TOKEN 未设置}"
FB_SUB_FILE="${FB_SUB_FILE:?FB_SUB_FILE 未设置}"
NODE_NAME="${NODE_NAME:-FlowBrowse}"
NODE_REGION="${NODE_REGION:-N/A}"
FB_WEB_ROOT="${FB_WEB_ROOT:-/srv/flowbrowse}"

# URL 编码函数：把用户名/密码/名称等可能含特殊字符的字段安全嵌入 fb:// 链接。
# 原因：fb:// 借鉴 hy2 的 URI 结构，userinfo 与 query 值需百分号编码，否则解析歧义（如密码含 @ / 会混淆 host）。
# 注意：必须按 UTF-8 字节编码。早期用 printf '%02X' 对中文按码点编码会产出非法的 %XXXX，
#       改用 python3 urllib.parse.quote（Ubuntu 24.04 自带 python3），保证中文/特殊字符正确转义。
urlencode() {
  python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

# 名称支持中文，需 URL 编码后放入 name= 查询参数
NAME_ENC="$(urlencode "$NODE_NAME")"
REGION_ENC="$(urlencode "$NODE_REGION")"
USER_ENC="$(urlencode "$AUTH_USER")"
PASS_ENC="$(urlencode "$AUTH_PASS")"

# 组装单条 fb:// 链接（格式规范见 docs/RULES_FORMAT.md）
FB_LINK="fb://${USER_ENC}:${PASS_ENC}@${DOMAIN}:${FB_TCP_PORT}/?udp=${FB_WT_PORT}&region=${REGION_ENC}&name=${NAME_ENC}"

# 订阅地址：走密钥路径段 $NODE_TOKEN + 随机文件名 $FB_SUB_FILE（整条路径不可猜，防嗅探/枚举）
SUB_URL="https://${DOMAIN}:${FB_TCP_PORT}/${NODE_TOKEN}/${FB_SUB_FILE}"

# ---- 写入静态订阅文件 ----
SUB_DIR="${FB_WEB_ROOT}/${NODE_TOKEN}"
mkdir -p "${SUB_DIR}"
# 目录权限收紧到仅属主可读，避免其它用户枚举密钥目录（纵深防御）
chmod 700 "${SUB_DIR}"

# b64：单条链接即可 base64（多条时用换行拼接）；文件名用随机 $FB_SUB_FILE，无固定扩展名指纹
printf '%s\n' "${FB_LINK}" | base64 -w0 > "${SUB_DIR}/${FB_SUB_FILE}"
chmod 600 "${SUB_DIR}/${FB_SUB_FILE}"

# json：结构化，注意 has_pass 仅标记是否存在密码，绝不写出真实密码
printf '{\n  "nodes": [\n    {\n      "name": "%s",\n      "region": "%s",\n      "host": "%s",\n      "tcp_port": %s,\n      "udp_port": %s,\n      "scheme": "https",\n      "user": "%s",\n      "has_pass": true\n    }\n  ]\n}\n' \
  "${NODE_NAME}" "${NODE_REGION}" "${DOMAIN}" "${FB_TCP_PORT}" "${FB_WT_PORT}" "${USER_ENC}" > "${SUB_DIR}/${FB_SUB_FILE}.json"
chmod 600 "${SUB_DIR}/${FB_SUB_FILE}.json"

# ---- 输出结果供 install.sh 展示 ----
echo "SUB_URL=${SUB_URL}"
echo "FB_LINK=${FB_LINK}"
