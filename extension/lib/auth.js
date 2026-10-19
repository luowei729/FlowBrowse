// auth.js —— 为 HTTPS 转发代理注入 Proxy-Authorization 凭据
// 为什么单独模块：MV3 移除了 webRequestBlocking，但 onAuthRequired 支持"返回 Promise"来异步提供凭据；
//   监听器必须在 service worker 顶层【同步】注册（否则事件丢失），故与业务逻辑隔离、单独成模块。
import { PROXY_AUTH_KEY } from './proxy-manager.js';

export function registerAuthListener() {
  chrome.webRequest.onAuthRequired.addListener(
    (details) => {
      // 仅处理代理发起的认证挑战；其它 401 不拦截
      if (details.isProxy) {
        return chrome.storage.local.get(PROXY_AUTH_KEY).then((data) => {
          const creds = data[PROXY_AUTH_KEY];
          if (creds && creds.username) {
            // 返回 authCredentials → Chrome 自动带上 Proxy-Authorization: Basic ...
            return { authCredentials: { username: creds.username, password: creds.password } };
          }
          return {}; // 无凭据：让挑战自然失败（服务器返回 407）
        });
      }
      return {};
    },
    { urls: ['<all_urls>'] }
    // MV3：不传 extraInfoSpec（无 blocking），靠返回 Promise 提供凭据
  );
  console.log('[FlowBrowse] 代理鉴权监听器已注册');
}
