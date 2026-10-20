// rules.js —— 分流规则加载 + PAC 生成
// 为什么用 PAC 的 `HTTPS host:port` 关键字：主干是 TLS 转发代理（防嗅探的关键），
//   PAC 里若用 `PROXY host:port` 会被 Chrome 当作明文 HTTP 代理去连 443，导致握手失败；
//   `HTTPS host:port` 才会让 Chrome 对代理建立 TLS 连接。国内命中则返回 DIRECT（直连不出网，减小足迹）。
import { getRulesCache, saveRulesCache } from './config.js';

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

// 加载 CN 域名后缀与 IP CIDR：优先用“立即更新”缓存下来的远程规则（离线可用、连接时不走网络），
//   未开启远程或无缓存则用内置。连接热路径只读本地，不 fetch。
export async function loadCnData(settings = {}) {
  let domains = await readList(BUNDLED_DOMAINS);
  let cidrs = await readList(BUNDLED_CIDRS);
  if (settings.rulesRemoteEnabled) {
    const cache = await getRulesCache();
    if (cache) {
      if (Array.isArray(cache.domains) && cache.domains.length) domains = cache.domains;
      if (Array.isArray(cache.cidrs) && cache.cidrs.length) cidrs = cache.cidrs;
    }
  }
  return { domains, cidrs };
}

// 立即更新：拉取远程域名/IP 列表并写入缓存（供 loadCnData 读取）。失败会抛出，交由 UI 提示。
//   未配置的 URL 保持内置；两者都未配置则缓存即内置。
export async function fetchAndCacheRules(settings = {}) {
  let domains = await readList(BUNDLED_DOMAINS);
  let cidrs = await readList(BUNDLED_CIDRS);
  let src = 'bundled';
  if (settings.rulesRemoteUrlDomains) { domains = await fetchRemoteList(settings.rulesRemoteUrlDomains, 'domain'); src = 'remote'; }
  if (settings.rulesRemoteUrlCidrs) { cidrs = await fetchRemoteList(settings.rulesRemoteUrlCidrs, 'cidr'); src = 'remote'; }
  const cache = { domains, cidrs, updatedAt: Date.now(), src };
  await saveRulesCache(cache);
  return { domainCount: domains.length, cidrCount: cidrs.length, updatedAt: cache.updatedAt, src };
}

