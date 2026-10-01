/* ZeroTier fnOS frontend */
'use strict';

const $ = (s) => document.querySelector(s);

/* fnOS 统一网关把本应用挂在 /app/<appname> 前缀下，直接端口访问则挂在 /。
 * 从当前路径推导前缀，使两种入口都能正确请求后端。 */
const BASE = (function () {
  const m = window.location.pathname.match(/^(\/app\/[^\/]+)/);
  return m ? m[1] : '';
})();
const API_BASE = BASE + '/api';

function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'ok');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function api(path, method, body) {
  const opts = { method: method || 'GET' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  if (!r.ok) {
    // surface the server's own diagnosis, not just the status code
    const parts = [];
    if (data && (data.error || data.msg)) parts.push(data.error || data.msg);
    if (data && data.detail) parts.push(String(data.detail).slice(0, 300));
    const err = new Error(parts.length ? parts.join(' — ') : ('HTTP ' + r.status));
    err.data = data;   // keep the structured payload (subnet notes etc.) for callers
    throw err;
  }
  return data;
}

/* ---------- navigation ---------- */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'subnet') loadSubnet();
  });
});

/* ---------- overview ---------- */
async function loadStatus() {
  try {
    const s = await api('/status');
    const addr = s.address || s.nodeId || '—';
    $('#ov-address').textContent = addr;
    $('#ov-address2').textContent = addr;
    $('#ov-online').textContent = s.online ? '在线' : '离线';
    $('#ov-online').style.color = s.online ? 'var(--green)' : 'var(--red)';
    $('#ov-version').textContent = s.version || s.zeroTierVersion || '—';
    const nets = await api('/network');
    $('#ov-nnetworks').textContent = Array.isArray(nets) ? nets.length : 0;
  } catch (e) {
    console.warn('status load failed:', e);
  }
}
function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 2 : 0) + ' ' + u[i];
}
async function loadNetStats() {
  try {
    const r = await api('/netstats');
    const c = $('#netStats');
    if (!r.ifaces || !r.ifaces.length) { c.innerHTML = '<span class="hint">暂无隧道接口</span>'; return; }
    c.innerHTML = '';
    r.ifaces.forEach((iface) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `
        <div class="stat-name">${esc(iface.name)}</div>
        <div class="stat-meta">${esc(iface.addresses.join(', '))}</div>
        <div class="stat-traffic">
          <span title="接收"><span class="mono">↓</span> ${fmtBytes(iface.rxBytes)}</span>
          <span title="发送"><span class="mono">↑</span> ${fmtBytes(iface.txBytes)}</span>
        </div>`;
      c.appendChild(row);
    });
  } catch (e) {
    console.warn('netstats load failed:', e);
  }
}

/* ---------- networks ---------- */
/* Per-network local options, using ZeroTier's own zerotier-cli `set` keys. */
const NET_OPTS = [
  { key: 'allowManaged', label: '接受网络路由', hint: '使用网络下发的路由', desc: '访问其他成员共享出来的网段时需要（推荐开启）' },
  { key: 'allowGlobal', label: '允许公网路由', hint: '允许全局/公网网段路由', desc: '允许网络下发公网 IP 段的路由，一般不用开' },
  { key: 'allowDefault', label: '全局 VPN 模式', hint: '全部流量经 ZeroTier（全隧道 VPN）', desc: '本机所有上网流量都走 ZeroTier，谨慎开启' },
  { key: 'allowDNS', label: '使用网络 DNS', hint: '使用网络下发的 DNS 服务器', desc: '改用网络管理员指定的 DNS 服务器' },
];
/* Toggling briefly pauses auto-refresh so a poll cannot repaint a switch with
 * pre-change state while the daemon is still applying it. */
let holdRefreshUntil = 0;

