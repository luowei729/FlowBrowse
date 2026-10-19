// popup.js —— 弹窗逻辑：只通过 SW 消息读写状态，UI 不直接操作 chrome.storage/proxy
const $ = (id) => document.getElementById(id);

// 统一消息封装：Promise 化 chrome.runtime.sendMessage
function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (resp) => resolve(resp || { ok: false, error: '后台无响应' })));
}

let STATE = null;

function render(state) {
  STATE = state;
  const { settings, nodes, runtime } = state;
  const connected = runtime.connected && settings.mode !== 'off';

  // #2 状态胶囊：一眼看出开/关
  const pill = $('statePill');
  pill.className = 'pill ' + (connected ? 'ok' : 'off');
  pill.textContent = connected ? 'ON' : 'OFF';
  $('stateText').textContent = runtime.statusText || (connected ? '已连接' : '未连接');

  // 连接按钮
  const btn = $('connectBtn');
  btn.textContent = connected ? '断开连接' : '连接';

  // 节点下拉
  const sel = $('nodeSelect');
  sel.innerHTML = '';
  const hasNodes = nodes.length > 0;
  if (!hasNodes) {
    const opt = document.createElement('option');
    opt.textContent = '（无节点，请到管理页添加节点或订阅）';
    opt.value = '';
    sel.appendChild(opt);
  } else {
    for (const n of nodes) {
      const p = runtime.lastProbe && runtime.lastProbe[n.id];
      const lat = p ? (p.ok ? ` · ${p.latencyMs}ms` : ' · ✕') : '';
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = `${n.name}${n.region ? ' · ' + n.region : ''}${lat}`;
      sel.appendChild(opt);
    }
    sel.value = settings.activeNodeId || nodes[0].id;
  }
  $('connectBtn').disabled = !hasNodes;
  $('btnProbe').disabled = !hasNodes;

  // 模式单选
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = (settings.mode || 'split') === r.value;
  }

  // 端口覆盖
  const active = nodes.find((n) => n.id === (sel.value || settings.activeNodeId));
  $('portTcp').value = settings.portOverrideTcp || '';
  if (active) $('portTcp').placeholder = '默认 ' + active.proxy.port;

  // 当前节点延迟
  const p = active && runtime.lastProbe ? runtime.lastProbe[active.id] : null;
  $('latency').textContent = p ? (p.ok ? `${p.latencyMs} ms` : `不可达：${p.error || ''}`) : '--';

  renderNodeList(nodes, settings.activeNodeId);
}

function renderNodeList(nodes, activeId) {
  const ul = $('nodeList');
  ul.innerHTML = '';
  if (!nodes.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="muted">暂无节点</span>';
    ul.appendChild(li);
    return;
  }
  for (const n of nodes) {
    const li = document.createElement('li');
    if (n.id === activeId) li.classList.add('active');
    const name = document.createElement('span');
    name.textContent = `${n.name}${n.region ? ' · ' + n.region : ''}`;
    name.style.cursor = 'pointer';
    name.title = '点击选择此节点';
    name.addEventListener('click', async () => {
      await send({ action: 'selectNode', id: n.id });
      refresh();
    });
    const del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'link';
    del.addEventListener('click', async () => {
      if (!confirm(`删除节点「${n.name}」？`)) return;
      await send({ action: 'deleteNode', id: n.id });
      refresh();
    });
    li.appendChild(name);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) render(resp.state);
  else $('stateText').textContent = resp && resp.error ? resp.error : '后台未就绪';
}

// ===== 事件绑定 =====
$('connectBtn').addEventListener('click', async () => {
  const connected = STATE && STATE.runtime.connected && STATE.settings.mode !== 'off';
  if (connected) {
    await send({ action: 'disconnect' });
  } else {
    const nodeId = $('nodeSelect').value;
    if (!nodeId) return;
    const resp = await send({ action: 'connect', nodeId });
    if (resp && !resp.ok) alert('连接失败：' + resp.error);
  }
  refresh();
});

for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    const resp = await send({ action: 'setMode', mode: e.target.value });
    if (resp && resp.ok) render(resp.state);
  });
}

$('nodeSelect').addEventListener('change', async () => {
  const connected = STATE && STATE.runtime.connected && STATE.settings.mode !== 'off';
  if (connected) await send({ action: 'connect', nodeId: $('nodeSelect').value });
  refresh();
});

$('portTcp').addEventListener('change', async () => {
  const tcp = parseInt($('portTcp').value, 10) || null;
  const resp = await send({ action: 'setPorts', tcp });
  if (resp && resp.ok) render(resp.state);
});

$('btnProbe').addEventListener('click', async () => {
  $('latency').textContent = '测速中…';
  const resp = await send({ action: 'probeActive' });
  if (resp && resp.ok) render(resp.state);
  else $('latency').textContent = '测速失败';
});

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// 打开即刷新一次，并监听存储变化实时同步
refresh();
chrome.storage.onChanged.addListener(() => refresh());
