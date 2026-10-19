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

  // 状态灯与文本
  $('dot').className = 'dot ' + (connected ? 'on' : 'off');
  $('status').textContent = runtime.statusText || (connected ? '已连接' : '未连接');

  // 连接按钮：已连接显示"断开"
  const btn = $('connectBtn');
  btn.textContent = connected ? '断开' : '连接';
  btn.classList.toggle('disconnect', connected);

  // 节点下拉
  const sel = $('nodeSel');
  sel.innerHTML = '';
  if (!nodes.length) {
    const opt = document.createElement('option');
    opt.textContent = '（无节点，请到"设置"添加节点或订阅）';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    $('connectBtn').disabled = true;
    $('probeBtn').disabled = true;
  } else {
    sel.disabled = false;
    $('connectBtn').disabled = false;
    $('probeBtn').disabled = false;
    for (const n of nodes) {
      const probe = runtime.lastProbe && runtime.lastProbe[n.id];
      const rtt = probe ? (probe.ok ? ` ${probe.rttMs}ms` : ' ✕') : '';
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = `${n.name}${n.region ? ' · ' + n.region : ''}${rtt}`;
      sel.appendChild(opt);
    }
    sel.value = settings.activeNodeId || nodes[0].id;
  }

  // 模式
  $('modeSel').value = settings.mode || 'split';

  // 端口覆盖（值来自设置；占位提示节点默认）
  const active = nodes.find((n) => n.id === (sel.value || settings.activeNodeId));
  $('tcpPort').value = settings.portOverrideTcp || '';
  $('udpPort').value = settings.portOverrideUdp || '';
  if (active) {
    $('tcpPort').placeholder = '默认 ' + active.proxy.port;
    $('udpPort').placeholder = '默认 ' + (active.wtPort || 443);
  }

  // 当前节点延迟
  const p = active && runtime.lastProbe ? runtime.lastProbe[active.id] : null;
  $('rtt').textContent = p ? (p.ok ? `QUIC RTT：${p.rttMs} ms` : `QUIC 不可用：${p.error || ''}`) : '';
}

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) render(resp.state);
  else $('status').textContent = resp && resp.error ? resp.error : '后台未就绪';
}

// ===== 事件绑定 =====
$('connectBtn').addEventListener('click', async () => {
  const connected = STATE && STATE.runtime.connected && STATE.settings.mode !== 'off';
  if (connected) {
    await send({ action: 'disconnect' });
  } else {
    const nodeId = $('nodeSel').value;
    if (!nodeId) return;
    const resp = await send({ action: 'connect', nodeId });
    if (resp && !resp.ok) alert('连接失败：' + resp.error);
  }
  refresh();
});

$('modeSel').addEventListener('change', async (e) => {
  const resp = await send({ action: 'setMode', mode: e.target.value });
  if (resp && resp.ok) render(resp.state);
});

// 切换节点：若处于连接中则立即重连到所选节点
$('nodeSel').addEventListener('change', async () => {
  const connected = STATE && STATE.runtime.connected && STATE.settings.mode !== 'off';
  if (connected) await send({ action: 'connect', nodeId: $('nodeSel').value });
  refresh();
});

// 端口覆盖：输入变化后应用
async function applyPorts() {
  const tcp = parseInt($('tcpPort').value, 10) || null;
  const udp = parseInt($('udpPort').value, 10) || null;
  const resp = await send({ action: 'setPorts', tcp, udp });
  if (resp && resp.ok) render(resp.state);
}
$('tcpPort').addEventListener('change', applyPorts);
$('udpPort').addEventListener('change', applyPorts);

$('probeBtn').addEventListener('click', async () => {
  $('rtt').textContent = '测速中…';
  const resp = await send({ action: 'probeActive' });
  if (resp && resp.ok) render(resp.state);
  else $('rtt').textContent = '测速失败：' + (resp && resp.error || '');
});

function openOptions() { chrome.runtime.openOptionsPage(); }
$('settingsBtn').addEventListener('click', openOptions);
$('openOptions').addEventListener('click', (e) => { e.preventDefault(); openOptions(); });

// 打开即刷新一次，并监听存储变化实时同步（如 SW 周期更新了探测结果）
refresh();
chrome.storage.onChanged.addListener(() => refresh());