async function loadNetworks() {
  if (Date.now() < holdRefreshUntil) return;
  const list = $('#networkList');
  const empty = $('#netEmpty');
  let nets;
  try { nets = await api('/network'); }
  catch (e) { toast('获取网络列表失败：' + e.message, 'error'); return; }
  if (!Array.isArray(nets) || nets.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';
  for (const n of nets) {
    const statusMap = {
      OK: { text: '已连接', cls: 'ok' },
      REQUESTING_CONFIGURATION: { text: '请求配置…', cls: 'pending' },
      ACCESS_DENIED: { text: '访问被拒绝', cls: 'denied' },
      PORT_ERROR: { text: '端口错误', cls: 'offline' },
      CLIENT_TOO_OLD: { text: '客户端过旧', cls: 'offline' },
    };
    const st = statusMap[n.status] || { text: n.status || '未知', cls: 'offline' };
    const ips = (n.assignedAddresses || []).join(', ');
    const div = document.createElement('div');
    div.className = 'net-card';
    div.innerHTML = `
      <div class="net-top">
        <div>
          <div class="net-name">${esc(n.name || '未命名网络')}</div>
          <div class="net-id">${n.nwid || ''}</div>
        </div>
        <span class="net-status ${st.cls}">${st.text}</span>
      </div>
      <div class="net-meta">类型: ${n.type || '-'} · MAC: <span class="mono">${n.mac || '-'}</span></div>
      ${ips
        ? `<div class="ip-list">${(n.assignedAddresses || []).map((a) => `<span class="ip-tag">${esc(a)}</span>`).join('')}</div>`
        : '<div class="net-meta">未分配 IP</div>'}
      <button class="btn btn-sm net-more" data-more="${n.nwid}" aria-expanded="false">
        高级设置 <span class="caret">▾</span>
      </button>
      <div class="net-extra" data-extra="${n.nwid}">
        <div class="net-opts">
          ${NET_OPTS.map((o) => `<label class="opt"><input type="checkbox" data-opt="${o.key}" data-nwid="${n.nwid}"${n[o.key] ? ' checked' : ''} /><span class="opt-text"><span class="opt-label">${o.label}</span><span class="opt-desc">${o.desc}</span></span></label>`).join('')}
        </div>
        <div class="net-actions">
          <button class="btn btn-sm" data-copy="${n.nwid}">复制网络 ID</button>
        </div>
        <div class="net-danger">
          <span class="hint">退出后本机将不再属于该网络</span>
          <button class="btn btn-sm btn-danger" data-leave="${n.nwid}">离开网络</button>
        </div>
      </div>`;
    list.appendChild(div);
  }
  /* 高级设置折叠模块：箭头随展开状态旋转，内容区用 max-height + opacity
   * 做过渡动画；默认收起，避免四个开关挤占卡片视觉焦点。 */
  list.querySelectorAll('[data-more]').forEach((b) => {
    b.addEventListener('click', () => {
      const extra = list.querySelector('[data-extra="' + b.dataset.more + '"]');
      if (!extra) return;
      const open = extra.classList.toggle('open');
      b.classList.toggle('open', open);
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  /* 「离开网络」放在卡片底部的独立危险区，并用两步内联确认代替浏览器
   * 全局弹窗：第一次点击只进入待确认状态，3 秒内再点一次才真正执行。 */
  list.querySelectorAll('[data-leave]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.armed === '1') {
        b.dataset.armed = '';
        leaveNetwork(b.dataset.leave, b);
        return;
      }
      b.dataset.armed = '1';
      b.textContent = '再点一次确认离开';
      b.classList.add('btn-armed');
      setTimeout(() => {
        if (b.dataset.armed === '1') {
          b.dataset.armed = '';
          b.textContent = '离开网络';
          b.classList.remove('btn-armed');
        }
      }, 3000);
    });
  });
  list.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('网络 ID 已复制'));
    });
  });
  list.querySelectorAll('input[data-opt]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      holdRefreshUntil = Date.now() + 2500;
      try {
        await api('/network-option', 'POST', {
          nwid: cb.dataset.nwid,
          option: cb.dataset.opt,
          value: cb.checked,
        });
        const label = (NET_OPTS.find((o) => o.key === cb.dataset.opt) || {}).label || cb.dataset.opt;
        toast(label + (cb.checked ? ' 已开启' : ' 已关闭'));
      } catch (e) {
        toast('设置失败：' + e.message, 'error');
        cb.checked = !cb.checked;   // revert the optimistic UI
      }
    });
  });
}

