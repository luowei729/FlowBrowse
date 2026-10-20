// config.js —— chrome.storage 读写与数据模型层
// 为什么单独成模块：MV3 的 Service Worker 随时休眠、内存态不可靠，所有状态必须落 chrome.storage；
// 这里统一封装读写与默认值合并，其它模块只依赖本层，避免各自直接操作 storage 造成格式漂移。

// ===== 存储键（集中定义，防止拼写不一致）=====
export const KEYS = {
  SETTINGS: 'fb_settings',   // 用户设置：模式、当前节点、端口覆盖等
  NODES: 'fb_nodes',         // 节点数组（手动 + 订阅导入）
  SUBS: 'fb_subs',           // 订阅数组（可增删改、更新）
  RUNTIME: 'fb_runtime',     // 运行态：是否已连接、最近探测结果
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
  // 内置已预置全量 CN IP 段；下列为可选的国内可直连远程源（jsDelivr CDN）
  rulesRemoteUrlDomains: '', // 域名源留空=用内置；可填 Clash YAML/纯文本域名列表 URL
  rulesRemoteUrlCidrs: 'https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists/china.txt',
};

// ===== 运行态默认值 =====
export const DEFAULT_RUNTIME = {
  connected: false,
  statusText: '未连接',
  lastProbe: {},             // { [nodeId]: { rttMs, ok, at } }
};

// 读整包（一次取齐，减少异步次数）
export async function loadAll() {
  const data = await chrome.storage.local.get(Object.values(KEYS));
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data[KEYS.SETTINGS] || {}) },
    nodes: data[KEYS.NODES] || [],
    subs: data[KEYS.SUBS] || [],
    runtime: { ...DEFAULT_RUNTIME, ...(data[KEYS.RUNTIME] || {}) },
  };
}

// 局部写入：仅覆盖传入的键，避免并发读整包再写导致相互覆盖
export async function setSettings(patch) {
  const cur = (await chrome.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
  const next = { ...DEFAULT_SETTINGS, ...cur, ...patch };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  return next;
}
export async function getSettings() {
  const cur = (await chrome.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
  return { ...DEFAULT_SETTINGS, ...cur };
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
