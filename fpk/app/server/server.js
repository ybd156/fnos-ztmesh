#!/usr/bin/env node
/* ZeroTier fnOS backend
 * - serves the static web UI from TRIM_APPDEST/www
 * - proxies /api/* to the local ZeroTier JSON API at 127.0.0.1:19993
 *   using the X-ZT1-Auth token from the zerotier working directory.
 * Uses only Node built-in modules (http, fs, path, http).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const central = require('./central');

const APPDEST = process.env.TRIM_APPDEST || '/var/apps/ztmesh/target';
const PKGVAR  = process.env.TRIM_PKGVAR  || '/var/apps/ztmesh/var';
const APPNAME = process.env.TRIM_APPNAME || 'ztmesh';
const PORT    = parseInt(process.env.TRIM_SERVICE_PORT || process.env.PORT || '13443', 10) || 13443;

const WWW_ROOT  = path.join(APPDEST, 'www');
const ZT_DIR    = path.join(PKGVAR, 'zt');
const ZT_TOKEN  = path.join(ZT_DIR, 'authtoken.secret');
const ZT_PORTFILE = path.join(ZT_DIR, 'zerotier-one.port');
const ZT_HOST = '127.0.0.1';

/* fnOS 统一网关会把本应用挂在 /app/<appname> 前缀下，并通过 target/app.sock
 * 这个 Unix socket 转发已登录用户的请求。同时我们仍在 service_port 上监听，
 * 以便局域网内直接访问。两种入口共用同一套路由，因此这里统一剥掉前缀。 */
const GATEWAY_PREFIX = '/app/' + APPNAME;
const GATEWAY_SOCKET = path.join(APPDEST, 'app.sock');

/* Subnet-routing state.  subnet.conf is read back by cmd/main on every start,
 * because iptables rules and net.ipv4.ip_forward do not survive a reboot.
 * The Central token is a secret: it is written root-only and is never sent back
 * to the browser — the UI only ever learns whether one is stored. */
const SUBNET_CONF = path.join(PKGVAR, 'subnet.conf');
const CENTRAL_TOKEN_FILE = path.join(PKGVAR, 'central_token');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.map':  'application/json',
};

function ztApiPort(){
  try {
    const p = fs.readFileSync(ZT_PORTFILE, 'utf8').trim();
    const n = parseInt(p, 10);
    if (n > 0) return n;
  } catch (e) {}
  // default matches the -p value cmd/main launches the daemon with (19993)
  return 19993;
}

function readToken(){
  try { return fs.readFileSync(ZT_TOKEN, 'utf8').trim(); }
  catch (e) { return null; }
}

function send(res, code, body, type){
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, urlPath){
  let rel = decodeURIComponent(urlPath);
  // prevent path traversal
  if (rel.includes('..')) { send(res, 403, 'Forbidden', 'text/plain'); return; }
  let fp = path.join(WWW_ROOT, rel);
  if (rel === '/' || rel === '') fp = path.join(WWW_ROOT, 'index.html');
  if (!fp.startsWith(WWW_ROOT)) { send(res, 403, 'Forbidden', 'text/plain'); return; }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { send(res, 404, 'Not Found', 'text/plain'); return; }
    const ext = path.extname(fp).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    fs.createReadStream(fp).on('error', () => send(res, 500, 'Read Error', 'text/plain'))
      .pipe(res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }));
  });
}

