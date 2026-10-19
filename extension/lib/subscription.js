// subscription.js —— 订阅地址的增/删/改/更新与 fb:// 解析
// 为什么手解 fb:// 而不用 new URL()：fb: 属于"非特殊 scheme"，WHATWG URL 会把 // 后的内容当作 opaque host，
//   username/password/hostname 解析不可靠，故按 hy2 风格 authority 结构用正则手动拆分，稳定可控。

import { getNodes, saveNodes, getSubs, saveSubs, genId } from './config.js';

// 解析单条 fb:// 链接 → 节点核心字段（不含 id/source，由上层补）
export function parseFbLink(link) {
  try {
    const trimmed = String(link || '').trim();
    if (!trimmed.startsWith('fb://')) return null;
    let rest = trimmed.slice('fb://'.length);

    // 1) 先切出查询串 ?k=v&k=v
    let query = '';
    const qIdx = rest.indexOf('?');
    if (qIdx >= 0) { query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }
    rest = rest.replace(/\/+$/, ''); // 去掉结尾斜杠

    // 2) 拆 userinfo@authority（用最后一个 @，兼容密码里没有 @，因密码已百分号编码）
    let user = '', pass = '', authority = rest;
    const atIdx = rest.lastIndexOf('@');
    if (atIdx >= 0) {
      const userinfo = rest.slice(0, atIdx);
      authority = rest.slice(atIdx + 1);
      const c = userinfo.indexOf(':');
      if (c >= 0) { user = userinfo.slice(0, c); pass = userinfo.slice(c + 1); }
      else { user = userinfo; }
    }

    // 3) 拆 host:port（端口仅在纯数字时生效，避免误切 IPv6/含冒号主机）
    let host = authority, port = 443;
    const colon = authority.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
      host = authority.slice(0, colon);
      port = parseInt(authority.slice(colon + 1), 10);
    }

    // 4) 查询参数
    const p = new URLSearchParams(query);
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

    return {
      name: dec(p.get('name') || host),
      region: dec(p.get('region') || ''),
      proxy: { host: dec(host), port, scheme: 'https', user: dec(user), pass: dec(pass) },
      wtPort: p.get('udp') ? parseInt(p.get('udp'), 10) : 443,
    };
  } catch (e) {
    console.warn('[FlowBrowse] fb:// 解析失败：', link, e);
    return null;
  }
}

// 拉取订阅：优先按 base64 解码（服务端默认输出），失败则当作明文换行 fb:// 列表
export async function fetchSubscriptionNodes(subUrl) {
  const resp = await fetch(subUrl, { credentials: 'omit', cache: 'no-store' });
  if (!resp.ok) throw new Error(`订阅拉取失败 HTTP ${resp.status}`);
  const text = (await resp.text()).trim();

  let content = text;
  try {
    const bin = atob(text.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    content = new TextDecoder('utf-8').decode(bytes);
  } catch {
    // 非 base64：直接使用原文（兼容纯文本订阅）
  }

  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('fb://'))
    .map(parseFbLink)
    .filter(Boolean);
}

// 节点身份键：host:port:user —— 合并去重与订阅刷新的判定依据
function nodeKey(n) { return `${n.proxy.host}:${n.proxy.port}:${n.proxy.user}`; }

// 添加/更新订阅（配置订阅地址）：url 变更即视为更新；成功后合并节点
export async function addOrUpdateSubscription({ name, url }) {
  const subs = await getSubs();
  const nodes = await getNodes();
  let sub = subs.find((s) => s.url === url);

  if (!sub) {
    sub = { id: genId('s'), name: name || url, url, createdAt: Date.now(), lastRefresh: 0, nodeKeys: [] };
    subs.push(sub);
  } else if (name) {
    sub.name = name; // 支持"配置/重命名"订阅
  }

  const fetched = await fetchSubscriptionNodes(url);
  // 先移除该订阅上次贡献的节点（按身份键），避免刷新残留
  const stale = new Set(sub.nodeKeys || []);
  let merged = nodes.filter((n) => !(n.source === 'subscribe' && stale.has(nodeKey(n))));

  const keys = [];
  for (const f of fetched) {
    const k = nodeKey(f);
    if (merged.some((n) => nodeKey(n) === k)) continue; // 去重
    const node = { id: genId('n'), source: 'subscribe', subId: sub.id, ...f };
    merged.push(node);
    keys.push(k);
  }

  sub.nodeKeys = keys;
  sub.lastRefresh = Date.now();

  await saveNodes(merged);
  await saveSubs(subs);
  return { subs, nodes: merged };
}

// 刷新单个订阅
export async function refreshSubscription(subId) {
  const subs = await getSubs();
  const sub = subs.find((s) => s.id === subId);
  if (!sub) throw new Error('订阅不存在');
  return addOrUpdateSubscription({ name: sub.name, url: sub.url });
}

// 刷新全部订阅
export async function refreshAllSubscriptions() {
  const subs = await getSubs();
  for (const s of subs) {
    try { await addOrUpdateSubscription({ name: s.name, url: s.url }); }
    catch (e) { console.warn('[FlowBrowse] 刷新订阅失败', s.url, e); }
  }
  return { subs: await getSubs(), nodes: await getNodes() };
}

// 删除订阅：同时移除其来源节点（级联，保持数据一致）
export async function deleteSubscription(subId) {
  const subs = await getSubs();
  const nodes = await getNodes();
  const nextSubs = subs.filter((s) => s.id !== subId);
  const nextNodes = nodes.filter((n) => !(n.source === 'subscribe' && n.subId === subId));
  await saveSubs(nextSubs);
  await saveNodes(nextNodes);
  return { subs: nextSubs, nodes: nextNodes };
}
