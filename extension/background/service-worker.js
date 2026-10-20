// service-worker.js —— FlowBrowse 后台编排（MV3，type:module）
// 职责：路由 popup/options 的动作；调度 proxy-manager/auth/subscription/node-manager/rules/probe；
//       维护 chrome.alarms 周期探测；根据连接状态更新工具栏角标。
// 关键约束：监听器必须顶层同步注册；SW 会休眠，故状态一律以 chrome.storage 为准，唤醒即用最新值。
// 架构：已放弃 QUIC/WebTransport，代理走 TCP 443（chrome.proxy HTTPS），无需 offscreen。

import { loadAll, getSettings, setSettings, setRuntime, getSubs, resolveProfile, saveNodes, saveSubs, getRulesCache } from '../lib/config.js';
import { applyProxy, clearProxy } from '../lib/proxy-manager.js';
import { fetchAndCacheRules } from '../lib/rules.js';
import { registerAuthListener, initAuthFromStorage } from '../lib/auth.js';
import { probeLatency } from '../lib/probe.js';
import * as nodeMgr from '../lib/node-manager.js';
import * as subMgr from '../lib/subscription.js';

// ===== 顶层同步注册鉴权监听器（一次性，不能放在异步里）=====
registerAuthListener();
// SW 每次唤醒都从 storage 预热代理凭据（若启用鉴权）到内存
initAuthFromStorage();

// ===== #2 工具栏角标：一眼判断开/关 =====
function updateIcon(connected) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: connected ? '#16a34a' : '#9ca3af' });
    chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' });
    chrome.action.setTitle({ title: connected ? 'FlowBrowse：已连接（代理开启）' : 'FlowBrowse：未连接' });
  } catch (_) {}
}

// ===== SW keepalive：连接期间每 20s 轻量调用，降低休眠概率，保证 onAuthRequired 及时响应 =====
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {} }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ===== 组装返回给 UI 的完整状态 =====
async function buildState() {
  const { settings, nodes, subs, runtime } = await loadAll();
  const rulesCache = await getRulesCache(); // 供 options 显示“最近更新时间/条数”
  return { settings, nodes, subs, runtime, rulesCache };
}

// ===== 套用当前情景模式（Zero Omega 范式核心）：根据 activeProfile 派生 mode+node 并应用 =====
async function applyActiveProfile() {
  const { settings, nodes } = await loadAll();
  const { mode, node } = resolveProfile(settings, nodes);
  if (mode === 'off' || !node) {
    // 直接连接 / 无可用节点 → 清除代理
    const t = await clearProxy();
    await setRuntime({ connected: false, statusText: mode === 'off' ? '直接连接（未走代理）' : '未选择可用节点' });
    updateIcon(false);
    stopKeepAlive();
    chrome.alarms.clear('fb-probe');
    chrome.alarms.clear('fb-hb');
    return;
  }
  const t = await applyProxy(node, { ...settings, mode });
  await setRuntime({ connected: true, statusText: t });
  updateIcon(true);
  startKeepAlive();
  await scheduleProbe();
  await scheduleHeartbeat();
  heartbeatSubs().catch(() => {}); // 立即上报一次 IP
  probeNode(node).then((r) => recordProbe(node.id, r)).catch(() => {});
}

// 切换情景模式：设为当前；若选节点则同步为“自动分流”的默认代理
async function selectProfile(profileId) {
  const patch = { activeProfile: profileId };
  if (profileId.startsWith('node:')) patch.autoNodeId = profileId.slice(5);
  await setSettings(patch);
  await applyActiveProfile();
}

// ===== 探测当前节点延迟（经服务器 HTTPS 往返）=====
async function probeNode(node) {
  if (!node) return { ok: false, error: '无选中节点' };
  return await probeLatency(node.proxy.host);
}

async function recordProbe(nodeId, r) {
  const { runtime } = await loadAll();
  runtime.lastProbe = { ...runtime.lastProbe, [nodeId]: { ...r, at: Date.now() } };
  await setRuntime({ lastProbe: runtime.lastProbe });
}

// ===== IP 心跳：连接期间定时直连拉一次订阅，让服务器重新登记当前客户端 IP（解决换 IP 自动回白名单）=====
async function heartbeatSubs() {
  const subs = await getSubs();
  // 并发向每个订阅 URL 发一个轻量 GET（PAC 已把代理域名设为 DIRECT，故走直连带真实 IP）；忽略结果
  await Promise.all((subs || []).map((s) => fetch(s.url + (s.url.includes('?') ? '&' : '?') + 'hb=1', { cache: 'no-store', credentials: 'omit' }).catch(() => {})));
}

// ===== alarms：周期探测当前节点 + IP 心跳 =====
async function scheduleProbe() {
  const s = await getSettings();
  const period = Math.max(1, s.probeIntervalMinutes || 10);
  chrome.alarms.create('fb-probe', { periodInMinutes: period });
}
async function scheduleHeartbeat() {
  chrome.alarms.create('fb-hb', { periodInMinutes: 2 }); // 每 2 分钟上报一次 IP
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'fb-hb') {
    const { settings, nodes } = await loadAll();
    if (resolveProfile(settings, nodes).mode !== 'off') await heartbeatSubs();
    return;
  }
  if (alarm.name !== 'fb-probe') return;
  const { settings, nodes } = await loadAll();
  const { mode, node } = resolveProfile(settings, nodes);
  if (mode === 'off' || !node) return;
  try {
    const r = await probeNode(node);
    await recordProbe(node.id, r);
  } catch (e) {
    await recordProbe(node.id, { ok: false, error: String(e) });
  }
});

