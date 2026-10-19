// service-worker.js —— FlowBrowse 后台编排（MV3，type:module）
// 职责：路由 popup/options 的动作；调度 proxy-manager/auth/subscription/node-manager/rules/probe；
//       维护 chrome.alarms 周期探测；管理承载 WebTransport 的 offscreen 文档生命周期。
// 关键约束：监听器必须顶层同步注册；SW 会休眠，故状态一律以 chrome.storage 为准，唤醒即用最新值。

import { loadAll, getSettings, setSettings, setRuntime } from '../lib/config.js';
import { applyProxy, clearProxy, resolveActive } from '../lib/proxy-manager.js';
import { registerAuthListener, initAuthFromStorage } from '../lib/auth.js';
import * as nodeMgr from '../lib/node-manager.js';
import * as subMgr from '../lib/subscription.js';
import { effectiveWtPort } from '../lib/config.js';

// ===== 顶层同步注册鉴权监听器（一次性，不能放在异步里）=====
registerAuthListener();
// SW 每次唤醒都从 storage 预热代理凭据到内存，保证休眠重启后 onAuthRequired 仍能同步注入
initAuthFromStorage();

// ===== 组装返回给 UI 的完整状态（不含内部敏感字段之外的信息）=====
async function buildState() {
  const { settings, nodes, subs, runtime } = await loadAll();
  return { settings, nodes, subs, runtime };
}

// 仅当"当前已连接"时才重新套用代理（用于选节点/改端口/存设置后热更新）。
// 为什么："选择/编辑节点"或"保存设置"不应隐式发起连接；连接是用户在 popup 的显式动作。
async function reapplyIfConnected() {
  const { settings, nodes, runtime } = await loadAll();
  const node = nodes.find((n) => n.id === settings.activeNodeId);
  if (runtime.connected && settings.mode !== 'off' && node) {
    const t = await applyProxy(node, settings);
    await setRuntime({ connected: true, statusText: t });
  }
}

// ===== offscreen 生命周期 =====
async function hasOffscreen() {
  if (typeof chrome.runtime.getContexts === 'function') {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  }
  return false;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  // reasons 选 WORKERS：offscreen 承担 WebTransport 这类需要完整安全上下文的后台"工作"
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: '维护 WebTransport(QUIC/h3) 连接与 RTT 探测；Service Worker 无该 API',
  });
}
async function maybeRemoveOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }
}

