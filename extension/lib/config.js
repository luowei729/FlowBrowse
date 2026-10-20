// config.js —— chrome.storage 读写与数据模型层
// 为什么单独成模块：MV3 的 Service Worker 随时休眠、内存态不可靠，所有状态必须落 chrome.storage；
// 这里统一封装读写与默认值合并，其它模块只依赖本层，避免各自直接操作 storage 造成格式漂移。

// ===== 存储键（集中定义，防止拼写不一致）=====
export const KEYS = {
  SETTINGS: 'fb_settings',   // 用户设置：模式、当前节点、端口覆盖等
  NODES: 'fb_nodes',         // 节点数组（手动 + 订阅导入）
  SUBS: 'fb_subs',           // 订阅数组（可增删改、更新）
  RUNTIME: 'fb_runtime',     // 运行态：是否已连接、最近探测结果
  RULES: 'fb_rules_cache',   // 远程拉取的 CN 规则缓存（离线可用、避免每次连接都拉）
};

// 代理凭据在 storage 中的键：auth.js 的 onAuthRequired 读它注入 Proxy-Authorization。
// 集中放这里，避免 proxy-manager 与 auth 互相 import 造成循环依赖。
export const PROXY_AUTH_KEY = 'fb_proxy_auth';

// ===== 设置默认值：首次运行或字段缺失时兜底 =====
export const DEFAULT_SETTINGS = {
  // 情景模式（Zero Omega 范式）：唯一开关。'direct' 直接连接 | 'auto' 自动分流 | 'node:<id>' 全局走某节点
  activeProfile: 'direct',
  autoNodeId: null,          // '自动分流' 使用的默认代理节点 id
  // —— 以下为旧字段，保留做兼容/派生，新逻辑以 activeProfile 为准 ——
  mode: 'split',             // 'off' | 'global' | 'split'
  activeNodeId: null,        // 当前选中节点 id
  portOverrideTcp: null,     // 主干 TCP 端口覆盖（null=用节点自带）
  autoConnectOnStartup: false,
  probeIntervalMinutes: 10,  // 周期探测间隔
  rulesRemoteEnabled: false, // 默认用内置完整规则（已含全量 CN IP 段）；需要自动更新时再开启
  // 内置已预置全量 CN IP 段；下列为可选的国内可直连远程源（jsDelivr CDN），两框都预填推荐地址保持对称；
  //   默认“使用远程”开关为关=用内置，开启并点“立即更新”才拉取生效。
  rulesRemoteUrlDomains: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt', // “应直连”域名清单(Clash YAML)
  rulesRemoteUrlCidrs: 'https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists/china.txt',
  // 用户自定义地址列表（每行一条，支持 example.com / *.example.com / 1.2.3.4 / 10.0.0.0/8）
  customDirect: '',          // 不代理（强制直连）列表：优先于一切，命中走 DIRECT
  customProxy: '',           // 强制代理列表：命中走代理（在自定义直连之后判定）
};

// ===== 运行态默认值 =====
export const DEFAULT_RUNTIME = {
  connected: false,
  statusText: '未连接',
  lastProbe: {},             // { [nodeId]: { rttMs, ok, at } }
};

// 归一化：旧数据可能把远程 URL 存成了空串（会盖掉新默认），这里把空值回填为推荐默认，保证 UI 能看到默认地址。
//   远程开关默认关=用内置，故 URL 值在关闭时不生效，回填安全。
function normalizeSettings(s) {
  const m = { ...DEFAULT_SETTINGS, ...s };
  if (!m.rulesRemoteUrlDomains) m.rulesRemoteUrlDomains = DEFAULT_SETTINGS.rulesRemoteUrlDomains;
  if (!m.rulesRemoteUrlCidrs) m.rulesRemoteUrlCidrs = DEFAULT_SETTINGS.rulesRemoteUrlCidrs;
  return m;
}