// 解析用户自定义地址列表（每行/逗号分隔）为两类：glob 通配（域名与 IP 通配，交给 shExpMatch）+ CIDR 数值段。
//   裸域 example.com 自动补 *.example.com 覆盖子域；1.2.3.4 精确；10.0.0.0/8 走数值段匹配。
export function parseCustomList(text) {
  const globs = new Set();
  const nets = [];
  const lines = String(text || '').split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('#'));
  for (let l of lines) {
    if (l.includes('/')) { const p = toNetPairs([l]); if (p.length) { nets.push(p[0]); continue; } } // CIDR
    if (/^\d+\.\d+\.\d+\.\d+$/.test(l)) { globs.add(l); continue; } // IP 字面量
    const bare = l.replace(/^\*\./, '').replace(/^\./, ''); // 归一化
    if (!bare) continue;
    if (bare.includes('*') || bare.includes('?')) { globs.add(bare); continue; } // 已是通配
    globs.add(bare); globs.add('*.' + bare); // 精确 + 子域
  }
  return { globs: [...globs], nets };
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
//   custom：{direct,proxy} 用户自定义地址列表文本（优先于 CN/默认判定）
export function buildPac(proxyHost, proxyPort, mode, cnData, custom = {}) {
  const proxyLine = `HTTPS ${proxyHost}:${proxyPort}`;
  const cd = parseCustomList(custom.direct); // 不代理（强制直连）
  const cp = parseCustomList(custom.proxy);  // 强制代理
  // 公共辅助：IP 转整数 + glob(shExpMatch) 匹配 + 自定义 CIDR 数值段匹配
  const helpers = `
function ip2long(ip){var p=ip.split('.');if(p.length!==4)return null;var n=0;for(var i=0;i<4;i++){var o=parseInt(p[i],10);if(isNaN(o)||o<0||o>255)return null;n=(n<<8)|o;}return n>>>0;}
function inGlobs(g,host){for(var i=0;i<g.length;i++){if(shExpMatch(host,g[i]))return true;}return false;}
function inNets(n,host){if(!n.length)return false;var ip=ip2long(host);if(ip===null)return false;for(var i=0;i<n.length;i++){if((ip&n[i][1])===n[i][0])return true;}return false;}
var CD_G=${js(cd.globs)},CD_N=${js(cd.nets)},CP_G=${js(cp.globs)},CP_N=${js(cp.nets)};`;
  // 自定义优先判定：先“不代理”直连，再“强制代理”
  const customChecks = `
  if (inGlobs(CD_G, host) || inNets(CD_N, host)) return 'DIRECT';
  if (inGlobs(CP_G, host) || inNets(CP_N, host)) return '${proxyLine}';`;

  // 全局模式：除本地/内网/自定义直连外一律走代理，无需嵌入 CN 列表
  if (mode === 'global') {
    return `
function FindProxyForURL(url, host) {${helpers}
  // Control plane: proxy server's own host must go DIRECT so subscription/heartbeat carry the real client IP.
  if (host === '${proxyHost}') return 'DIRECT';
  if (isPlainHostName(host) || host === '127.0.0.1' || host === 'localhost') return 'DIRECT';
  if (shExpMatch(host, '10.*') || shExpMatch(host, '192.168.*') || shExpMatch(host, '172.16.*')) return 'DIRECT';${customChecks}
  return '${proxyLine}';
}
`.trim();
  }

  // 分流模式：内联 CN 域名后缀 + 预计算好的 IP 网段数值对，命中即 DIRECT，其余 PROXY
  // 重要：PAC 数据串必须为纯 ASCII（chrome.proxy 限制 pacScript.data 仅支持 ASCII），故模板内注释一律用英文。
  const nets = toNetPairs(cnData.cidrs);
  return `
// ==== FlowBrowse auto-generated split PAC (do not edit by hand) ====
var CN_SET = new Set(${js(cnData.domains)});
var CN_NETS = ${js(nets)}; // [base, mask] precomputed
${helpers}

// IP-literal host in any CN net? (integer compare over precomputed pairs)
function inCnCidr(host) {
  var ip = ip2long(host);
  if (ip === null) return false;
  for (var i = 0; i < CN_NETS.length; i++) {
    if ((ip & CN_NETS[i][1]) === CN_NETS[i][0]) return true;
  }
  return false;
}

// Match host against the CN domain set by walking parent domains (O(#labels) hash lookups).
function inCnDomain(host) {
  host = host.toLowerCase();
  while (true) {
    if (CN_SET.has(host)) return true;
    var i = host.indexOf('.');
    if (i < 0) break;
    host = host.slice(i + 1);
  }
  return false;
}

function FindProxyForURL(url, host) {
  // Control plane: proxy server's own host goes DIRECT so subscription/heartbeat carry the real client IP.
  if (host === '${proxyHost}') return 'DIRECT';
  // Local / loopback / private ranges always connect directly
  if (isPlainHostName(host) || host === '127.0.0.1' || host === 'localhost' || host === '::1') return 'DIRECT';
  if (shExpMatch(host, '10.*') || shExpMatch(host, '192.168.*') ||
      shExpMatch(host, '172.16.*') || shExpMatch(host, '172.17.*') ||
      shExpMatch(host, '172.18.*') || shExpMatch(host, '172.19.*') || shExpMatch(host, '172.2*') ||
      shExpMatch(host, '172.30.*') || shExpMatch(host, '172.31.*')) return 'DIRECT';
  // User custom lists take priority (force-direct / force-proxy)
  if (inGlobs(CD_G, host) || inNets(CD_N, host)) return 'DIRECT';
  if (inGlobs(CP_G, host) || inNets(CP_N, host)) return '${proxyLine}';
  // IP literal by CIDR, domain by suffix; CN => DIRECT, otherwise via HTTPS(TLS) proxy
  if (inCnCidr(host)) return 'DIRECT';
  if (inCnDomain(host)) return 'DIRECT';

  return '${proxyLine}';
}
`.trim();
}