function proxyApi(req, res, urlPath){
  const token = readToken();
  if (!token) { send(res, 503, JSON.stringify({ error: 'zerotier-service-not-ready', code: 200004 })); return; }
  const apiPort = ztApiPort();
  const targetPath = urlPath.replace(/^\/api/, '') || '/';
  const headers = {
    'Host': ZT_HOST + ':' + apiPort,
    'X-ZT1-Auth': token,
    'Content-Type': req.headers['content-type'] || 'application/json',
  };
  const opts = {
    host: ZT_HOST,
    port: apiPort,
    path: targetPath,
    method: req.method,
    headers: headers,
  };
  const pr = http.request(opts, (pRes) => {
    let chunks = [];
    pRes.on('data', (c) => chunks.push(c));
    pRes.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(pRes.statusCode || 500, {
        'Content-Type': pRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
  pr.on('error', (e) => { send(res, 502, JSON.stringify({ error: 'zerotier-proxy-error', detail: String(e && e.message) })); });
  req.pipe(pr);
}

/* One-shot call against the local ZeroTier JSON API. This is exactly what
 * `zerotier-cli` does internally, and it is the same path join/leave already
 * use, so it does not depend on the CLI being able to locate its home directory
 * from argv[0]. cb(status, bodyText) fires at most once; status 0 means the
 * request never produced an HTTP response. */
function ztApiCall(method, apiPath, bodyObj, cb){
  let done = false;
  let killer = null;
  const finish = (code, text) => {
    if (done) return;
    done = true;
    if (killer) clearTimeout(killer);
    cb(code, text);
  };
  const token = readToken();
  if (!token) { finish(0, 'authtoken.secret not readable'); return; }
  const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
  const apiPort = ztApiPort();
  const headers = { 'Host': ZT_HOST + ':' + apiPort, 'X-ZT1-Auth': token };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
  let pr;
  try {
    pr = http.request({ host: ZT_HOST, port: apiPort, path: apiPath, method: method, headers: headers }, (pRes) => {
      const chunks = [];
      pRes.on('data', (c) => chunks.push(c));
      pRes.on('end', () => finish(pRes.statusCode || 500, Buffer.concat(chunks).toString('utf8')));
    });
  } catch (e) {
    finish(0, 'request failed: ' + String(e && e.message));
    return;
  }
  pr.on('error', (e) => finish(0, 'zerotier api unreachable: ' + String(e && e.message)));
  killer = setTimeout(() => { try { pr.destroy(); } catch (_) {} finish(0, 'zerotier api timeout'); }, 10000);
  if (killer.unref) killer.unref();
  if (payload) pr.write(payload);
  pr.end();
}

/* Locate cmd/main.
 *
 * fnOS passes TRIM_APPDEST as the *already resolved* payload directory, e.g.
 * /vol1/@appcenter/zerotier -- not /var/apps/zerotier/target.  The lifecycle
 * scripts live at /var/apps/<appname>/cmd/, which is a different tree, so
 * deriving the path from dirname(APPDEST) yields /vol1/@appcenter/cmd/main and
 * every `bash <script>` fails with exit 127 ("No such file or directory").
 * Probe the known layouts instead of guessing, and remember what we probed so
 * a failure can say exactly where it looked. */
const MAIN_CANDIDATES = (function(){
  const list = ['/var/apps/' + APPNAME];
  if (process.env.TRIM_PKGMETA) list.push(path.dirname(process.env.TRIM_PKGMETA));
  list.push(path.dirname(APPDEST));
  list.push(APPDEST);
  const seen = {};
  return list.filter((d) => d && !seen[d] && (seen[d] = true));
})();

const MAIN_SCRIPT = (function(){
  for (let i = 0; i < MAIN_CANDIDATES.length; i++) {
    const c = path.join(MAIN_CANDIDATES[i], 'cmd', 'main');
    if (fs.existsSync(c)) return c;
  }
  return path.join(MAIN_CANDIDATES[0], 'cmd', 'main');
})();

// Read a request body with a hard size cap; these endpoints only ever receive
// a tiny JSON object.
function collectBody(req, cb){
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 64 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(''));
}

function runMain(args, cb){
  // cb must fire exactly once: 'error' and 'close' can both arrive.
  let done = false;
  const finish = (code, out) => { if (!done) { done = true; cb(code, out); } };

  // Report a missing script ourselves rather than letting bash fail with a bare
  // 127, and name every location we probed -- on a remote NAS that message is
  // the whole diagnosis.
  if (!fs.existsSync(MAIN_SCRIPT)) {
    finish(127, 'cmd/main not found. probed: ' +
      MAIN_CANDIDATES.map((d) => path.join(d, 'cmd', 'main')).join(', '));
    return;
  }

  let proc;
  try {
    proc = spawn('bash', [MAIN_SCRIPT].concat(args), { env: process.env });
  } catch (e) {
    // spawn() throws synchronously when the interpreter is absent or process
    // creation is denied; an unhandled throw here would kill the web server.
    finish(-1, 'failed to spawn bash: ' + String(e && e.message));
    return;
  }

  let out = '';
  if (proc.stdout) proc.stdout.on('data', (d) => { out += d; });
  if (proc.stderr) proc.stderr.on('data', (d) => { out += d; });
  proc.on('close', (code) => finish(code, out));
  proc.on('error', (e) => finish(-1, String(e && e.message)));

  // never let a wedged lifecycle script hold the HTTP request open forever
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch (_) {}
    finish(-1, 'timeout running cmd/main ' + args.join(' '));
  }, 30000);
  if (killer.unref) killer.unref();
}

/* ===================== subnet routing ===================================== */
/* Makes this NAS a gateway for the LAN it sits on, so ZeroTier members can
 * reach physical devices.  Two halves:
 *   1. the managed route, held by whoever controls the network -- added through
 *      ZeroTier Central when a token is available, or through the local
 *      controller API when this node hosts the network itself;
 *   2. local IP forwarding + NAT, applied by `cmd/main subnet-up`.
 * Both halves are verified rather than assumed. */

function readSubnetConf(){
  try {
    const out = {};
    fs.readFileSync(SUBNET_CONF, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) return;
      let v = m[2];
      // list values are stored quoted so a space-separated list stays one field
      if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    });
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; }
}

