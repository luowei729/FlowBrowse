// proxy-manager.js —— 应用/清除 chrome.proxy（PAC 模式）
// 职责边界：只负责"把配置翻译成 chrome.proxy 调用"，不碰节点/规则细节（那些在各自模块）。
import { loadAll, effectiveProxy } from './config.js';
import { buildPac, loadCnData } from './rules.js';

// 代理凭据在 storage 中的键：auth.js 的 onAuthRequired 会读它注入 Proxy-Authorization
export const PROXY_AUTH_KEY = 'fb_proxy_auth';

// 应用代理：根据当前节点与模式生成 PAC 并写入 chrome.proxy
// 返回可读状态文本，供上层展示
export async function applyProxy(node, settings) {
  if (settings.mode === 'off') {
    await clearProxy();
    return '未连接（模式：关闭）';
  }
  if (!node) throw new Error('未选择可用节点');

  // 生效的主机与端口（端口覆盖在此统一处理，避免 auth/PAC 不一致）
  const p = effectiveProxy(node, settings);

  // 生成 PAC：global 无需 CN 列表；split 需加载 CN 域名/CIDR
  const cnData = settings.mode === 'split' ? await loadCnData(settings) : { domains: [], cidrs: [] };
  const pac = buildPac(p.host, p.port, settings.mode, cnData);

  // 防御：chrome.proxy 限制 pacScript.data 仅支持 ASCII。若混入非 ASCII（如远程规则异常），
  // 提前抛出中文可读错误，避免 Chrome 返回难懂的拒绝信息、也避免误以为"已连接其实裸奔"。
  if (/[^\x00-\x7F]/.test(pac)) {
    throw new Error('PAC 含非 ASCII 字符，chrome.proxy 仅支持 ASCII，请检查域名/IP 规则列表');
  }

  // mandatory:true：PAC 出错时不回退直连，避免"以为在代理、其实裸奔"
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } },
    scope: 'regular',
  });

  // 暂存代理凭据给 auth.js；无凭据则清除旧值
  if (p.user) {
    await chrome.storage.local.set({ [PROXY_AUTH_KEY]: { username: p.user, password: p.pass, host: p.host } });
  } else {
    await chrome.storage.local.remove(PROXY_AUTH_KEY);
  }

  return `已连接：${node.name} (${p.host}:${p.port}) · ${settings.mode === 'global' ? '全局' : '分流'}`;
}

// 清除代理：还原系统设置并删掉暂存凭据
export async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await chrome.storage.local.remove(PROXY_AUTH_KEY);
  return '已断开，恢复系统直连';
}

// 便捷：读取当前设置与选中节点，供 SW/popup 复用
export async function resolveActive() {
  const { settings, nodes } = await loadAll();
  const node = nodes.find((n) => n.id === settings.activeNodeId) || null;
  return { settings, nodes, node };
}