async function joinNetwork(id) {
  id = (id || '').trim();
  if (!/^[0-9a-fA-F]{16}$/.test(id)) {
    toast('请输入有效的 16 位网络 ID', 'error');
    return;
  }
  try {
    await api('/network/' + id, 'POST', {});
    toast('已发送加入请求');
    loadNetworks(); loadStatus();
  } catch (e) { toast('加入失败：' + e.message, 'error'); }
}

async function leaveNetwork(id, btn) {
  /* 确认已在按钮的两步交互里完成，这里直接执行。 */
  if (btn) { btn.disabled = true; btn.textContent = '离开中…'; }
  try {
    await api('/network/' + id, 'DELETE');
    toast('已离开网络');
    loadNetworks(); loadStatus();
  } catch (e) {
    toast('离开失败：' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '离开网络'; btn.classList.remove('btn-armed'); }
  }
}

/* ---------- peers ---------- */
async function loadPeers() {
  const list = $('#peerList');
  const empty = $('#peerEmpty');
  let peers;
  try { peers = await api('/peer'); }
  catch (e) { toast('获取对端失败：' + e.message, 'error'); return; }
  if (!Array.isArray(peers) || peers.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';
  peers.forEach((p) => {
    const paths = Array.isArray(p.paths) ? p.paths.filter((x) => x && x.active && x.address) : [];
    /* 同一地址可能因多条物理路径重复出现，先去重；地址列表放进可横向
     * 滑动的容器，IPv6 长地址不再挤压布局，也能完整查看。 */
    const addrs = [];
    paths.forEach((x) => { if (addrs.indexOf(x.address) === -1) addrs.push(x.address); });
    const pathIps = addrs.length
      ? '<div class="peer-path-list">' + addrs.map((a) => '<div>' + esc(a) + '</div>').join('') + '</div>'
      : '<span class="hint">中继/无直连</span>';
    const div = document.createElement('div');
    div.className = 'peer-row';
    div.innerHTML = `
      <div class="peer-addr">${esc(p.address || '')}</div>
      <div class="peer-info">
        <div>${esc(p.name || '')} ${p.role ? '· ' + esc(p.role) : ''}</div>
        <div>${p.latency != null && p.latency >= 0 ? '延迟 ' + p.latency + 'ms' : ''}${p.version ? ' · v' + esc(p.version) : ''}</div>
      </div>
      <div class="peer-path">${pathIps}</div>`;
    list.appendChild(div);
  });
}

/* ---------- token visibility ---------- */
/* 默认隐藏。输入框里已有用户正在编辑的内容时，只做密码框/明文框切换；
 * 输入框为空时，点“显示”会从后端取回已保存的令牌填入展示，隐藏时自动清空。 */
let tokenAutoFilled = false;
async function toggleTokenVisibility() {
  const inp = $('#subnetToken');
  const btn = $('#btnToggleToken');
  if (inp.type === 'password') {
    if (!inp.value.trim() && !tokenAutoFilled) {
      try {
        const r = await api('/subnet/token', 'GET');
        if (r && r.token) { inp.value = r.token; tokenAutoFilled = true; }
        else { toast('尚未保存 API Token', 'error'); return; }
      } catch (e) { toast('读取已保存令牌失败：' + e.message, 'error'); return; }
    }
    inp.type = 'text';
    btn.textContent = '隐藏';
  } else {
    inp.type = 'password';
    btn.textContent = '显示';
    if (tokenAutoFilled) { inp.value = ''; tokenAutoFilled = false; }
  }
}
function resetTokenToggle() {
  tokenAutoFilled = false;
  const inp = $('#subnetToken');
  inp.type = 'password';
  $('#btnToggleToken').textContent = '显示';
}

/* ---------- service control ---------- */
function setServiceState(on) {
  $('#serviceDot').className = 'dot ' + (on ? 'online' : 'offline');
  $('#serviceLabel').textContent = on ? '服务运行中' : '服务未运行';
}
async function checkService() {
  try { await api('/status'); setServiceState(true); }
  catch (e) { setServiceState(false); }
}
/* 这两个按钮只控制 ZeroTier 守护进程，不会停掉本管理界面本身，
 * 否则用户将无法再从界面上把服务启动回来。整个应用的启停由飞牛应用中心负责。 */
async function svcStart() {
  try {
    await api('/service/start', 'POST');
    toast('ZeroTier 服务启动请求已发送');
    setTimeout(checkService, 2500);
  } catch (e) { toast('启动失败：' + e.message, 'error'); }
}
async function svcStop() {
  try {
    await api('/service/stop', 'POST');
    toast('ZeroTier 服务停止请求已发送');
    setTimeout(checkService, 2500);
  } catch (e) { toast('停止失败：' + e.message, 'error'); }
}

/* ---------- subnet routing ---------- */
/* 把 NAS 所在的局域网共享给 ZeroTier 上的其他设备，需要三件事配合：
 *   1. ZeroTier 网络上一条指向本机 ZeroTier IP 的托管路由（后端写 Central 或本机控制器）
 *   2. 本机开启 IP 转发
 *   3. 本机 NAT / 转发规则（后端 cmd/main 的 subnet-up）
 * 前端只负责收集参数并如实展示每一步的结果，不把没验证过的操作显示成成功。 */
let subnetInfo = null;

/* 192.168.150.10/24 → 192.168.150.0/23：官方建议广播得比实际网段宽一位，
 * 这样一台同时能走本地网线的设备仍会优先走本地网线，而不是绕道 ZeroTier。 */
function widenCidr(cidr) {
  const m = String(cidr || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return '';
  const p = +m[5];
  if (p <= 8 || p >= 32) return '';
  const np = p - 1;
  const ip = ((((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4]) >>> 0);
  const mask = (0xffffffff << (32 - np)) >>> 0;
  const net = (ip & mask) >>> 0;
  return [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.') + '/' + np;
}

function selectedIfaces() {
  if (!subnetInfo || !subnetInfo.interfaces) return [];
  const boxes = document.querySelectorAll('#subnetPhy input[type=checkbox]');
  const names = Array.prototype.map.call(boxes, (b) => b.checked ? b.value : null).filter(Boolean);
  return subnetInfo.interfaces.filter((i) => names.indexOf(i.name) !== -1);
}

function syncTargetDefault() {
  const list = selectedIfaces();
  const targets = [];
  list.forEach((i) => {
    const t = widenCidr(i.cidr) || i.cidr;
    if (t && targets.indexOf(t) === -1) targets.push(t);
  });
  $('#subnetTarget').textContent = targets.length ? targets.join('，') : '按所选网卡自动生成';
  $('#subnetPhyLabel').textContent = list.length ? list.map((i) => i.cidr).join('，') : '本机网段';
}

function subnetRow(label, value, state) {
  const cls = state === true ? 'good' : state === false ? 'bad' : '';
  return '<div class="subnet-row"><span class="subnet-row-label">' + esc(label) + '</span>' +
         '<span class="subnet-row-value ' + cls + '">' + esc(value) + '</span></div>';
}

function renderSubnetStatus() {
  const el = $('#subnetStatus');
  const badge = $('#subnetBadge');
  const info = subnetInfo;
  const c = info && info.config;
  if (!c) {
    badge.textContent = '未开启';
    badge.className = 'net-status offline';
    el.innerHTML = '尚未开启。选择要共享的网段和 ZeroTier 网络后，点击下方「开启子网路由」。';
    return;
  }
  badge.textContent = '已开启';
  badge.className = 'net-status ok';
  const l = (info && info.local) || {};
  const fwd = l.ipForward === '1';
  const phys = c.phyIfaces || [];
  const targets = c.targets || [];
  let rows = '';
  rows += subnetRow('共享物理网卡', phys.join('，'), null);
  rows += subnetRow('广播网段', targets.join('，'), null);
  rows += subnetRow('ZeroTier 网络', c.nwid, null);
  rows += subnetRow('本机在网内的 IP', c.via, null);
  targets.forEach((t) => {
    rows += subnetRow('网络上的托管路由', t + ' → ' + c.via, null);
  });
  rows += subnetRow('系统 IP 转发', fwd ? '已开启' : ('未开启' + (l.ipForward ? '（当前值 ' + l.ipForward + '）' : '')), fwd);
  // Per-interface rule state: which NIC is missing the rule is visible now.
  (l.perIface || []).forEach((p) => {
    rows += subnetRow('NAT 伪装（' + p.name + '）', p.natRule ? '已配置' : '缺失', p.natRule);
    rows += subnetRow('转发放行（' + p.name + '）', p.forwardRules ? '已配置' : '缺失', p.forwardRules);
  });
  rows += subnetRow('重开机后自动恢复', '是（每次服务启动时重新应用）', true);
  el.innerHTML = rows;
  /* 转发要三段都成立，缺一段外部设备就访问不到局域网。把它们按顺序摆出来，
   * 出问题时用户能自己定位是哪一段，而不是只知道“不好用”。 */
  el.innerHTML += '<p class="hint">转发链路：① 网络上存在上面' +
    (targets.length > 1 ? '那些' : '那条') + '托管路由（在 ZeroTier Central 的 Managed Routes 里核对）；' +
    '② 对端设备开启了「托管路由」(allowManaged)（在它的 ZeroTier 客户端里核对）；' +
    '③ 本机每张网卡的 NAT 与放行规则都为“已配置”。外部设备访问不到局域网时，就按这个顺序逐段排查。</p>';
  if (l.rc !== undefined && l.rc !== 0) {
    el.innerHTML += '<p class="hint">本机状态读取失败（退出码 ' + esc(String(l.rc)) +
      '），通常是缺少 iptables 或权限不足。</p>';
  }
}

async function loadSubnet() {
  let info;
  try { info = await api('/subnet/info'); }
  catch (e) { $('#subnetStatus').textContent = '读取失败：' + e.message; return; }
  subnetInfo = info;

  const phy = $('#subnetPhy');
  const savedPhys = (info.config && info.config.phyIfaces) || [];
  phy.innerHTML = '';
  if (!info.interfaces || !info.interfaces.length) {
    phy.innerHTML = '<span class="hint">（没有检测到局域网网卡）</span>';
  } else {
    info.interfaces.forEach((i) => {
      const lab = document.createElement('label');
      lab.className = 'iface-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = i.name;
      if (savedPhys.indexOf(i.name) !== -1) cb.checked = true;
      if (info.config) cb.disabled = true;   // disable changes while it is on
      lab.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = i.name + ' · ' + i.cidr;
      lab.appendChild(txt);
      phy.appendChild(lab);
    });
  }

  const net = $('#subnetNet');
  const wantNet = (info.config && info.config.nwid) || net.value || '';
  net.innerHTML = '';
  if (!info.networks || !info.networks.length) {
    net.innerHTML = '<option value="">（还没有加入任何网络）</option>';
  } else {
    info.networks.forEach((n) => {
      const o = document.createElement('option');
      o.value = n.nwid;
      o.textContent = (n.name || '未命名网络') + ' · ' + n.nwid +
        (n.ztAddress ? ' · ' + n.ztAddress : ' · 未分配 IP');
      net.appendChild(o);
    });
    if (wantNet && info.networks.some((n) => n.nwid === wantNet)) net.value = wantNet;
  }

  if (info.config && info.config.targets && info.config.targets.length) {
    $('#subnetTarget').textContent = info.config.targets.join('，');
    // label the real CIDRs behind the saved interfaces
    const cidrs = (info.config.phyIfaces || []).map((n) => {
      const f = (info.interfaces || []).find((x) => x.name === n);
      return f ? f.cidr : n;
    });
    $('#subnetPhyLabel').textContent = cidrs.join('，');
  } else {
    syncTargetDefault();
  }

  $('#subnetTokenState').textContent = info.tokenSaved
    ? '已保存 API Token（默认隐藏，点输入框右侧「显示」可查看完整内容）'
    : '未保存 API Token —— 只有该网络由本机自建控制器托管时，才能不填令牌自动添加托管路由';

  const on = !!info.config;
  $('#btnSubnetOn').disabled = on;
  $('#btnSubnetOff').disabled = !on;
  renderSubnetStatus();
}

function showSubnetLog(payload) {
  const el = $('#subnetLog');
  const lines = [];
  if (payload && payload.error) lines.push('错误：' + payload.error);
  if (payload && Array.isArray(payload.notes)) payload.notes.forEach((n) => lines.push('· ' + n));
  if (payload && payload.detail) lines.push(payload.detail);
  if (!lines.length) lines.push('完成，没有额外输出。');
  el.textContent = lines.join('\n');
  el.classList.toggle('bad', !!(payload && payload.error));
}

async function subnetOn() {
  const nwid = $('#subnetNet').value;
  const phyIfaces = selectedIfaces().map((i) => i.name);
  if (!nwid) { toast('请先加入一个 ZeroTier 网络', 'error'); return; }
  if (!phyIfaces.length) { toast('请至少勾选一张要共享的本机网卡', 'error'); return; }
  const body = { nwid: nwid, phyIfaces: phyIfaces };
  const tok = $('#subnetToken').value.trim();
  if (tok) body.token = tok;

  const btn = $('#btnSubnetOn');
  btn.disabled = true;
  btn.textContent = '配置中…';
  try {
    const r = await api('/subnet/enable', 'POST', body);
    showSubnetLog(r);
    toast('子网路由已开启');
    $('#subnetToken').value = '';
    resetTokenToggle();
  } catch (e) {
    toast('开启失败：' + e.message, 'error');
    showSubnetLog(e.data || { error: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '开启子网路由';
  }
  await loadSubnet();
}

async function subnetOff() {
  if (!confirm('确定关闭子网路由吗？\n\n本机将停止转发这个网段，ZeroTier 网络上的托管路由也会被移除。')) return;
  const btn = $('#btnSubnetOff');
  btn.disabled = true;
  btn.textContent = '关闭中…';
  try {
    const r = await api('/subnet/disable', 'POST', {});
    showSubnetLog(r);
    toast(r && r.ok ? '子网路由已关闭' : '本机已关闭，但托管路由需要手动处理', r && r.ok ? 'ok' : 'error');
  } catch (e) {
    toast('关闭失败：' + e.message, 'error');
    showSubnetLog(e.data || { error: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '关闭子网路由';
  }
  await loadSubnet();
}

async function saveSubnetToken() {
  const t = $('#subnetToken').value.trim();
  if (!t) { toast('请先粘贴 API Token', 'error'); return; }
  const btn = $('#btnSaveToken');
  btn.disabled = true;
  try {
    await api('/subnet/token', 'POST', { token: t });
    $('#subnetToken').value = '';
    resetTokenToggle();
    toast('API Token 已保存');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  } finally { btn.disabled = false; }
  await loadSubnet();
}

async function clearSubnetToken() {
  try {
    await api('/subnet/token', 'POST', { clear: true });
    resetTokenToggle();
    toast('API Token 已清除');
  } catch (e) { toast('清除失败：' + e.message, 'error'); }
  await loadSubnet();
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- wire up ---------- */
$('#btnJoin2').addEventListener('click', () => joinNetwork($('#joinId').value));
$('#btnJoinQuick').addEventListener('click', () => joinNetwork($('#ov-networkId').value));
$('#joinId').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNetwork($('#joinId').value); });
$('#ov-networkId').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNetwork($('#ov-networkId').value); });
$('#btnCopyAddress').addEventListener('click', () => {
  navigator.clipboard.writeText($('#ov-address').textContent).then(() => toast('设备地址已复制'));
});
$('#btnStart').addEventListener('click', svcStart);
$('#btnStop').addEventListener('click', svcStop);

/* subnet routing controls */
$('#subnetPhy').addEventListener('change', syncTargetDefault);
$('#btnSubnetOn').addEventListener('click', subnetOn);
$('#btnSubnetOff').addEventListener('click', subnetOff);
$('#btnSaveToken').addEventListener('click', saveSubnetToken);
$('#btnClearToken').addEventListener('click', clearSubnetToken);
$('#btnToggleToken').addEventListener('click', toggleTokenVisibility);

/* manual refresh buttons */
$('#btnRefreshNet').addEventListener('click', () => { holdRefreshUntil = 0; loadNetworks(); loadStatus(); toast('网络列表已刷新'); });
$('#btnRefreshPeers').addEventListener('click', () => { loadPeers(); toast('对端列表已刷新'); });
$('#btnRefreshStats').addEventListener('click', () => { loadNetStats(); });

function refresh() { loadStatus(); loadNetworks(); loadPeers(); checkService(); loadNetStats(); }
refresh();
setInterval(refresh, 8000);