// A list field in subnet.conf (space-separated), with fallback to the legacy
// singular key from older package versions.
function confList(conf, key, legacyKey){
  let raw;
  if (conf && conf[key] !== undefined) raw = conf[key];
  else if (conf && legacyKey && conf[legacyKey] !== undefined) raw = conf[legacyKey];
  if (raw === undefined || raw === null) return [];
  return String(raw).split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function writeSubnetConf(fields){
  const order = ['NWID', 'ZT_IFACE', 'PHY_IFACES', 'TARGETS', 'VIA'];
  const lines = order
    .filter((k) => fields[k] !== undefined)
    .map((k) => {
      let v = String(fields[k]).replace(/[\r\n]/g, '');
      if (/\s/.test(v)) v = '"' + v + '"';
      return k + '=' + v;
    });
  fs.writeFileSync(SUBNET_CONF, lines.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(SUBNET_CONF, 0o600); } catch (e) {}
}

function clearSubnetConf(){
  try { fs.unlinkSync(SUBNET_CONF); } catch (e) {}
}

function readSavedToken(){
  try {
    const t = fs.readFileSync(CENTRAL_TOKEN_FILE, 'utf8').trim();
    return t || null;
  } catch (e) { return null; }
}

function saveToken(t){
  fs.writeFileSync(CENTRAL_TOKEN_FILE, t, { mode: 0o600 });
  try { fs.chmodSync(CENTRAL_TOKEN_FILE, 0o600); } catch (e) {}
}

/* The LAN interfaces of this box, straight from the OS — no need to shell out
 * to `ip`/`ifconfig`.  ZeroTier's own devices and container bridges are not the
 * physical LAN, so they are filtered out. */
function physicalInterfaces(){
  const out = [];
  const all = os.networkInterfaces();
  Object.keys(all).forEach((name) => {
    if (/^(zt|lo|docker|veth|br-|virbr|tun|tap|wg)/.test(name)) return;
    (all[name] || []).forEach((a) => {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal) return;
      let cidr = a.cidr;
      if (!cidr) {
        const p = a.netmask ? maskToPrefix(a.netmask) : 24;
        cidr = a.address + '/' + p;
      }
      out.push({ name: name, address: a.address, netmask: a.netmask || '', cidr: cidr });
    });
  });
  return out;
}

function maskToPrefix(mask){
  const parts = String(mask).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return 24;
  let bits = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (p === 255) { bits += 8; continue; }
    let v = p;
    while (v & 0x80) { bits++; v = (v << 1) & 0xff; }
    break;
  }
  return bits;
}

/* Per-interface byte counters from /proc/net/dev (Linux).  On platforms
 * without it the entry is simply absent and the UI shows "—". */
function readNetDev(){
  const out = {};
  let text;
  try { text = fs.readFileSync('/proc/net/dev', 'utf8'); } catch (e) { return out; }
  text.split('\n').slice(2).forEach((line) => {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) return;
    const cols = m[2].trim().split(/\s+/);
    if (cols.length < 9) return;
    const rx = Number(cols[0]), tx = Number(cols[8]);
    if (!isFinite(rx) || !isFinite(tx)) return;
    out[m[1]] = { rx: rx, tx: tx };
  });
  return out;
}

