// node-manager.js —— 手动节点的增/改/删（订阅来源节点由 subscription.js 管理，二者共享同一 nodes 数组）
import { getNodes, saveNodes, genId } from './config.js';

// 规范化输入：补齐默认、去掉空字段，保证节点结构一致
function normalize(input) {
  const proxy = input.proxy || {};
  return {
    name: (input.name || proxy.host || '未命名节点').trim(),
    region: (input.region || '').trim(),
    proxy: {
      host: (proxy.host || '').trim(),
      port: parseInt(proxy.port, 10) || 443,
      scheme: proxy.scheme || 'https',   // 主干默认 https 转发代理
      user: proxy.user || '',
      pass: proxy.pass || '',
    },
    wtPort: parseInt(input.wtPort, 10) || 443,
    // 白名单管理密钥（订阅带入或手动填）：保留到节点，供 options “IP 白名单”页自动取用
    adminToken: (input.adminToken || '').trim(),
  };
}

// 添加手动节点
export async function addNode(input) {
  const nodes = await getNodes();
  const node = { id: genId('n'), source: 'manual', ...normalize(input) };
  nodes.push(node);
  await saveNodes(nodes);
  return nodes;
}

// 更新节点（按 id）
export async function updateNode(id, input) {
  const nodes = await getNodes();
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error('节点不存在');
  // 保留原 id/source/subId，只覆盖可变字段
  nodes[idx] = { ...nodes[idx], ...normalize(input) };
  await saveNodes(nodes);
  return nodes;
}

// 删除节点（手动/订阅来源都可删；订阅来源删除后下次刷新会重新引入，属预期）
export async function deleteNode(id) {
  const nodes = await getNodes();
  const next = nodes.filter((n) => n.id !== id);
  await saveNodes(next);
  return next;
}

// 列表（附带来源标签，便于 UI 区分手动/订阅）
export async function listNodes() {
  return await getNodes();
}