// 读整包（一次取齐，减少异步次数）
export async function loadAll() {
  const data = await chrome.storage.local.get(Object.values(KEYS));
  return {
    settings: normalizeSettings(data[KEYS.SETTINGS] || {}),
    nodes: data[KEYS.NODES] || [],
    subs: data[KEYS.SUBS] || [],
    runtime: { ...DEFAULT_RUNTIME, ...(data[KEYS.RUNTIME] || {}) },
  };
}

// 局部写入：仅覆盖传入的键，避免并发读整包再写导致相互覆盖
export async function setSettings(patch) {
  const cur = (await chrome.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
  const next = { ...normalizeSettings(cur), ...patch };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  return next;
}
export async function getSettings() {
  const cur = (await chrome.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
  return normalizeSettings(cur);
}

export async function saveNodes(nodes) {
  await chrome.storage.local.set({ [KEYS.NODES]: nodes });
  return nodes;
}
export async function getNodes() {
  return (await chrome.storage.local.get(KEYS.NODES))[KEYS.NODES] || [];
}

export async function saveSubs(subs) {
  await chrome.storage.local.set({ [KEYS.SUBS]: subs });
  return subs;
}
export async function getSubs() {
  return (await chrome.storage.local.get(KEYS.SUBS))[KEYS.SUBS] || [];
}

export async function setRuntime(patch) {
  const cur = (await chrome.storage.local.get(KEYS.RUNTIME))[KEYS.RUNTIME] || {};
  const next = { ...DEFAULT_RUNTIME, ...cur, ...patch };
  await chrome.storage.local.set({ [KEYS.RUNTIME]: next });
  return next;
}

// ===== 远程 CN 规则缓存 =====
// 为什么缓存：远程列表只在“立即更新”时拉一次并落盘，连接时直接读缓存，既快又离线可用，避免每次连接都走网络。
export async function getRulesCache() {
  return (await chrome.storage.local.get(KEYS.RULES))[KEYS.RULES] || null; // {domains,cidrs,updatedAt,src}
}
export async function saveRulesCache(cache) {
  await chrome.storage.local.set({ [KEYS.RULES]: cache });
  return cache;
}

// 生成短 id：节点/订阅都需要稳定标识，用于选择、去重与级联删除
export function genId(prefix = 'n') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 从节点解析出"生效的代理主机与 TCP 端口"（考虑端口覆盖，域名完全来自节点，不硬编码）
export function effectiveProxy(node, settings) {
  return {
    host: node.proxy.host,
    port: settings.portOverrideTcp || node.proxy.port || 443,
    scheme: node.proxy.scheme || 'https',
    user: node.proxy.user || '',
    pass: node.proxy.pass || '',
  };
}

// WebTransport 生效端口（可自定义 UDP）
export function effectiveWtPort(node, settings) {
  return settings.portOverrideUdp || node.wtPort || 443;
}

// ===== 情景模式（Zero Omega 范式）抽象 =====
// 可切换列表：直接连接 + 自动分流 + 每个节点（全局代理到它）
export function profileList(settings, nodes) {
  const items = [
    { id: 'direct', name: '直接连接', type: 'direct' },
    { id: 'auto', name: '自动分流', type: 'auto' },
  ];
  for (const n of nodes) items.push({ id: 'node:' + n.id, name: n.name || n.proxy.host, type: 'proxy', node: n });
  return items;
}

// 由 activeProfile 派生出底层所需的 { mode, node }（兼容旧 mode/activeNodeId）
export function resolveProfile(settings, nodes) {
  let ap = settings.activeProfile;
  if (!ap) {
    // 旧数据迁移：由 mode/activeNodeId 推导
    ap = settings.mode === 'off' ? 'direct' : (settings.mode === 'global' ? 'node:' + (settings.activeNodeId || '') : 'auto');
  }
  if (ap === 'direct') return { mode: 'off', node: null };
  if (ap === 'auto') {
    const node = nodes.find((n) => n.id === settings.autoNodeId) || nodes.find((n) => n.id === settings.activeNodeId) || nodes[0] || null;
    return { mode: 'split', node };
  }
  const id = ap.startsWith('node:') ? ap.slice(5) : ap;
  const node = nodes.find((n) => n.id === id) || null;
  return { mode: 'global', node };
}