function parseCidr(s){
  const m = String(s || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const p = Number(m[5]);
  if (o.some((n) => n > 255) || p > 32) return null;
  return { octets: o, prefix: p };
}

function cidrToInt(o){
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

function intToIp(n){
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/* The connected subnet an interface address belongs to, e.g.
 * "192.168.250.12/24" -> "192.168.250.0/24". */
function subnetOf(cidr){
  const p = parseCidr(cidr);
  if (!p) return '';
  const mask = p.prefix === 0 ? 0 : (0xffffffff << (32 - p.prefix)) >>> 0;
  return intToIp((cidrToInt(p.octets) & mask) >>> 0) + '/' + p.prefix;
}

/* ZeroTier's own advice: advertise the physical subnet one bit *wider* than it
 * really is, so a device that can reach the LAN directly keeps preferring that
 * path instead of routing through the tunnel.  Computed from the interface
 * address so it yields the correct enclosing block. */
function enlargeCidr(cidr){
  const p = parseCidr(cidr);
  if (!p || p.prefix <= 8 || p.prefix >= 32) return null;
  const np = p.prefix - 1;
  const mask = np === 0 ? 0 : (0xffffffff << (32 - np)) >>> 0;
  return intToIp((cidrToInt(p.octets) & mask) >>> 0) + '/' + np;
}

/* The node's IPv4 address inside a ZeroTier network.
 *
 * ZeroTier networks are dual-stack by default, so assignedAddresses can hold an
 * IPv6 entry before the IPv4 one.  Everything downstream of this is IPv4-only
 * (the managed route's "via", the address shown in the UI), so pick the IPv4
 * out explicitly instead of trusting the array order -- an IPv6 "via" would be
 * written into the route table and silently never match. */
function ipv4Of(addrs){
  const list = Array.isArray(addrs) ? addrs : [];
  for (let i = 0; i < list.length; i++) {
    const s = String(list[i] == null ? '' : list[i]);
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s)) return s.split('/')[0];
  }
  return '';
}

function getZtNetwork(nwid, cb){
  ztApiCall('GET', '/network/' + nwid, undefined, (code, text) => {
    if (code !== 200) return cb('本地 ZeroTier API 返回 HTTP ' + code);
    try { cb(null, JSON.parse(text)); }
    catch (e) { cb('本地 ZeroTier API 返回的不是 JSON'); }
  });
}

function ztNetworks(cb){
  ztApiCall('GET', '/network', undefined, (code, text) => {
    if (code !== 200) return cb([]);
    try {
      const arr = JSON.parse(text);
      cb(Array.isArray(arr) ? arr : []);
    } catch (e) { cb([]); }
  });
}

/* --- path 1: this node hosts the network (self-hosted controller) ---------- */
/* The service API exposes /controller/network/<nwid> when this node is the
 * controller, which needs no token at all. */
function localControllerAddRoute(nwid, target, via, cb){
  ztApiCall('GET', '/controller/network/' + nwid, undefined, (code, text) => {
    if (code !== 200) return cb('本机不是该网络的控制器（HTTP ' + code + '）');
    let net;
    try { net = JSON.parse(text); } catch (e) { return cb('控制器返回的不是 JSON'); }
    const routes = Array.isArray(net.routes)
      ? net.routes.filter((r) => r && r.target).map((r) => ({ target: r.target, via: r.via }))
      : [];
    const hit = routes.find((r) => r.target === target);
    if (hit) hit.via = via; else routes.push({ target: target, via: via });
    ztApiCall('POST', '/controller/network/' + nwid, { routes: routes }, (code2, text2) => {
      if (code2 !== 200 && code2 !== 201) {
        return cb('控制器拒绝更新（HTTP ' + code2 + '）：' + central.clip(text2));
      }
      ztApiCall('GET', '/controller/network/' + nwid, undefined, (code3, text3) => {
        if (code3 !== 200) return cb('写入已发出，但回读失败（HTTP ' + code3 + '）');
        let back;
        try { back = JSON.parse(text3); } catch (e) { return cb('回读结果不是 JSON'); }
        const found = (back.routes || []).find((r) => r && r.target === target);
        if (!found) return cb('写入后回读，控制器上仍没有 ' + target);
        cb(null, routes);
      });
    });
  });
}

function localControllerRemoveRoute(nwid, target, cb){
  ztApiCall('GET', '/controller/network/' + nwid, undefined, (code, text) => {
    if (code !== 200) return cb('本机不是该网络的控制器（HTTP ' + code + '）');
    let net;
    try { net = JSON.parse(text); } catch (e) { return cb('控制器返回的不是 JSON'); }
    const all = Array.isArray(net.routes) ? net.routes.filter((r) => r && r.target) : [];
    const kept = all.filter((r) => r.target !== target)
      .map((r) => ({ target: r.target, via: r.via }));
    if (kept.length === all.length) return cb(null, kept);
    ztApiCall('POST', '/controller/network/' + nwid, { routes: kept }, (code2, text2) => {
      if (code2 !== 200 && code2 !== 201) {
        return cb('控制器拒绝更新（HTTP ' + code2 + '）：' + central.clip(text2));
      }
      ztApiCall('GET', '/controller/network/' + nwid, undefined, (code3, text3) => {
        if (code3 !== 200) return cb('写入已发出，但回读失败（HTTP ' + code3 + '）');
        let back;
        try { back = JSON.parse(text3); } catch (e) { return cb('回读结果不是 JSON'); }
        if ((back.routes || []).find((r) => r && r.target === target)) {
          return cb('写入后回读，' + target + ' 仍然存在');
        }
        cb(null, kept);
      });
    });
  });
}

/* --- choose a path -------------------------------------------------------- */
function addManagedRoute(opts, cb){
  const notes = [];
  const viaLocal = (next) => {
    localControllerAddRoute(opts.nwid, opts.target, opts.via, (err) => {
      if (err) { notes.push('本机控制器：' + err); return next(); }
      notes.push('本机控制器：托管路由已写入并回读确认');
      cb(null, notes);
    });
  };
  if (!opts.token) {
    return viaLocal(() => cb(
      '该网络由 ZeroTier 官方控制器托管，需要提供 API Token 才能自动添加托管路由', notes));
  }
  central.addRoute(opts.token, opts.nwid, opts.target, opts.via, (err, info, cnotes) => {
    if (cnotes && cnotes.length) notes.push.apply(notes, cnotes);
    if (!err) { notes.push('ZeroTier Central：托管路由已写入并回读确认'); return cb(null, notes); }
    notes.push('ZeroTier Central：' + err);
    viaLocal(() => cb('两条路径都没能添加托管路由', notes));
  });
}

function removeManagedRoute(opts, cb){
  const notes = [];
  const viaLocal = (next) => {
    localControllerRemoveRoute(opts.nwid, opts.target, (err) => {
      if (err) { notes.push('本机控制器：' + err); return next(); }
      notes.push('本机控制器：托管路由已移除并回读确认');
      cb(null, notes);
    });
  };
  if (!opts.token) {
    return viaLocal(() => cb('需要 API Token，或让本机托管该网络', notes));
  }
  central.removeRoute(opts.token, opts.nwid, opts.target, (err, info, cnotes) => {
    if (cnotes && cnotes.length) notes.push.apply(notes, cnotes);
    if (!err) { notes.push('ZeroTier Central：托管路由已移除并回读确认'); return cb(null, notes); }
    notes.push('ZeroTier Central：' + err);
    viaLocal(() => cb(err, notes));
  });
}

function squash(s){
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
}

/* 网卡名会被原样作为 argv 传给 cmd/main，再落到 iptables 的 -i / -o 上。
 * 它不经过 shell，所以真正要挡的是：长得像 iptables 选项（前导 -）的名字，
 * 以及空白/引号这类会把一个参数劈成两个、或者能被 shell 解释的字符。
 * fnOS 上通常是 eth0 / br0，但没必要因此拒绝其他合法名字（比如中文系统下的网卡名）。 */
function validIface(n){
  if (!n || n.length > 32) return false;
  if (n === '.' || n === '..' || n.charAt(0) === '-') return false;
  return !/[\s\/\\'"`$;&|<>(){}*?\[\]]/.test(n);
}

/* Work out what to advertise from the request plus what is on the machine.
 * The UI sends the selected physical interfaces as phyIfaces[]; the singular
 * phyIface is kept for old callers.  Names are trimmed and de-duplicated. */
function subnetParams(payload){
  let names;
  if (Array.isArray(payload.phyIfaces)) names = payload.phyIfaces.slice();
  else if (typeof payload.phyIfaces === 'string' && payload.phyIfaces.trim()) names = payload.phyIfaces.split(/[\s,]+/);
  else if (payload.phyIface) names = [payload.phyIface];
  else names = [];
  names = names.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  const seen = Object.create(null);
  names = names.filter((n) => { if (seen[n]) return false; seen[n] = true; return true; });

  const all = physicalInterfaces();
  /* Multi-homed boxes can hold several NICs in the SAME subnet with equal-cost
   * routes, and the kernel may forward out of ANY of them.  Selecting one NIC
   * must therefore install the rules on every NIC of that subnet -- otherwise
   * forwarded packets leave through an unconfigured interface and die there
   * (FORWARD policy is DROP). */
  const wantedSubnets = Object.create(null);
  names.forEach((n) => {
    const f = all.filter((i) => i.name === n)[0];
    if (f) wantedSubnets[subnetOf(f.cidr)] = true;
  });
  const autoIncluded = [];
  all.forEach((i) => {
    if (wantedSubnets[subnetOf(i.cidr)] && names.indexOf(i.name) === -1) {
      names.push(i.name);
      autoIncluded.push(i.name);
    }
  });
  const chosen = names.map((n) => ({ name: n, info: all.filter((i) => i.name === n)[0] || null }));
  return {
    nwid: String(payload.nwid || '').trim(),
    names: names,
    chosen: chosen,
    autoIncluded: autoIncluded,
    token: String(payload.token || '').trim() || readSavedToken(),
  };
}

function enableSubnet(payload, res){
  const p = subnetParams(payload);
  if (!/^[0-9a-fA-F]{16}$/.test(p.nwid)) {
    return send(res, 400, JSON.stringify({ ok: false, error: 'invalid-network-id' }));
  }
  if (!p.names.length) {
    return send(res, 400, JSON.stringify({ ok: false, error: 'invalid-interface',
      detail: '请至少勾选一个要共享的本机网卡' }));
  }
  for (let i = 0; i < p.names.length; i++) {
    if (!validIface(p.names[i])) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'invalid-interface',
        detail: '网卡名无效：' + p.names[i] }));
    }
  }
  for (let i = 0; i < p.chosen.length; i++) {
    if (!p.chosen[i].info) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'unknown-interface',
        detail: '本机找不到网卡 ' + p.chosen[i].name }));
    }
  }

  getZtNetwork(p.nwid, (err, net) => {
    if (err) {
      return send(res, 500, JSON.stringify({ ok: false, error: 'zerotier-api-error', detail: err }));
    }
    const ztIface = net.portDeviceName || '';
    const assigned = net.assignedAddresses || [];
    const via = ipv4Of(assigned);
    if (!via) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'no-assigned-address',
        detail: assigned.length
          ? '该网络只给本机分配了 IPv6 地址，而子网路由需要一个 IPv4 地址。请在网络的 IPv4 自动分配里把本设备纳入并授权。'
          : '该网络还没有给本机分配 IP。请先到 ZeroTier Central 把本设备勾选为已授权，等界面显示“已连接”后再试。' }));
    }
    if (!ztIface) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'no-tunnel-interface',
        detail: '还没看到该网络的隧道网卡，请确认网络状态是“已连接”' }));
    }

    // What to advertise: one target per DISTINCT physical subnet, each one bit
    // wider than the real prefix (ZeroTier's advice).  Two NICs in the same
    // subnet therefore register one route, not two.
    const targets = [];
    p.chosen.forEach((c) => {
      const t = enlargeCidr(c.info.cidr) || c.info.cidr;
      if (t && targets.indexOf(t) === -1) targets.push(t);
    });

    const notes = [];
    notes.push('本机在该网络的地址 ' + via + '，隧道网卡 ' + ztIface);
    p.chosen.forEach((c) => notes.push('从 ' + c.name + '（' + c.info.cidr + '）转发'));
    if (p.autoIncluded.length) {
      notes.push('同网段的网卡已自动一并配置（内核可能从任一网卡转发）：' + p.autoIncluded.join('、'));
    }
    notes.push('将对外广播 ' + targets.join('、'));

    /* 顺序很重要：
     *   - 先登记托管路由再配本机 NAT：NAT 没配上时，网络上已有指向本机的路由，
     *     整个网段对所有成员黑洞。
     *   - 先配本机 NAT 再登记路由：本机规则单独存在没有副作用，出问题只需回滚。
     * 所以先落配置、再开 NAT、最后逐条登记路由；任何一步失败都回滚成“未开启”，
     * 保证 subnet.conf 存在 ⟺ 真的开着。 */
    try {
      writeSubnetConf({
        NWID: p.nwid, ZT_IFACE: ztIface,
        PHY_IFACES: p.names.join(' '), TARGETS: targets.join(' '), VIA: via,
      });
    } catch (e) {
      return send(res, 500, JSON.stringify({
        ok: false, error: 'config-write-failed',
        detail: '无法写入 ' + SUBNET_CONF + '（' + e.message + '），未做任何改动',
        notes: notes,
      }));
    }

    const argvNote = '执行 subnet-up ' + [ztIface].concat(p.names).join(' ');
    runMain(['subnet-up', ztIface].concat(p.names), (rc, out) => {
      notes.push(argvNote);
      notes.push('本机 NAT 转发：rc=' + rc + ' ' + squash(out));
      if (rc !== 0) {
        clearSubnetConf();
        return send(res, 500, JSON.stringify({
          ok: false, error: 'nat-setup-failed',
          detail: '本机转发规则没能生效，已中止，网络上没有做任何改动。' +
                  (squash(out) ? ' 输出：' + squash(out) : ''),
          notes: notes,
        }));
      }

      // Register the managed routes one by one.  On failure, withdraw every
      // route already registered and tear the local rules down -- a half-open
      // gateway is the hardest state to debug.
      const rollbackEverything = (rerr) => {
        clearSubnetConf();
        let withdrawn = 0;
        const maybeFinish = () => {
          runMain(['subnet-down', ztIface].concat(p.names), () => {
            notes.push('已回滚本机转发规则');
            send(res, 500, JSON.stringify({
              ok: false, error: 'managed-route-failed', detail: rerr, notes: notes,
            }));
          });
        };
        const withdrawNext = () => {
          if (withdrawn >= targets.length) return maybeFinish();
          removeManagedRoute({ token: p.token, nwid: p.nwid, target: targets[withdrawn] }, () => {
            withdrawn++; withdrawNext();
          });
        };
        withdrawNext();
      };

      let registered = 0;
      const registerNext = () => {
        if (registered >= targets.length) {
          return send(res, 200, JSON.stringify({
            ok: true, targets: targets, via: via, ztIface: ztIface, notes: notes,
          }));
        }
        addManagedRoute({ token: p.token, nwid: p.nwid, target: targets[registered], via: via }, (rerr, rnotes) => {
          if (rnotes && rnotes.length) notes.push.apply(notes, rnotes);
          if (rerr) return rollbackEverything(rerr);
          registered++; registerNext();
        });
      };
      registerNext();
    });
  });
}

