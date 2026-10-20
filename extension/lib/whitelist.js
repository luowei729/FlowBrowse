// whitelist.js —— 经服务端「上报接口」管理 IP 白名单
// 为什么走 fetch：服务端白名单只认它看到的 TCP 来源 IP。扩展对本服务器域名在 PAC 里设了 DIRECT，
//   故这些请求带的是本机真实出口 IP（add=auto 即上报本机当前 IP）。跨域 fetch 由 manifest host_permissions <all_urls> 放行。
// 端点：GET https://<host>:<port>/<FB_ADMIN_TOKEN>/allow  支持 ?list=1 / ?add=<ip|cidr|auto>&ttl=<小时> / ?del=<ip|cidr>

// 解析 "host" 或 "host:port"
function splitHostPort(s) {
  s = String(s || '').trim();
  const m = s.match(/^(.*?):(\d+)$/);
  if (m) return { host: m[1], port: m[2] };
  return { host: s, port: '' };
}

// 组装上报接口 URL；token 作为路径段需编码，查询参数用 URLSearchParams（CIDR 的 / 会转 %2F，服务端 query 会还原）
function apiUrl(server, token, params) {
  const { host, port } = splitHostPort(server);
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return `https://${host}${port ? ':' + port : ''}/${encodeURIComponent(token)}/allow${q}`;
}

// 统一请求：no-store 防缓存、omit 不带凭据；非 2xx 抛错（附带响应片段便于排查“密钥/地址不对→404”）
async function req(url) {
  const resp = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit' });
  const text = await resp.text();
  if (!resp.ok) {
    const hint = resp.status === 404 ? '（密钥或地址不对，或上报接口未启用）' : '';
    throw new Error(`HTTP ${resp.status}${hint}：${(text || '').trim().slice(0, 120) || resp.statusText}`);
  }
  return text;
}

// 列出当前白名单：返回 { static: [..], dynamic: { ip: 到期时间 } }
export async function wlList(server, token) {
  const text = await req(apiUrl(server, token, { list: '1' }));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回非 JSON，可能密钥或地址不对');
  }
}

// 添加放行项：target 为 IP/CIDR；留空或 'auto' = 上报调用方来源 IP（本机当前出口）。ttlHours 选填（小时）。返回服务端文本
export async function wlAdd(server, token, target, ttlHours) {
  const params = { add: (target && String(target).trim()) || 'auto' };
  const h = parseInt(ttlHours, 10);
  if (h > 0) params.ttl = String(h);
  return req(apiUrl(server, token, params));
}

// 删除动态放行项（静态项来自服务器配置、不可在此删）
export async function wlDel(server, token, target) {
  return req(apiUrl(server, token, { del: String(target || '').trim() }));
}
