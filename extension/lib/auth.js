// auth.js —— 为 HTTPS 转发代理注入 Proxy-Authorization 凭据（用户名可为密钥，密码可空）
// 为什么单独模块：MV3 移除了 webRequestBlocking，代理鉴权只能靠 onAuthRequired 程序注入。
//   监听器必须在 service worker 顶层【同步】注册（否则事件丢失）。
// 健壮性设计：
//   1) 凭据缓存在内存 cachedCreds，SW 存活期同步命中；
//   2) SW 休眠被唤醒时缓存可能为空 → listener 内异步从 storage 兜底加载（解决唤醒竞态）；
//   3) 返回 Promise 供 Chrome 采纳（MV3 下异步返回 authCredentials 是被支持的）。
import { PROXY_AUTH_KEY } from './config.js';

let cachedCreds = null;

// 设置凭据：写入内存缓存并持久化到 storage（SW 重启后可恢复）
export async function setProxyCreds(creds) {
  cachedCreds = creds && creds.username ? { username: creds.username, password: creds.password || '' } : null;
  await chrome.storage.local.set({ [PROXY_AUTH_KEY]: cachedCreds });
}

export async function clearProxyCreds() {
  cachedCreds = null;
  await chrome.storage.local.remove(PROXY_AUTH_KEY);
}

// 从 storage 预热缓存（SW 启动时调用）
export async function initAuthFromStorage() {
  const data = await chrome.storage.local.get(PROXY_AUTH_KEY);
  cachedCreds = data[PROXY_AUTH_KEY] || null;
}

export function registerAuthListener() {
  chrome.webRequest.onAuthRequired.addListener(
    async (details) => {
      // 唤醒竞态兜底：缓存空则现读 storage
      if (!cachedCreds) {
        try { await initAuthFromStorage(); } catch (_) {}
      }
      console.log('[FlowBrowse][auth] onAuthRequired isProxy=' + !!details.isProxy + ' hasCreds=' + !!(cachedCreds && cachedCreds.username));
      if (cachedCreds && cachedCreds.username) {
        return { authCredentials: { username: cachedCreds.username, password: cachedCreds.password || '' } };
      }
      // 无凭据：返回空对象，让挑战自然失败（不主动弹框由服务端 407 决定）
      return {};
    },
    { urls: ['<all_urls>'] }
  );
  console.log('[FlowBrowse] 代理鉴权监听器已注册');
}
