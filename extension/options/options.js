// options.js —— Zero Omega 风格管理页：左侧栏分页 SPA。所有写操作经 SW 消息，保证与运行时一致。
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (resp) => resolve(resp || { ok: false, error: '后台无响应' })));
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let STATE = null;

// ===== 左侧栏切换 =====
$$('#nav a').forEach((a) => {
  a.addEventListener('click', () => {
    $$('#nav a').forEach((x) => x.classList.toggle('active', x === a));
    $$('.page').forEach((p) => { p.hidden = p.dataset.page !== a.dataset.page; });
  });
});

// ===== 渲染：情景模式（代理节点表格）=====
function renderProfiles(state) {
  const { settings, nodes, runtime } = state;
  const active = settings.activeProfile || (settings.mode === 'off' ? 'direct' : (settings.mode === 'global' ? 'node:' + settings.activeNodeId : 'auto'));
  const tbody = $('profileRows');
  tbody.innerHTML = '';
  if (!nodes.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无代理情景模式，点上方“添加代理情景模式”或到“订阅”导入。</td></tr>';
    return;
  }
  for (const n of nodes) {
    const tr = document.createElement('tr');
    const p = runtime.lastProbe && runtime.lastProbe[n.id];
    const lat = p ? (p.ok ? ` · ${p.latencyMs}ms` : ' · 不可达') : '';
    const badges = [];
    if (active === 'node:' + n.id) badges.push('<span class="badge cur">当前</span>');
    if (settings.autoNodeId === n.id) badges.push('<span class="badge def">默认代理</span>');
    if (n.source === 'subscribe') badges.push('<span class="badge sub">订阅</span>');
    tr.innerHTML =
      `<td>${esc(n.name)}</td>` +
      `<td>${esc((n.proxy.scheme || 'https').toUpperCase())}</td>` +
      `<td>${esc(n.proxy.host)}:${n.proxy.port}</td>` +
      `<td>${esc(n.region || '')}${lat}</td>` +
      `<td>${badges.join(' ') || '<span class="muted">—</span>'}</td>` +
      `<td><div class="ops"></div></td>`;
    const ops = tr.querySelector('.ops');
    ops.append(
      btn('设为默认代理', 'link', () => send({ action: 'selectNode', id: n.id }).then(apply)),
      btn('编辑', 'link', () => openNodeForm(n)),
      btn('删除', 'link danger', () => { if (confirm(`删除「${n.name}」？`)) send({ action: 'deleteNode', id: n.id }).then(apply); })
    );
    tbody.append(tr);
  }
}
function btn(text, cls, fn) { const b = document.createElement('button'); b.textContent = text; b.className = cls; b.addEventListener('click', fn); return b; }

// ===== 渲染：订阅列表 =====
function renderSubs(state) {
  const { subs } = state;
  const ul = $('subList');
  ul.innerHTML = '';
  if (!subs.length) { ul.innerHTML = '<li class="muted">暂无订阅</li>'; return; }
  for (const s of subs) {
    const li = document.createElement('li');
    const head = document.createElement('div'); head.className = 'sub-head';
    head.innerHTML = `<b>${esc(s.name)}</b><span class="muted">${esc(s.url)}</span>`;
    li.append(head);
    li.append(
      btn('刷新', 'link', () => send({ action: 'refreshSubscription', id: s.id }).then(apply)),
      btn('删除', 'link danger', () => { if (confirm(`删除订阅「${s.name}」及其节点？`)) send({ action: 'deleteSubscription', id: s.id }).then(apply); })
    );
    ul.append(li);
  }
}

// ===== 渲染：规则/通用回填 =====
function renderForms(state) {
  const { settings } = state;
  $('rulesRemoteEnabled').checked = !!settings.rulesRemoteEnabled;
  $('rulesUrlDomains').value = settings.rulesRemoteUrlDomains || '';
  $('rulesUrlCidrs').value = settings.rulesRemoteUrlCidrs || '';
  $('customDirect').value = settings.customDirect || '';
  $('customProxy').value = settings.customProxy || '';
  $('probeInterval').value = settings.probeIntervalMinutes || 10;
  // 规则来源状态
  const rc = state.rulesCache;
  const el = $('rulesStatus');
  if (settings.rulesRemoteEnabled && rc && rc.updatedAt && Array.isArray(rc.domains)) {
    el.textContent = `当前：远程缓存，更新于 ${new Date(rc.updatedAt).toLocaleString()}（域名 ${rc.domains.length} / IP ${rc.cidrs.length}）`;
  } else {
    el.textContent = '当前：内置规则（全量 CN 域名 + IP 段）';
  }
}

async function apply() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) { STATE = resp.state; renderProfiles(STATE); renderSubs(STATE); renderForms(STATE); }
}

