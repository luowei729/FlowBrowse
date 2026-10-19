// options.js —— 管理页逻辑：订阅/节点 CRUD + 规则远程更新 + 通用设置；全部经 SW 消息路由
const $ = (id) => document.getElementById(id);
function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: '后台无响应' })));
}
// HTML 文本转义：节点/订阅名可能含用户输入，防 XSS 注入到管理页
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(ms) { return ms ? new Date(ms).toLocaleString('zh-CN') : '—'; }
function btn(label, variant, onClick) {
  const b = document.createElement('button');
  b.className = 'small ' + (variant || 'ghost');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

let STATE = null;

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (!resp.ok) { $('msg').textContent = resp.error || '后台未就绪'; return; }
  render(resp.state);
}

function render(state) {
  STATE = state;
  const { settings, nodes, subs, runtime } = state;

  // —— 订阅列表 ——
  const sl = $('subList');
  sl.innerHTML = '';
  if (!subs.length) sl.innerHTML = '<li class="muted">暂无订阅，粘贴订阅地址即可添加</li>';
  for (const s of subs) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="title">${esc(s.name)}</div><div class="sub">${esc(s.url)}</div>` +
      `<div class="sub">上次更新 ${fmtTime(s.lastRefresh)} · 节点数 ${(s.nodeKeys || []).length}</div>`;
    li.append(info);
    li.append(
      btn('刷新', 'ghost', () => send({ action: 'refreshSubscription', id: s.id }).then(refresh)),
      btn('删除', 'danger', () => { if (confirm('删除该订阅及其导入的节点？')) send({ action: 'deleteSubscription', id: s.id }).then(refresh); })
    );
    sl.append(li);
  }

  // —— 节点列表 ——
  const nl = $('nodeList');
  nl.innerHTML = '';
  if (!nodes.length) nl.innerHTML = '<li class="muted">暂无节点，可手动添加或从订阅导入</li>';
  for (const n of nodes) {
    const active = n.id === settings.activeNodeId;
    const p = runtime.lastProbe && runtime.lastProbe[n.id];
    const rtt = p ? (p.ok ? ` · ${p.rttMs}ms` : ' · QUIC✕') : '';
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const tagCur = active ? '<span class="tag">当前</span> ' : '';
    const tagSrc = `<span class="tag ${n.source === 'subscribe' ? 'subs' : ''}">${n.source === 'subscribe' ? '订阅' : '手动'}</span>`;
    info.innerHTML = `<div class="title">${esc(n.name)} ${tagCur}${tagSrc}</div>` +
      `<div class="sub">${esc(n.proxy.host)}:${n.proxy.port}${n.region ? ' · ' + esc(n.region) : ''}${esc(rtt)}</div>`;
    li.append(info);
    const bSel = btn(active ? '已选中' : '选为当前', 'ghost', () => send({ action: 'selectNode', id: n.id }).then(refresh));
    if (active) bSel.disabled = true;
    li.append(
      bSel,
      btn('编辑', 'ghost', () => fillNodeForm(n)),
      btn('删除', 'danger', () => { if (confirm('删除该节点？')) send({ action: 'deleteNode', id: n.id }).then(refresh); })
    );
    nl.append(li);
  }

  // —— 设置回填 ——
  $('rulesRemoteEnabled').checked = !!settings.rulesRemoteEnabled;
  $('rulesUrlDomains').value = settings.rulesRemoteUrlDomains || '';
  $('rulesUrlCidrs').value = settings.rulesRemoteUrlCidrs || '';
  $('autoConnect').checked = !!settings.autoConnectOnStartup;
  $('probeInterval').value = settings.probeIntervalMinutes || 10;
}

// ===== 订阅：添加/更新（同名 url 会更新并重新拉取节点）=====
$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('subUrl').value.trim();
  const name = $('subName').value.trim();
  if (!url) return;
  $('msg').textContent = '拉取订阅中…';
  const resp = await send({ action: 'addSubscription', name, url });
  $('msg').textContent = resp.ok ? '订阅已导入' : ('订阅失败：' + resp.error);
  if (resp.ok) { $('subUrl').value = ''; $('subName').value = ''; await refresh(); }
});
$('refreshAll').addEventListener('click', async () => {
  $('msg').textContent = '刷新全部订阅中…';
  await send({ action: 'refreshAllSubscriptions' });
  $('msg').textContent = '已刷新';
  refresh();
});

// ===== 节点：表单 =====
function fillNodeForm(n) {
  $('nodeId').value = n.id;
  $('nName').value = n.name || '';
  $('nRegion').value = n.region || '';
  $('nHost').value = n.proxy.host || '';
  $('nTcp').value = n.proxy.port || '';
  $('nUser').value = n.proxy.user || '';
  $('nPass').value = n.proxy.pass || '';
  $('nodeSubmit').textContent = '保存修改';
  $('nodeCancel').hidden = false;
  window.scrollTo({ top: $('nodeForm').offsetTop, behavior: 'smooth' });
}
function resetNodeForm() {
  $('nodeForm').reset();
  $('nodeId').value = '';
  $('nodeSubmit').textContent = '添加节点';
  $('nodeCancel').hidden = true;
}
$('nodeCancel').addEventListener('click', resetNodeForm);
$('nodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = {
    name: $('nName').value.trim(),
    region: $('nRegion').value.trim(),
    proxy: {
      host: $('nHost').value.trim(),
      port: parseInt($('nTcp').value, 10) || 443,
      scheme: 'https',
      user: $('nUser').value.trim(),
      pass: $('nPass').value,
    },
  };
  const id = $('nodeId').value;
  const resp = await send(id ? { action: 'updateNode', id, input } : { action: 'addNode', input });
  $('msg').textContent = resp.ok ? '节点已保存' : ('保存失败：' + resp.error);
  if (resp.ok) { resetNodeForm(); await refresh(); }
});

// ===== 规则与通用设置：一次保存 =====
$('saveSettings').addEventListener('click', async () => {
  const patch = {
    rulesRemoteEnabled: $('rulesRemoteEnabled').checked,
    rulesRemoteUrlDomains: $('rulesUrlDomains').value.trim(),
    rulesRemoteUrlCidrs: $('rulesUrlCidrs').value.trim(),
    autoConnectOnStartup: $('autoConnect').checked,
    probeIntervalMinutes: parseInt($('probeInterval').value, 10) || 10,
  };
  const resp = await send({ action: 'setSettings', patch });
  $('msg').textContent = resp.ok ? '已保存' : ('保存失败：' + resp.error);
  if (resp.ok) refresh();
});

// 初始化 + 存储变化实时刷新
refresh();
chrome.storage.onChanged.addListener(() => refresh());
