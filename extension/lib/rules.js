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

// 健壮解析远程规则文本：兼容三种常见格式——纯文本、Clash YAML（`payload:` + `- 'x'`）、`DOMAIN-SUFFIX,x` 行。
// kind='domain' 取域名；kind='cidr' 取 IPv4 CIDR。无法识别的行自动跳过。
function parseRuleText(text, kind) {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line === 'payload:') continue;
    line = line.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').trim(); // 去 YAML 列表符号与引号
    if (!line) continue;
    // Clash 规则行 TYPE,value —— 仅取域名/地理相关类型
    const m = line.match(/^([A-Za-z][A-Za-z-]*),(.*)$/);
    if (m) {
      if (!/DOMAIN|GEODOMAIN|GEOIP|IP-CIDR/i.test(m[1])) continue;
      line = m[2].trim();
    }
    if (kind === 'cidr') {
      if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(line)) out.push(line);
    } else {
      if (/^\d+\.\d+\.\d+\.\d+/.test(line)) continue; // 域名列表里跳过 IP 行
      out.push(line.replace(/^\./, ''));
    }
  }
  return out;
}

// 拉取远程文本并解析为指定类型列表
async function fetchRemoteList(url, kind) {
  const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parseRuleText(await resp.text(), kind);
}

// 加载 CN 域名后缀与 IP CIDR：域名/CIDR 各取所需——
//   设了远程 URL 就用远程（解析健壮），否则用内置。允许只远程 CIDR、域名仍用内置。
export async function loadCnData(settings = {}) {
  let domains, cidrs;
  const enabled = settings.rulesRemoteEnabled;

  // 域名：远程优先，失败/未配置回退内置
  if (enabled && settings.rulesRemoteUrlDomains) {
    try { domains = await fetchRemoteList(settings.rulesRemoteUrlDomains, 'domain'); }
    catch (e) { console.warn('[FlowBrowse] 远程域名规则失败，回退内置:', e); domains = await readList(BUNDLED_DOMAINS); }
  } else {
    domains = await readList(BUNDLED_DOMAINS);
  }

  // CIDR：远程优先，失败/未配置回退内置
  if (enabled && settings.rulesRemoteUrlCidrs) {
    try { cidrs = await fetchRemoteList(settings.rulesRemoteUrlCidrs, 'cidr'); }
    catch (e) { console.warn('[FlowBrowse] 远程IP规则失败，回退内置:', e); cidrs = await readList(BUNDLED_CIDRS); }
  } else {
    cidrs = await readList(BUNDLED_CIDRS);
  }

  return { domains, cidrs };
}

// 把字符串数组安全内联进 PAC 源码（JSON 转义，避免注入与语法错误）
function js(arr) { return JSON.stringify(arr); }

// 生成时预计算 CIDR → [base, mask] 数值对，避免 PAC 每请求对 6000+ 条重复 ip2long（性能关键）
function toNetPairs(cidrs) {
  const pairs = [];
  for (const c of cidrs) {
    const seg = String(c).split('/');
    const oct = seg[0].split('.');
    const len = parseInt(seg[1], 10);
    if (oct.length !== 4 || isNaN(len)) continue;
    let base = 0, bad = false;
    for (let i = 0; i < 4; i++) { const o = parseInt(oct[i], 10); if (isNaN(o) || o < 0 || o > 255) { bad = true; break; } base = ((base << 8) | o) >>> 0; }
    if (bad) continue;
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    pairs.push([(base & mask) >>> 0, mask]);
  }
  return pairs;
}

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

  // 分流模式：内联 CN 域名后缀 + 预计算好的 IP 网段数值对，命中即 DIRECT，其余 PROXY
  // 重要：PAC 数据串必须为纯 ASCII（chrome.proxy 限制 pacScript.data 仅支持 ASCII），故模板内注释一律用英文。
  const nets = toNetPairs(cnData.cidrs);
  return `
// ==== FlowBrowse auto-generated split PAC (do not edit by hand) ====
var CN_DOMAINS = ${js(cnData.domains)};
var CN_NETS = ${js(nets)}; // [base, mask] precomputed

// Convert dotted IPv4 to a 32-bit unsigned integer (host only)
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

// IP-literal host in any CN net? (integer compare over precomputed pairs)
function inCnCidr(host) {
  var ip = ip2long(host);
  if (ip === null) return false;
  for (var i = 0; i < CN_NETS.length; i++) {
    if ((ip & CN_NETS[i][1]) === CN_NETS[i][0]) return true;
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
