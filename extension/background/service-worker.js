// service-worker.js —— FlowBrowse 后台编排（MV3，type:module）
// 职责：路由 popup/options 的动作；调度 proxy-manager/auth/subscription/node-manager/rules/probe；
//       维护 chrome.alarms 周期探测；根据连接状态更新工具栏角标。
// 关键约束：监听器必须顶层同步注册；SW 会休眠，故状态一律以 chrome.storage 为准，唤醒即用最新值。
// 架构：已放弃 QUIC/WebTransport，代理走 TCP 443（chrome.proxy HTTPS），无需 offscreen。

import { loadAll, getSettings, setSettings, setRuntime } from '../lib/config.js';
import { applyProxy, clearProxy, resolveActive } from '../lib/proxy-manager.js';
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
  return { settings, nodes, subs, runtime };
}

// 仅当"当前已连接"时才重新套用代理（选节点/改端口/存设置后热更新）。
async function reapplyIfConnected() {
  const { settings, nodes, runtime } = await loadAll();
  const node = nodes.find((n) => n.id === settings.activeNodeId);
  if (runtime.connected && settings.mode !== 'off' && node) {
    const t = await applyProxy(node, settings);
    await setRuntime({ connected: true, statusText: t });
    updateIcon(true);
  }
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

// ===== alarms：周期探测当前节点 =====
async function scheduleProbe() {
  const s = await getSettings();
  const period = Math.max(1, s.probeIntervalMinutes || 10);
  chrome.alarms.create('fb-probe', { periodInMinutes: period });
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fb-probe') return;
  const { node, settings } = await resolveActive();
  if (settings.mode === 'off' || !node) return;
  try {
    const r = await probeNode(node);
    await recordProbe(node.id, r);
  } catch (e) {
    await recordProbe(node.id, { ok: false, error: String(e) });
  }
});

// ===== 连接 / 断开 =====
async function doConnect(nodeId) {
  const { nodes, settings } = await loadAll();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('节点不存在');
  const effSettings = await setSettings({ activeNodeId: nodeId, mode: settings.mode === 'off' ? 'split' : settings.mode });
  const statusText = await applyProxy(node, effSettings);
  await setRuntime({ connected: true, statusText });
  updateIcon(true);
  startKeepAlive(); // 连接期间保持 SW 活跃，鉴权更稳
  await scheduleProbe();
  probeNode(node).then((r) => recordProbe(node.id, r)).catch(() => {});
  return statusText;
}

async function doDisconnect() {
  const statusText = await clearProxy();
  await setRuntime({ connected: false, statusText });
  updateIcon(false);
  stopKeepAlive();
  chrome.alarms.clear('fb-probe');
}

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 忽略发往其它上下文（如已废弃的 offscreen）的消息
  if (msg && msg.target && msg.target !== 'sw') return;
  (async () => {
    try {
      switch (msg && msg.action) {
        case 'getState':
          return sendResponse({ ok: true, state: await buildState() });
        case 'connect':
          await doConnect(msg.nodeId);
          return sendResponse({ ok: true, state: await buildState() });
        case 'disconnect':
          await doDisconnect();
          return sendResponse({ ok: true, state: await buildState() });
        case 'setMode': {
          const s = await setSettings({ mode: msg.mode });
          if (s.mode === 'off') {
            await clearProxy();
            await setRuntime({ connected: false, statusText: '未连接（模式：关闭）' });
            updateIcon(false);
            stopKeepAlive();
          } else {
            await reapplyIfConnected();
          }
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setPorts': {
          await setSettings({ portOverrideTcp: msg.tcp || null });
          await reapplyIfConnected();
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
          const { node } = await resolveActive();
          if (!node) return sendResponse({ ok: false, error: '无选中节点' });
          const r = await probeNode(node);
          await recordProbe(node.id, r);
          return sendResponse({ ok: true, probe: r, state: await buildState() });
        }
        case 'selectNode': {
          await setSettings({ activeNodeId: msg.id });
          await reapplyIfConnected();
          return sendResponse({ ok: true, state: await buildState() });
        }
        case 'setSettings': {
          await setSettings(msg.patch || {});
          await scheduleProbe();
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
  return true;
});

// ===== 安装/启动：注册定时器；同步角标；可选自动连接 =====
async function initOnStart() {
  const { settings, runtime } = await loadAll();
  const on = runtime.connected && settings.mode !== 'off';
  updateIcon(on);
  if (on) startKeepAlive(); // 唤醒后若仍处连接态，恢复 keepalive
  await scheduleProbe();
  if (settings.autoConnectOnStartup && settings.activeNodeId) {
    try { await doConnect(settings.activeNodeId); } catch (e) { console.warn('[FlowBrowse] 自动连接失败', e); }
  }
}
chrome.runtime.onInstalled.addListener(initOnStart);
chrome.runtime.onStartup.addListener(initOnStart);