// ===== 连接/断开（兼容旧接口，映射到情景模式切换）=====
async function doConnect(nodeId) { await selectProfile('node:' + nodeId); }
async function doDisconnect() { await selectProfile('direct'); }

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 忽略发往其它上下文（如已废弃的 offscreen）的消息
  if (msg && msg.target && msg.target !== 'sw') return;
  (async () => {
    try {
      switch (msg && msg.action) {
        case 'getState':
          return sendResponse({ ok: true, state: await buildState() });
        // 切换情景模式（Zero Omega 核心动作）：'direct' | 'auto' | 'node:<id>'
        case 'selectProfile':
          await selectProfile(msg.profileId);
          return sendResponse({ ok: true, state: await buildState() });
        case 'connect':
          await doConnect(msg.nodeId);
          return sendResponse({ ok: true, state: await buildState() });
        case 'disconnect':
          await doDisconnect();
          return sendResponse({ ok: true, state: await buildState() });
        // 旧模式接口：映射到情景模式
        case 'setMode': {
          let ap = 'direct';
          if (msg.mode === 'split') ap = 'auto';
          else if (msg.mode === 'global') {
            const { settings, nodes } = await loadAll();
            const nid = settings.autoNodeId || settings.activeNodeId || (nodes[0] && nodes[0].id);
            ap = nid ? 'node:' + nid : 'direct';
          }
          await selectProfile(ap);
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setPorts': {
          await setSettings({ portOverrideTcp: msg.tcp || null });
          await applyActiveProfile();
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'addNode':
          await nodeMgr.addNode(msg.input);
          return sendResponse({ ok: true, state: await buildState() });
        case 'updateNode':
          await nodeMgr.updateNode(msg.id, msg.input);
          await applyActiveProfile(); // 若正在用该节点，热更新
          return sendResponse({ ok: true, state: await buildState() });
        case 'deleteNode':
          await nodeMgr.deleteNode(msg.id);
          await applyActiveProfile();
          return sendResponse({ ok: true, state: await buildState() });
        case 'addSubscription':
          await subMgr.addOrUpdateSubscription({ name: msg.name, url: msg.url });
          return sendResponse({ ok: true, state: await buildState() });
        case 'deleteSubscription':
          await subMgr.deleteSubscription(msg.id);
          await applyActiveProfile();
          return sendResponse({ ok: true, state: await buildState() });
        case 'refreshSubscription':
          await subMgr.refreshSubscription(msg.id);
          return sendResponse({ ok: true, state: await buildState() });
        case 'refreshAllSubscriptions':
          await subMgr.refreshAllSubscriptions();
          return sendResponse({ ok: true, state: await buildState() });
        case 'probeActive': {
          const { settings, nodes } = await loadAll();
          const { node } = resolveProfile(settings, nodes);
          if (!node) return sendResponse({ ok: false, error: '无选中节点' });
          const r = await probeNode(node);
          await recordProbe(node.id, r);
          return sendResponse({ ok: true, probe: r, state: await buildState() });
        }
        // 选择“自动分流”的默认代理节点（不切换当前情景模式）
        case 'selectNode': {
          await setSettings({ autoNodeId: msg.id, activeNodeId: msg.id });
          await applyActiveProfile();
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setSettings': {
          await setSettings(msg.patch || {});
          await applyActiveProfile(); // 规则/探测间隔等变化后重新套用
          return sendResponse({ ok: true, state: await buildState() });
        }
        // 立即更新分流规则：拉取远程列表写入缓存，再用新规则重套当前情景的 PAC
        case 'updateRules': {
          const settings = await getSettings();
          const info = await fetchAndCacheRules(settings);
          await applyActiveProfile();
          return sendResponse({ ok: true, info, state: await buildState() });
        }
        // 导入配置：覆盖节点/订阅/设置（options 导入导出用），随后重新套用当前情景模式
        case 'importConfig': {
          const d = msg.data || {};
          if (Array.isArray(d.nodes)) await saveNodes(d.nodes);
          if (Array.isArray(d.subs)) await saveSubs(d.subs);
          if (d.settings) await setSettings(d.settings);
          await applyActiveProfile();
          return sendResponse({ ok: true, state: await buildState() });
        }
        default:
          return sendResponse({ ok: false, error: '未知动作: ' + (msg && msg.action) });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// ===== 安装/启动：Zero Omega 范式——启动即套用当前情景模式（direct 则保持直连，安全）=====
async function initOnStart() {
  try { await applyActiveProfile(); }
  catch (e) { console.warn('[FlowBrowse] 启动套用情景模式失败', e); updateIcon(false); }
}
chrome.runtime.onInstalled.addListener(initOnStart);
chrome.runtime.onStartup.addListener(initOnStart);