function disableSubnet(payload, res){
  const conf = readSubnetConf() || {};
  const nwid = String(payload.nwid || conf.NWID || '').trim();
  const ztIface = String(payload.ztIface || conf.ZT_IFACE || '').trim();
  let phys = confList(conf, 'PHY_IFACES', 'PHY_IFACE');
  if (Array.isArray(payload.phyIfaces) && payload.phyIfaces.length) phys = payload.phyIfaces.map(String);
  else if (payload.phyIface) phys = [String(payload.phyIface)];
  const targets = confList(conf, 'TARGETS', 'TARGET');
  const token = String(payload.token || '').trim() || readSavedToken();
  const notes = [];
  let routeErr = null;

  const finish = () => {
    clearSubnetConf();
    send(res, 200, JSON.stringify({
      ok: !routeErr, notes: notes,
      detail: routeErr ? '托管路由没能自动全部移除，请到 ZeroTier Central 手动检查 ' + targets.join(', ') : undefined,
    }));
  };

  const localDown = () => {
    if (!phys.length) {
      notes.push('没有记录物理网卡，跳过本机 NAT 规则清理');
      return finish();
    }
    runMain(['subnet-down', ztIface].concat(phys), (rc, out) => {
      notes.push('执行 subnet-down ' + [ztIface].concat(phys).join(' ') + '：rc=' + rc + ' ' + squash(out));
      finish();
    });
  };

  if (!nwid || !targets.length) {
    notes.push('没有记录托管路由信息，跳过远端清理');
    return localDown();
  }
  // Remove every advertised route first: leaving one in place while local
  // forwarding is gone would black-hole that subnet for all members.
  let i = 0;
  const removeNext = () => {
    if (i >= targets.length) return localDown();
    removeManagedRoute({ token: token, nwid: nwid, target: targets[i] }, (err, rnotes) => {
      if (rnotes && rnotes.length) notes.push.apply(notes, rnotes);
      if (err) { routeErr = err; notes.push('托管路由 ' + targets[i] + ' 移除失败：' + err); }
      i++; removeNext();
    });
  };
  removeNext();
}