// ===== 代理情景模式：新增/编辑表单 =====
function openNodeForm(n) {
  $('nodeForm').hidden = false;
  $('nodeFormTitle').textContent = n ? '编辑代理情景模式' : '添加代理情景模式';
  $('nodeId').value = n ? n.id : '';
  $('nName').value = n ? n.name || '' : '';
  $('nRegion').value = n ? n.region || '' : '';
  $('nScheme').value = n ? (n.proxy.scheme || 'https') : 'https';
  $('nHost').value = n ? n.proxy.host || '' : '';
  $('nTcp').value = n ? n.proxy.port || '' : '443';
  $('nUser').value = n ? n.proxy.user || '' : '';
  $('nPass').value = n ? n.proxy.pass || '' : '';
  $('nodeForm').scrollIntoView({ behavior: 'smooth' });
}
function closeNodeForm() { $('nodeForm').hidden = true; $('nodeForm').reset(); $('nodeId').value = ''; }
$('addProfile').addEventListener('click', () => openNodeForm(null));
$('nodeCancel').addEventListener('click', closeNodeForm);
$('nodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = {
    name: $('nName').value.trim() || $('nHost').value.trim(),
    region: $('nRegion').value.trim(),
    proxy: {
      host: $('nHost').value.trim(),
      port: parseInt($('nTcp').value, 10) || 443,
      scheme: $('nScheme').value || 'https',
      user: $('nUser').value.trim(),
      pass: $('nPass').value,
    },
  };
  const id = $('nodeId').value;
  const resp = await send(id ? { action: 'updateNode', id, input } : { action: 'addNode', input });
  if (resp && resp.ok) { closeNodeForm(); apply(); } else alert('保存失败：' + (resp && resp.error));
});

// ===== 订阅 =====
$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('subUrl').value.trim();
  if (!url) return;
  const resp = await send({ action: 'addSubscription', name: $('subName').value.trim(), url });
  if (resp && resp.ok) { $('subUrl').value = ''; $('subName').value = ''; apply(); } else alert('订阅失败：' + (resp && resp.error));
});
$('refreshAll').addEventListener('click', async () => { await send({ action: 'refreshAllSubscriptions' }); apply(); });

// ===== 规则 / 通用 保存 =====
$('saveRules').addEventListener('click', async () => {
  await send({ action: 'setSettings', patch: {
    rulesRemoteEnabled: $('rulesRemoteEnabled').checked,
    rulesRemoteUrlDomains: $('rulesUrlDomains').value.trim(),
    rulesRemoteUrlCidrs: $('rulesUrlCidrs').value.trim(),
  } });
  $('rulesMsg').textContent = '已保存'; setTimeout(() => ($('rulesMsg').textContent = ''), 1500);
});
// 保存自定义不代理/强制代理列表（setSettings 会触发重套 PAC，立即生效）
$('saveCustom').addEventListener('click', async () => {
  await send({ action: 'setSettings', patch: { customDirect: $('customDirect').value, customProxy: $('customProxy').value } });
  $('customMsg').textContent = '已保存并生效'; setTimeout(() => ($('customMsg').textContent = ''), 1500);
});
// 立即更新：先存远程设置，再拉取写缓存并重套 PAC
$('updateRules').addEventListener('click', async () => {
  await send({ action: 'setSettings', patch: {
    rulesRemoteEnabled: $('rulesRemoteEnabled').checked,
    rulesRemoteUrlDomains: $('rulesUrlDomains').value.trim(),
    rulesRemoteUrlCidrs: $('rulesUrlCidrs').value.trim(),
  } });
  $('rulesMsg').textContent = '更新中…';
  const resp = await send({ action: 'updateRules' });
  if (resp && resp.ok) { $('rulesMsg').textContent = `已更新：域名 ${resp.info.domainCount} / IP ${resp.info.cidrCount}`; apply(); }
  else { $('rulesMsg').textContent = '更新失败：' + ((resp && resp.error) || ''); }
  setTimeout(() => ($('rulesMsg').textContent = ''), 4000);
});
$('saveGeneral').addEventListener('click', async () => {
  await send({ action: 'setSettings', patch: { probeIntervalMinutes: parseInt($('probeInterval').value, 10) || 10 } });
  $('generalMsg').textContent = '已保存'; setTimeout(() => ($('generalMsg').textContent = ''), 1500);
});

// ===== 导入 / 导出 =====
$('exportBtn').addEventListener('click', () => {
  if (!STATE) return;
  const data = { version: 1, settings: STATE.settings, nodes: STATE.nodes, subs: STATE.subs };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'flowbrowse-config.json'; a.click();
  URL.revokeObjectURL(a.href);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !Array.isArray(data.nodes)) throw new Error('格式不符');
    await send({ action: 'importConfig', data });
    $('ioMsg').textContent = '导入成功'; apply();
  } catch (err) { $('ioMsg').textContent = '导入失败：' + err.message; }
  e.target.value = '';
});

apply();
chrome.storage.onChanged.addListener(() => apply());
