// rules.js —— 分流规则加载 + PAC 生成
// 为什么用 PAC 的 `HTTPS host:port` 关键字：主干是 TLS 转发代理（防嗅探的关键），
//   PAC 里若用 `PROXY host:port` 会被 Chrome 当作明文 HTTP 代理去连 443，导致握手失败；
//   `HTTPS host:port` 才会让 Chrome 对代理建立 TLS 连接。国内命中则返回 DIRECT（直连不出网，减小足迹）。

// 内置列表文件（打包进扩展；可被"远程更新"覆盖，见 loadCnData）
const BUNDLED_DOMAINS = 'rules/cn-domains.txt';
const BUNDLED_CIDRS = 'rules/cn-ip-cidr.txt';

// 读取纯文本列表：忽略空行与 # 注释
async function readList(url) {
  const resp = await fetch(chrome.runtime.getURL(url));
  const text = await resp.text();
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// 加载 CN 域名后缀与 IP CIDR：优先用户在设置里配置的远程 URL（rulesRemoteEnabled），否则用内置
export async function loadCnData(settings = {}) {
  let domains, cidrs;
  if (settings.rulesRemoteEnabled && settings.rulesRemoteUrlDomains && settings.rulesRemoteUrlCidrs) {
    try {
      // 远程更新：拉取最新 geosite/geoip 派生的精简列表（见 docs/RULES_FORMAT.md 更新方式）
      const [d, c] = await Promise.all([fetch(settings.rulesRemoteUrlDomains).then((r) => r.text()), fetch(settings.rulesRemoteUrlCidrs).then((r) => r.text())]);
      domains = d.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
      cidrs = c.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    } catch (e) {
      console.warn('[FlowBrowse] 远程规则拉取失败，回退内置：', e);
      domains = await readList(BUNDLED_DOMAINS);
      cidrs = await readList(BUNDLED_CIDRS);
    }
  } else {
    domains = await readList(BUNDLED_DOMAINS);
    cidrs = await readList(BUNDLED_CIDRS);
  }
  return { domains, cidrs };
}

// 把字符串数组安全内联进 PAC 源码（JSON 转义，避免注入与语法错误）
function js(arr) { return JSON.stringify(arr); }

// 生成 PAC 脚本
//   proxyHost/proxyPort：主干 HTTPS 转发代理（完全来自节点/设置，无硬编码域名）
//   mode：'global' 全走代理 | 'split' 国内外分流
export function buildPac(proxyHost, proxyPort, mode, cnData) {
  const proxyLine = `HTTPS ${proxyHost}:${proxyPort}`;

  // 全局模式：除本地/内网外一律走代理，无需嵌入 CN 列表
  if (mode === 'global') {
    return `
function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === '127.0.0.1' || host === 'localhost') return 'DIRECT';
  if (shExpMatch(host, '10.*') || shExpMatch(host, '192.168.*') || shExpMatch(host, '172.16.*')) return 'DIRECT';
  return '${proxyLine}';
}
`.trim();
  }

  // 分流模式：内联 CN 域名后缀与 IP CIDR，命中即 DIRECT，其余 PROXY
  // 重要：PAC 数据串必须为纯 ASCII（chrome.proxy 限制 pacScript.data 仅支持 ASCII），故下方模板内的注释一律用英文。
  return `
// ==== FlowBrowse auto-generated split PAC (do not edit by hand) ====
var CN_DOMAINS = ${js(cnData.domains)};
var CN_CIDRS = ${js(cnData.cidrs)};

// Convert dotted IPv4 to a 32-bit unsigned integer
function ip2long(ip) {
  var parts = ip.split('.');
  if (parts.length !== 4) return null;
  var n = 0;
  for (var i = 0; i < 4; i++) {
    var o = parseInt(parts[i], 10);
    if (isNaN(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

// Whether an IP-literal host falls inside any CN CIDR
function inCnCidr(host) {
  var ip = ip2long(host);
  if (ip === null) return false;
  for (var i = 0; i < CN_CIDRS.length; i++) {
    var seg = CN_CIDRS[i].split('/');
    var base = ip2long(seg[0]);
    var len = parseInt(seg[1], 10);
    if (base === null || isNaN(len)) continue;
    var mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    if ((ip & mask) === (base & mask)) return true;
  }
  return false;
}

// Whether a host matches a CN domain suffix (exact + subdomain)
function inCnDomain(host) {
  host = host.toLowerCase();
  for (var i = 0; i < CN_DOMAINS.length; i++) {
    var d = CN_DOMAINS[i].toLowerCase().replace(/^\\./, '');
    if (d === '') continue;
    if (host === d || host.length > d.length && host.slice(-d.length - 1) === '.' + d) return true;
  }
  return false;
}

function FindProxyForURL(url, host) {
  // Local / loopback / private ranges always connect directly
  if (isPlainHostName(host) || host === '127.0.0.1' || host === 'localhost' || host === '::1') return 'DIRECT';
  if (shExpMatch(host, '10.*') || shExpMatch(host, '192.168.*') ||
      shExpMatch(host, '172.16.*') || shExpMatch(host, '172.17.*') ||
      shExpMatch(host, '172.18.*') || shExpMatch(host, '172.19.*') || shExpMatch(host, '172.2*') ||
      shExpMatch(host, '172.30.*') || shExpMatch(host, '172.31.*')) return 'DIRECT';

  // IP literal by CIDR, domain by suffix; CN => DIRECT, otherwise via HTTPS(TLS) proxy
  if (inCnCidr(host)) return 'DIRECT';
  if (inCnDomain(host)) return 'DIRECT';

  return '${proxyLine}';
}
`.trim();
}
