// offscreen.js —— 接收 SW 的探测请求，执行 WebTransport RTT 探测并回传
// 只处理 target==='offscreen' 的消息，避免与 popup/options 的消息串扰。
import { probeRtt } from '../lib/probe.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return; // 非本上下文的消息直接忽略
  if (msg.type === 'probe') {
    // 异步探测：返回 true 保持消息通道，待 Promise 完成后 sendResponse
    probeRtt(msg.host, msg.wtPort)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

console.log('[FlowBrowse] offscreen 已就绪，等待 WebTransport 探测任务');
