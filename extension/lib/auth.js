// auth.js —— 为 HTTPS 转发代理注入 Proxy-Authorization 凭据
// 为什么单独模块：MV3 移除了 webRequestBlocking，onAuthRequired 用于提供代理凭据；
//   监听器必须在 service worker 顶层【同步】注册（否则事件丢失）。
// 关键教训（实测定位）：onAuthRequired 用"返回 Promise 异步读 storage"给 https 代理注入凭据时，
//   Chrome 拿到 407 后不会带凭据重试 → 报 ERR_INVALID_AUTH_CREDENTIALS。
//   改为：凭据缓存在内存变量里，onAuthRequired【同步】返回，Chrome 立即据此重试。
import { PROXY_AUTH_KEY } from './config.js';

// 内存凭据缓存：SW 存活期间同步可读；SW 重启后由 initAuthFromStorage 从 storage 预热。
let cachedCreds = null;

// 设置/清除缓存（proxy-manager 在 connect/disconnect 时调用）
export function setProxyCreds(creds) { cachedCreds = creds || null; }
export function clearProxyCreds() { cachedCreds = null; }

// 从 storage 预热缓存（SW 启动时调用，保证休眠重启后仍能同步注入）
export async function initAuthFromStorage() {
  const data = await chrome.storage.local.get(PROXY_AUTH_KEY);
  cachedCreds = data[PROXY_AUTH_KEY] || null;
}

export function registerAuthListener() {
  chrome.webRequest.onAuthRequired.addListener(
    (details) => {
      // 诊断日志
      console.log('[FlowBrowse][auth] onAuthRequired isProxy=' + details.isProxy + ' hasCreds=' + !!(cachedCreds && cachedCreds.username) + ' url=' + details.url);
      // MV3 关键：onAuthRequired 需返回 Promise 才会被 Chrome 采纳（同步返回对象会被忽略）。
      // 无凭据时 resolve({}) 让挑战自然失败，不弹框。
      if (cachedCreds && cachedCreds.username) {
        return Promise.resolve({ authCredentials: { username: cachedCreds.username, password: cachedCreds.password } });
      }
      return Promise.resolve({});
    },
    { urls: ['<all_urls>'] }
    // MV3：同步返回对象即可，无需 extraInfoSpec
  );
  console.log('[FlowBrowse] 代理鉴权监听器已注册(同步注入)');
}