function handler(req, res) {
  let urlPath = (req.url || '/').split('?')[0];
  // normalise the gateway prefix so one router serves both entry points
  if (urlPath === GATEWAY_PREFIX) urlPath = '/';
  else if (urlPath.startsWith(GATEWAY_PREFIX + '/')) urlPath = urlPath.slice(GATEWAY_PREFIX.length);
  if (urlPath === '/api/service/start' || urlPath === '/api/service/stop') {
    // Only the ZeroTier daemon is toggled here — stopping the whole app would
    // kill this web server and leave the user unable to start it again.
    const action = urlPath.endsWith('/start') ? 'zt-start' : 'zt-stop';
    runMain([action], (code, out) => {
      send(res, code === 0 ? 200 : 500,
        JSON.stringify({ ok: code === 0, action: action, output: out }));
    });
  } else if (urlPath === '/api/network-option') {
    // Per-network local options (allowManaged/allowGlobal/allowDefault/allowDNS).
    // Primary path is the local JSON API — the same one join/leave use. The CLI
    // is only a fallback, and either way the setting is re-read afterwards, so a
    // silent no-op can never be reported as success.
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'method-not-allowed' })); return; }
    collectBody(req, (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) { payload = {}; }
      const nwid = String(payload.nwid || '');
      const option = String(payload.option || '');
      if (!/^[0-9a-fA-F]{16}$/.test(nwid)) {
        send(res, 400, JSON.stringify({ ok: false, error: 'invalid-network-id' }));
        return;
      }
      if (!/^(allowManaged|allowGlobal|allowDefault|allowDNS)$/.test(option)) {
        send(res, 400, JSON.stringify({ ok: false, error: 'invalid-option' }));
        return;
      }
      const on = !!payload.value;
      const value = on ? '1' : '0';
      const notes = [];
      let responded = false;
      const done = (ok, error) => {
        if (responded) return;
        responded = true;
        send(res, ok ? 200 : 500, JSON.stringify({
          ok: ok, option: option, value: value,
          detail: notes.join(' | '), error: error,
        }));
      };
      // re-read the network and check the setting really took effect
      const verify = (cb) => {
        ztApiCall('GET', '/network/' + nwid, undefined, (code, text) => {
          let ok = false;
          try { ok = Boolean(JSON.parse(text)[option]) === on; } catch (_) { ok = false; }
          cb(ok, 'verify http ' + code + ' -> ' + String(text).slice(0, 200));
        });
      };
      ztApiCall('POST', '/network/' + nwid, { [option]: on }, (code, text) => {
        notes.push('api POST http ' + code + ': ' + String(text).slice(0, 200));
        verify((okApi) => {
          notes.push('after api: ' + (okApi ? 'applied' : 'not applied'));
          if (okApi) { done(true); return; }
          runMain(['set-option', nwid, option, value], (rc, out) => {
            notes.push('cli rc=' + rc + ': ' + String(out || '').trim().slice(0, 200));
            verify((okCli) => {
              notes.push('after cli: ' + (okCli ? 'applied' : 'not applied'));
              done(okCli, okCli ? undefined : 'network-option-failed');
            });
          });
        });
      });
    });
  } else if (urlPath === '/api/subnet/info') {
    if (req.method !== 'GET') { send(res, 405, JSON.stringify({ error: 'method-not-allowed' })); return; }
    const conf = readSubnetConf();
    const base = {
      ok: true,
      interfaces: physicalInterfaces(),
      tokenSaved: !!readSavedToken(),   // the token itself never leaves the server
      local: null,
      config: conf ? {
        nwid: conf.NWID || '', ztIface: conf.ZT_IFACE || '',
        phyIfaces: confList(conf, 'PHY_IFACES', 'PHY_IFACE'),
        targets: confList(conf, 'TARGETS', 'TARGET'),
        via: conf.VIA || '',
      } : null,
    };
    ztNetworks((nets) => {
      base.networks = nets.map((n) => {
        return {
          nwid: n.nwid, name: n.name || '', status: n.status || '',
          ztAddress: ipv4Of(n.assignedAddresses),
          ztIface: n.portDeviceName || '',
        };
      });
      const phys = conf ? confList(conf, 'PHY_IFACES', 'PHY_IFACE') : [];
      if (!conf || !phys.length) return send(res, 200, JSON.stringify(base));
      runMain(['subnet-status', conf.ZT_IFACE || ''].concat(phys), (rc, out) => {
        const t = String(out || '');
        const perIface = [];
        t.split(/\r?\n/).forEach((line) => {
          const m = line.match(/^phy=(\S+) nat_rule=(present|missing) forward_rules=(present|missing)$/);
          if (m) perIface.push({ name: m[1], natRule: m[2] === 'present', forwardRules: m[3] === 'present' });
        });
        base.local = {
          rc: rc,
          ipForward: (t.match(/ip_forward=(\S+)/) || [])[1] || null,
          perIface: perIface,
          // aggregate: every recorded interface must carry the rule
          natRule: perIface.length > 0 && perIface.every((x) => x.natRule),
          forwardRules: perIface.length > 0 && perIface.every((x) => x.forwardRules),
        };
        send(res, 200, JSON.stringify(base));
      });
    });
  } else if (urlPath === '/api/subnet/token') {
    /* GET returns the saved token so the user can view it on demand (显示/隐藏
     * 切换是用户主动触发的；列表类接口仍绝不回显令牌内容）。 */
    if (req.method === 'GET') {
      const saved = readSavedToken();
      return send(res, 200, JSON.stringify(saved
        ? { ok: true, tokenSaved: true, token: saved }
        : { ok: true, tokenSaved: false }));
    }
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'method-not-allowed' })); return; }
    collectBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (_) { p = {}; }
      if (p.clear === true) {
        try { fs.unlinkSync(CENTRAL_TOKEN_FILE); } catch (e) {}
        return send(res, 200, JSON.stringify({ ok: true, tokenSaved: false }));
      }
      const t = String(p.token || '').trim();
      if (t.length < 8) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'token-too-short',
          detail: 'API Token 看起来太短，请从 ZeroTier Central 的账户页面重新复制' }));
      }
      try { saveToken(t); }
      catch (e) {
        return send(res, 500, JSON.stringify({ ok: false, error: 'token-save-failed', detail: e.message }));
      }
      send(res, 200, JSON.stringify({ ok: true, tokenSaved: true }));
    });
  } else if (urlPath === '/api/subnet/enable') {
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'method-not-allowed' })); return; }
    collectBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (_) { p = {}; }
      enableSubnet(p, res);
    });
  } else if (urlPath === '/api/subnet/disable') {
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'method-not-allowed' })); return; }
    collectBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (_) { p = {}; }
      disableSubnet(p, res);
    });
  } else if (urlPath === '/api/netstats') {
    /* Tunnel interface addresses + live byte counters, for the overview's
     * traffic monitor.  zt* devices only; physical NIC stats are the NAS's
     * own business. */
    const counters = readNetDev();
    const out = [];
    const all = os.networkInterfaces();
    Object.keys(all).forEach((name) => {
      if (!/^zt/.test(name)) return;
      const addrs = (all[name] || []).filter((a) => !a.internal)
        .map((a) => a.cidr || (a.address + (a.netmask ? '/' + maskToPrefix(a.netmask) : '')));
      const c = counters[name];
      out.push({
        name: name,
        addresses: addrs,
        rxBytes: c ? c.rx : null,
        txBytes: c ? c.tx : null,
      });
    });
    send(res, 200, JSON.stringify({ ts: Date.now(), ifaces: out }));
  } else if (urlPath.startsWith('/api/') || urlPath === '/api') {
    proxyApi(req, res, urlPath);
  } else {
    serveStatic(res, urlPath);
  }
}