// 等待 offscreen 文档的 onMessage 监听就绪（刚 createDocument 会有竞态，用 ping 往返确认）
async function waitForOffscreenReady() {
  for (let i = 0; i < 25; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
      if (pong && pong.pong) return true;
    } catch (_) { /* 监听未就绪，重试 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// 向 offscreen 发起一次 RTT 探测并回传结果
async function probeNode(node, settings) {
  const wtPort = effectiveWtPort(node, settings);
  await ensureOffscreen();
  const ready = await waitForOffscreenReady();
  if (!ready) return { ok: false, error: 'offscreen 未就绪' };
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'probe', host: node.proxy.host, wtPort });
  return res || { ok: false, error: 'offscreen 无响应' };
}

// ===== alarms：周期探测当前节点（保持延迟/可用状态新鲜）=====
async function scheduleProbe() {
  const s = await getSettings();
  const period = Math.max(1, s.probeIntervalMinutes || 10);
  chrome.alarms.create('fb-probe', { periodInMinutes: period });
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fb-probe') return;
  const { settings, node } = await resolveActive();
  if (settings.mode === 'off' || !node) return;
  try {
    const r = await probeNode(node, settings);
    await recordProbe(node.id, r);
  } catch (e) {
    await recordProbe(node.id, { ok: false, error: String(e) });
  }
});

async function recordProbe(nodeId, r) {
  const { runtime } = await loadAll();
  runtime.lastProbe = { ...runtime.lastProbe, [nodeId]: { ...r, at: Date.now() } };
  await setRuntime({ lastProbe: runtime.lastProbe });
}

// ===== 连接 / 断开 =====
async function doConnect(nodeId) {
  const { nodes, settings } = await loadAll();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('节点不存在');
  // 连接即视为"开启"：off 模式下默认切到分流
  const effSettings = await setSettings({ activeNodeId: nodeId, mode: settings.mode === 'off' ? 'split' : settings.mode });
  const statusText = await applyProxy(node, effSettings);
  await setRuntime({ connected: true, statusText });
  await scheduleProbe();
  // 异步探测，不阻塞 UI
  probeNode(node, effSettings).then((r) => recordProbe(node.id, r)).catch(() => {});
  return statusText;
}

async function doDisconnect() {
  const statusText = await clearProxy();
  await setRuntime({ connected: false, statusText });
  chrome.alarms.clear('fb-probe');
  await maybeRemoveOffscreen(); // 断开后释放 offscreen，节省资源
}

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.action) {
        case 'getState':
          return sendResponse({ ok: true, state: await buildState() });
        case 'connect': {
          await doConnect(msg.nodeId);
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'disconnect': {
          await doDisconnect();
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setMode': {
          const s = await setSettings({ mode: msg.mode });
          if (s.mode === 'off') {
            await clearProxy();
            await setRuntime({ connected: false, statusText: '未连接（模式：关闭）' });
          } else {
            await reapplyIfConnected(); // 仅在已连接时切换路由，未连接则只记录模式
          }
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setPorts': {
          await setSettings({ portOverrideTcp: msg.tcp || null, portOverrideUdp: msg.udp || null });
          await reapplyIfConnected(); // 连接中改端口即时生效；未连接不打扰
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'addNode':
          await nodeMgr.addNode(msg.input);
          return sendResponse({ ok: true, state: await buildState() });
        case 'updateNode':
          await nodeMgr.updateNode(msg.id, msg.input);
          return sendResponse({ ok: true, state: await buildState() });
        case 'deleteNode':
          await nodeMgr.deleteNode(msg.id);
          return sendResponse({ ok: true, state: await buildState() });
        case 'addSubscription':
          await subMgr.addOrUpdateSubscription({ name: msg.name, url: msg.url });
          return sendResponse({ ok: true, state: await buildState() });
        case 'deleteSubscription':
          await subMgr.deleteSubscription(msg.id);
          return sendResponse({ ok: true, state: await buildState() });
        case 'refreshSubscription':
          await subMgr.refreshSubscription(msg.id);
          return sendResponse({ ok: true, state: await buildState() });
        case 'refreshAllSubscriptions':
          await subMgr.refreshAllSubscriptions();
          return sendResponse({ ok: true, state: await buildState() });
        case 'probeActive': {
          const { node, settings } = await resolveActive();
          if (!node) return sendResponse({ ok: false, error: '无选中节点' });
          const r = await probeNode(node, settings);
          await recordProbe(node.id, r);
          return sendResponse({ ok: true, probe: r, state: await buildState() });
        }
        // 仅切换当前节点（不强制连接）；若正处于连接中则即时切换到新节点
        case 'selectNode': {
          await setSettings({ activeNodeId: msg.id });
          await reapplyIfConnected();
          return sendResponse({ ok: true, state: await buildState() });
        }
        // 通用设置保存（options 页的规则/通用项）：合并写入后仅在已连接时重排定时器并热更新代理
        case 'setSettings': {
          await setSettings(msg.patch || {});
          await scheduleProbe(); // 探测间隔可能变了，重排定时器
          await reapplyIfConnected();
          return sendResponse({ ok: true, state: await buildState() });
        }
        default:
          return sendResponse({ ok: false, error: '未知动作: ' + (msg && msg.action) });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 保持消息通道开启以支持异步 sendResponse
});

// ===== 安装/启动：注册定时器；可选自动连接 =====
chrome.runtime.onInstalled.addListener(async () => {
  await scheduleProbe();
  const { settings } = await loadAll();
  if (settings.autoConnectOnStartup && settings.activeNodeId) {
    try { await doConnect(settings.activeNodeId); } catch (e) { console.warn('[FlowBrowse] 自动连接失败', e); }
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await scheduleProbe();
  const { settings } = await loadAll();
  if (settings.autoConnectOnStartup && settings.activeNodeId) {
    try { await doConnect(settings.activeNodeId); } catch (e) { console.warn('[FlowBrowse] 启动自动连接失败', e); }
  }
});
