// popup.js —— Zero Omega 风格情景模式切换器：点一下就切换，不再有独立"连接/断开"
// 只通过 SW 消息读写状态，UI 不直接碰 chrome.storage/proxy。
const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (resp) => resolve(resp || { ok: false, error: '后台无响应' })));
}

// 计算当前生效的 activeProfile（含旧数据迁移，与 config.resolveProfile 口径一致）
function currentProfile(settings) {
  if (settings.activeProfile) return settings.activeProfile;
  return settings.mode === 'off' ? 'direct' : (settings.mode === 'global' ? 'node:' + (settings.activeNodeId || '') : 'auto');
}

let STATE = null;

function render(state) {
  STATE = state;
  const { settings, nodes, runtime } = state;
  const active = currentProfile(settings);

  // 组装可切换项：直接连接 / 自动分流 / 各节点
  const items = [
    { id: 'direct', name: '直接连接', ico: '⊘' },
    { id: 'auto', name: '自动分流', ico: '⇄' },
  ];
  for (const n of nodes) {
    const p = runtime.lastProbe && runtime.lastProbe[n.id];
    const meta = p ? (p.ok ? `${p.latencyMs}ms` : '不可达') : '';
    items.push({ id: 'node:' + n.id, name: n.name || n.proxy.host, ico: '●', meta, tag: n.region || '' });
  }

  const ul = $('profileList');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    if (it.id === active) li.classList.add('active');
    const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = it.ico;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = it.name;
    li.append(ico, name);
    if (it.tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = it.tag; li.append(t); }
    if (it.meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = it.meta; li.append(m); }
    li.addEventListener('click', async () => {
      if (it.id === active) return;
      const resp = await send({ action: 'selectProfile', profileId: it.id });
      if (resp && resp.ok) render(resp.state);
      else if (resp) alert('切换失败：' + resp.error);
    });
    ul.append(li);
  }

  const cur = items.find((i) => i.id === active);
  $('curName').textContent = cur ? cur.name : '直接连接';
  $('statusText').textContent = runtime.statusText || '未连接';
}

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) render(resp.state);
  else $('statusText').textContent = resp && resp.error ? resp.error : '后台未就绪';
}

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnProbe').addEventListener('click', async () => {
  $('statusText').textContent = '测速中…';
  const resp = await send({ action: 'probeActive' });
  if (resp && resp.ok) render(resp.state);
  else refresh();
});

refresh();
chrome.storage.onChanged.addListener(() => refresh());