/* ===================== HTTP listener wiring ============================= */
function startServers(){
  const listeners = [];

  // 1) fixed service port, reachable directly on the LAN
  const server = http.createServer(handler);
  listeners.push(server);
  server.on('error', (e) => {
    process.stderr.write('port listen failed on ' + PORT + ': ' + (e && e.message) + '\n');
  });
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write('zerotier web server listening on 0.0.0.0:' + PORT + '\n');
  });

  // 2) fnOS unified-gateway Unix socket (best effort; absence is not fatal)
  const sockServer = http.createServer(handler);
  listeners.push(sockServer);
  try {
    if (fs.existsSync(GATEWAY_SOCKET)) fs.unlinkSync(GATEWAY_SOCKET);
    sockServer.listen(GATEWAY_SOCKET, () => {
      try { fs.chmodSync(GATEWAY_SOCKET, 0o666); } catch (e) {}
      process.stdout.write('zerotier web server listening on ' + GATEWAY_SOCKET + '\n');
    });
    sockServer.on('error', (e) => {
      process.stderr.write('gateway socket listen failed: ' + (e && e.message) + '\n');
    });
  } catch (e) {
    process.stderr.write('gateway socket unavailable: ' + (e && e.message) + '\n');
  }

  function shutdown(){
    let pending = listeners.length;
    const done = () => { if (--pending <= 0) process.exit(0); };
    listeners.forEach((s) => s.close(done));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
}

