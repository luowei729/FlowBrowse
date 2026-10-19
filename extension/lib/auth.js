// auth.js —— 为 HTTPS 转发代理注入 Proxy-Authorization 凭据
// 为什么单独模块：MV3 移除了 webRequestBlocking，但 onAuthRequired 支持"返回 Promise"来异步提供凭据；
//   监听器必须在 service worker 顶层【同步】注册（否则事件丢失），故与业务逻辑隔离、单独成模块。
import { PROXY_AUTH_KEY } from './proxy-manager.js';

export function registerAuthListener() {
  chrome.webRequest.onAuthRequired.addListener(
    (details) => {
      // 关键修正：不再用 details.isProxy 做门槛。
      // 原因：对 https 代理的 CONNECT 鉴权挑战，isProxy 在部分 Chrome 版本为 undefined/false，
      //       旧逻辑会直接返回 {} 导致 Chrome 弹框要账号密码。改为：只要本地存有代理凭据就注入。
      return chrome.storage.local.get(PROXY_AUTH_KEY).then((data) => {
        const creds = data[PROXY_AUTH_KEY];
        if (creds && creds.username) {
          // 返回 authCredentials → Chrome 自动带上 Proxy-Authorization: Basic ...（静默鉴权，不弹框）
          return { authCredentials: { username: creds.username, password: creds.password } };
        }
        // 无凭据：让挑战自然失败（服务器 407），不弹框打扰
        return {};
      });
    },
    { urls: ['<all_urls>'] }
    // MV3：不传 extraInfoSpec（无 blocking），靠返回 Promise 提供凭据
  );
  console.log('[FlowBrowse] 代理鉴权监听器已注册');
}