/* ===================== CLI: withdraw subnet routing ===================== */
/* cmd/uninstall_init runs this before the service stops. The managed route we
 * added lives on the ZeroTier network, not on this machine, so it outlives the
 * package -- and a route pointing at an uninstalled node black-holes that
 * subnet for every member of the network.  The last thing we do is take it
 * back out.  Local firewall rules are handled separately by cmd/main
 * subnet-cleanup, which needs no network access. */
function withdrawSubnetCli(){
  const conf = readSubnetConf() || {};
  const finish = (msg, code) => {
    if (msg) process.stdout.write(msg + '\n');
    process.exit(code);
  };
  const targets = confList(conf, 'TARGETS', 'TARGET');
  if (!conf.NWID || !targets.length) return finish('', 0);
  let code = 0;
  let i = 0;
  const next = () => {
    if (i >= targets.length) {
      return finish(code === 0 ? '已移除托管路由 ' + targets.join(', ') : '', code);
    }
    removeManagedRoute({ token: readSavedToken(), nwid: conf.NWID, target: targets[i] }, (err, notes) => {
      (notes || []).forEach((n) => process.stdout.write('  ' + n + '\n'));
      if (err) {
        code = 1;
        process.stdout.write('未能自动移除托管路由 ' + targets[i] + '：' + err + '\n');
      }
      i++; next();
    });
  };
  next();
}

if (process.argv[2] === '--subnet-withdraw') {
  withdrawSubnetCli();
} else {
  startServers();
}