/* Exercises the subnet-routing feature ("转发当前网段").
 *
 * Two halves, tested separately because they fail in different ways:
 *
 *  A. central.js against a stub ZeroTier Central. This is the code that edits a
 *     route table on a remote account, so the assertions are about *contract*:
 *     existing routes must survive, the write must be verified by a re-read, and
 *     a read-back that disagrees must be reported as failure rather than success.
 *
 *  B. the HTTP endpoints. Validations must reject before any side effect, the
 *     API token must be storable but never echo back to the browser, and a
 *     failure to configure local NAT must leave no half-configured state.
 *
 * The happy path cannot be completed here (it ends in `bash cmd/main subnet-up`,
 * and this machine has no bash), and that limitation is used as a test: we
 * assert the enable path fails *honestly* and cleans up after itself.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const VAR = path.join(HERE, 'test-var', 'subnet');
const ZT = path.join(VAR, 'zt');
const ZT_PORT = 19394;
const CENTRAL_PORT = 19395;
const WEB_PORT = 13345;
const NWID = '856127940c1ded1a';
const UNKNOWN_NWID = 'ffffffffffffffff';
const TOKEN = 'central-token-abcd1234';

// must be set before central.js is loaded
process.env.ZT_CENTRAL_BASES =
  'stub-central|http://127.0.0.1:' + CENTRAL_PORT + '/api/v1|token';

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}
function skip(name, why) { skipped++; console.log('SKIP  ' + name + ' (' + why + ')'); }
function section(t) { console.log('\n--- ' + t + ' ---'); }
// Count non-overlapping occurrences of sub in s (used to verify de-duplication).
function occurrences(s, sub){
  let n = 0, at = 0;
  if (!sub) return 0;
  while ((at = s.indexOf(sub, at)) !== -1) { n++; at += sub.length; }
  return n;
}

/* ---- stub local ZeroTier daemon API --------------------------------------- */
let ztNet = {
  nwid: NWID, name: '家庭局域网', status: 'OK', type: 'PRIVATE',
  portDeviceName: 'ztabcdefgh', assignedAddresses: ['172.27.0.1/24'],
  routes: [], allowManaged: true,
};
const ztSeen = { auth: null, controllerHits: 0 };

const fakeZt = http.createServer((req, res) => {
  ztSeen.auth = req.headers['x-zt1-auth'];
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const url = (req.url || '').split('?')[0];
  if (url.indexOf('/controller/network/') === 0) {
    ztSeen.controllerHits++;
    return reply(404, { error: 'not the controller of this network' });
  }
  if (url === '/network' || url === '/network/') return reply(200, [ztNet]);
  const m = url.match(/^\/network\/([0-9a-fA-F]+)$/);
  if (m) {
    const id = m[1].toLowerCase();
    if (id === NWID) return reply(200, ztNet);
    if (id === UNKNOWN_NWID) return reply(404, { error: 'no such network' });
  }
  reply(404, { error: 'unhandled ' + url });
});

/* ---- stub ZeroTier Central ------------------------------------------------- */
let centralRoutes = [{ target: '10.0.0.0/24', via: '172.27.0.9' }];
let centralLie = false;              // accept writes but silently drop them
let centralFail = false;             // refuse writes outright
const centralSeen = { auth: null, posts: [] };

const fakeCentral = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    centralSeen.auth = req.headers.authorization;
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const m = (req.url || '').match(/\/network\/([0-9a-fA-F]+)$/);
    if (!m) return reply(404, { error: 'bad path ' + req.url });
    if (req.method === 'GET') return reply(200, { config: { routes: centralRoutes } });
    if (req.method === 'POST') {
      if (centralFail) return reply(400, { error: 'stub refuses writes' });
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch (_) {}
      centralSeen.posts.push(j);
      const routes = (j.config && j.config.routes) || [];
      if (!centralLie) centralRoutes = routes.map((r) => ({ target: r.target, via: r.via }));
      return reply(200, { ok: true });
    }
    reply(405, {});
  });
});

/* ---- http helpers ---------------------------------------------------------- */
function req(method, pathname, obj) {
  return new Promise((resolve) => {
    const payload = obj === undefined ? null : Buffer.from(JSON.stringify(obj));
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port: WEB_PORT, path: pathname, method: method, headers: headers }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(t); } catch (_) {}
        resolve({ code: res.statusCode, body: t, json: j });
      });
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e && e.message), json: null }));
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (p) => req('GET', p);
const post = (p, o) => req('POST', p, o);

function call(fn, ...args) {
  return new Promise((resolve) => { fn(...args, (...cbArgs) => resolve(cbArgs)); });
}

(async function main() {
  fs.rmSync(VAR, { recursive: true, force: true });
  fs.mkdirSync(ZT, { recursive: true });
  fs.writeFileSync(path.join(ZT, 'authtoken.secret'), 'zt-local-token\n');
  fs.writeFileSync(path.join(ZT, 'zerotier-one.port'), ZT_PORT + '\n');
  await new Promise((r) => fakeZt.listen(ZT_PORT, '127.0.0.1', r));
  await new Promise((r) => fakeCentral.listen(CENTRAL_PORT, '127.0.0.1', r));

  /* ======================= A. central.js contract ========================= */
  const central = require(path.join(HERE, 'fpk', 'app', 'server', 'central.js'));

  section('A. ZeroTier Central client (contract)');

  let [lrerr, lroutes, lnotes] = await call(central.listRoutes.bind(central), TOKEN, NWID);
  check('listRoutes() finds the stub API', !lrerr, lrerr);
  check('auth header uses the configured token prefix', centralSeen.auth === 'token ' + TOKEN, 'saw ' + centralSeen.auth);
  check('existing routes are parsed', Array.isArray(lroutes) && lroutes.length === 1, JSON.stringify(lroutes));
  check('routes are reduced to target/via', JSON.stringify(lroutes) ===
    '[{"target":"10.0.0.0/24","via":"172.27.0.9"}]', JSON.stringify(lroutes));

  centralSeen.posts.length = 0;
  let [aerr, ainfo, anotes] = await call(central.addRoute.bind(central), TOKEN, NWID, '192.168.250.0/23', '172.27.0.1');
  check('addRoute() succeeds against the stub', !aerr, aerr);
  check('addRoute() reports changed', ainfo && ainfo.changed === true, JSON.stringify(ainfo));
  check('the new route is stored', centralRoutes.some((r) => r.target === '192.168.250.0/23' && r.via === '172.27.0.1'),
    JSON.stringify(centralRoutes));
  check('the pre-existing route SURVIVED (routes are a whole array, not a patch)',
    centralRoutes.some((r) => r.target === '10.0.0.0/24' && r.via === '172.27.0.9'),
    JSON.stringify(centralRoutes));
  check('only target/via are sent back', JSON.stringify(centralSeen.posts[0]) ===
    '{"config":{"routes":[{"target":"10.0.0.0/24","via":"172.27.0.9"},{"target":"192.168.250.0/23","via":"172.27.0.1"}]}}',
    JSON.stringify(centralSeen.posts[0]));

  centralSeen.posts.length = 0;
  let [b2err, b2info] = await call(central.addRoute.bind(central), TOKEN, NWID, '192.168.250.0/23', '172.27.0.1');
  check('adding the same route is a no-op', !b2err && b2info && b2info.changed === false, b2err || JSON.stringify(b2info));
  check('the no-op really did not write', centralSeen.posts.length === 0,
    'posted ' + centralSeen.posts.length + ' times');

  let [cerr, cinfo] = await call(central.addRoute.bind(central), TOKEN, NWID, '192.168.250.0/23', '172.27.0.99');
  check('a changed via is rewritten', !cerr && cinfo && cinfo.changed === true, cerr || JSON.stringify(cinfo));
  check('the new via is stored', centralRoutes.some((r) => r.target === '192.168.250.0/23' && r.via === '172.27.0.99'),
    JSON.stringify(centralRoutes));

  centralLie = true;
  let [lerr, linfo, lnotes2] = await call(central.addRoute.bind(central), TOKEN, NWID, '192.168.99.0/24', '172.27.0.1');
  check('a write the API silently drops is reported as FAILURE', !!lerr, 'err = ' + lerr);
  check('the failure explains the read-back check', /回读/.test(String(lerr)), String(lerr));
  check('failure notes arrive in the third argument (not swapped for the result)',
    Array.isArray(lnotes2) && lnotes2.some((n) => /可用/.test(n)) && linfo === null,
    'info=' + JSON.stringify(linfo) + ' notes=' + JSON.stringify(lnotes2));
  centralLie = false;

  centralFail = true;
  let [ferr, finfo, fnotes] = await call(central.addRoute.bind(central), TOKEN, NWID, '192.168.98.0/24', '172.27.0.1');
  check('an API refusal is reported, not swallowed', !!ferr, 'err = ' + ferr);
  check('the refusal carries the endpoint diagnosis', Array.isArray(fnotes) && fnotes.length > 0, JSON.stringify(fnotes));
  centralFail = false;

  let [derrr, dinfo] = await call(central.removeRoute.bind(central), TOKEN, NWID, '192.168.250.0/23');
  check('removeRoute() succeeds', !derrr, derrr);
  check('the target is gone', !centralRoutes.some((r) => r.target === '192.168.250.0/23'), JSON.stringify(centralRoutes));
  check('removeRoute() leaves other routes alone',
    centralRoutes.some((r) => r.target === '10.0.0.0/24'), JSON.stringify(centralRoutes));

  let [nerr, ninfo] = await call(central.removeRoute.bind(central), TOKEN, NWID, '192.168.250.0/23');
  check('removing an absent route is a no-op', !nerr && ninfo && ninfo.changed === false, nerr || JSON.stringify(ninfo));

  /* ======================= B. HTTP endpoints ============================= */
  section('B. HTTP endpoints');

  process.env.TRIM_APPDEST = path.join(HERE, 'fpk', 'app');
  process.env.TRIM_PKGVAR = VAR;
  process.env.TRIM_APPNAME = 'ztmesh';
  process.env.TRIM_SERVICE_PORT = String(WEB_PORT);
  process.env.TRIM_TEMP_LOGFILE = path.join(HERE, 'test-var', 'subnet-main.log');
  require(path.join(HERE, 'fpk', 'app', 'server', 'server.js'));
  await new Promise((r) => setTimeout(r, 400));

  const info0 = await get('/api/subnet/info');
  check('GET /api/subnet/info -> 200', info0.code === 200, 'got ' + info0.code + ' ' + info0.body);
  const i0 = info0.json || {};
  check('no subnet config yet', i0.config === null, JSON.stringify(i0.config));
  check('no token saved yet', i0.tokenSaved === false, String(i0.tokenSaved));
  check('local interfaces are detected', Array.isArray(i0.interfaces) && i0.interfaces.length > 0,
    JSON.stringify(i0.interfaces));
  check('interfaces carry a usable CIDR', (i0.interfaces || []).every((x) => x.name && /\/\d+$/.test(x.cidr)),
    JSON.stringify(i0.interfaces));
  check('loopback is not offered as a LAN segment',
    !(i0.interfaces || []).some((x) => /^127\./.test(x.cidr)), JSON.stringify(i0.interfaces));
  check('networks are listed with the tunnel address',
    (i0.networks || []).some((n) => n.nwid === NWID && n.ztAddress === '172.27.0.1' && n.ztIface === 'ztabcdefgh'),
    JSON.stringify(i0.networks));
  check('the local ZeroTier auth token was used, not leaked',
    ztSeen.auth === 'zt-local-token' && info0.body.indexOf('zt-local-token') === -1, 'auth=' + ztSeen.auth);

  // ZeroTier networks are dual-stack by default and assignedAddresses may list
  // the IPv6 first. The tunnel address shown to the UI -- and later used as the
  // managed route's "via" -- must still be the IPv4 one.
  const savedAddrs = ztNet.assignedAddresses;
  ztNet = Object.assign({}, ztNet, { assignedAddresses: ['fd00:dead:beef::1/64', '172.27.0.1/24'] });
  const infoV6 = await get('/api/subnet/info');
  check('an IPv6-first assignment still yields the IPv4 tunnel address',
    (infoV6.json && infoV6.json.networks || []).some((n) => n.nwid === NWID && n.ztAddress === '172.27.0.1'),
    JSON.stringify(infoV6.json && infoV6.json.networks));
  ztNet = Object.assign({}, ztNet, { assignedAddresses: savedAddrs });

  let t1 = await post('/api/subnet/token', { token: 'short' });
  check('a too-short token -> 400', t1.code === 400 && t1.json && t1.json.error === 'token-too-short',
    t1.code + ' ' + t1.body);

  let t2 = await post('/api/subnet/token', { token: TOKEN });
  check('saving a token -> 200', t2.code === 200 && t2.json && t2.json.tokenSaved === true, t2.code + ' ' + t2.body);
  check('the token was written to disk', fs.existsSync(path.join(VAR, 'central_token')));

  const info1 = await get('/api/subnet/info');
  check('tokenSaved flips to true', info1.json && info1.json.tokenSaved === true, info1.body);
  check('THE TOKEN IS NEVER ECHOED TO THE BROWSER', info1.body.indexOf(TOKEN) === -1,
    'response leaked the API token');

  // ...unless the user explicitly asks to see it (显示/隐藏 toggle in the UI).
  let tg = await get('/api/subnet/token');
  check('GET /api/subnet/token reveals the saved token on explicit request',
    tg.code === 200 && tg.json && tg.json.token === TOKEN, tg.code + ' ' + tg.body);
  let tclear0 = await post('/api/subnet/token', { clear: true });
  let tg2 = await get('/api/subnet/token');
  check('GET /api/subnet/token with nothing saved -> tokenSaved false, no token field',
    tg2.code === 200 && tg2.json && tg2.json.tokenSaved === false && tg2.json.token === undefined,
    tg2.code + ' ' + tg2.body);
  await post('/api/subnet/token', { token: TOKEN });

  // mode is enforced in the source; Windows does not persist POSIX modes, so
  // assert the intent (mode: 0o600) rather than stat().mode.
  const src = fs.readFileSync(path.join(HERE, 'fpk', 'app', 'server', 'server.js'), 'utf8');
  const saveFn = src.slice(src.indexOf('function saveToken'), src.indexOf('function saveToken') + 400);
  check('the saved token is written with mode 0o600', /mode:\s*0o600/.test(saveFn), saveFn.slice(0, 200));
  const confFn = src.slice(src.indexOf('function writeSubnetConf'), src.indexOf('function writeSubnetConf') + 700);
  check('subnet.conf is also written 0o600', /mode:\s*0o600/.test(confFn), confFn.slice(0, 200));

  let t3 = await post('/api/subnet/token', { clear: true });
  check('clearing the token -> 200', t3.code === 200 && t3.json && t3.json.tokenSaved === false, t3.code + ' ' + t3.body);
  check('the token file is gone', !fs.existsSync(path.join(VAR, 'central_token')));
  await post('/api/subnet/token', { token: TOKEN });

  const localNames = (i0.interfaces || []).map((x) => x.name);
  const anIface = (i0.interfaces || [])[0];
  const anyNwid = NWID;

  let e0 = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: [] });
  check('no interface selected -> 400 invalid-interface',
    e0.code === 400 && e0.json && e0.json.error === 'invalid-interface', e0.code + ' ' + e0.body);

  let e1 = await post('/api/subnet/enable', { nwid: 'nope', phyIfaces: [anIface && anIface.name] });
  check('bad network id -> 400 invalid-network-id', e1.code === 400 && e1.json && e1.json.error === 'invalid-network-id',
    e1.code + ' ' + e1.body);

  let e2 = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: ['bad iface; rm -rf /'] });
  check('a shell-ish interface name -> 400 invalid-interface',
    e2.code === 400 && e2.json && e2.json.error === 'invalid-interface', e2.code + ' ' + e2.body);

  let e2b = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: ['--help'] });
  check('an iptables-option-looking name -> 400 invalid-interface',
    e2b.code === 400 && e2b.json && e2b.json.error === 'invalid-interface', e2b.code + ' ' + e2b.body);

  let e3 = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: ['nosuchiface0'] });
  check('an interface that is not on this machine -> 400 unknown-interface',
    e3.code === 400 && e3.json && e3.json.error === 'unknown-interface', e3.code + ' ' + e3.body);

  let e4 = await post('/api/subnet/enable', {
    nwid: anyNwid, phyIfaces: [anIface && anIface.name, 'bad;name'],
  });
  check('a multi-select list with one bad name -> 400 invalid-interface',
    e4.code === 400 && e4.json && e4.json.error === 'invalid-interface', e4.code + ' ' + e4.body);

  let e5 = await post('/api/subnet/enable', { nwid: UNKNOWN_NWID, phyIfaces: [anIface && anIface.name] });
  check('a network the daemon does not know -> 500 zerotier-api-error',
    e5.code === 500 && e5.json && e5.json.error === 'zerotier-api-error', e5.code + ' ' + e5.body);

  check('no enable attempt wrote subnet.conf so far', !fs.existsSync(path.join(VAR, 'subnet.conf')));

  const savedNet = ztNet;
  ztNet = Object.assign({}, savedNet, { assignedAddresses: [] });
  let e6 = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: [anIface && anIface.name] });
  check('a network with no assigned IP -> 400 no-assigned-address',
    e6.code === 400 && e6.json && e6.json.error === 'no-assigned-address', e6.code + ' ' + e6.body);

  ztNet = Object.assign({}, savedNet, { portDeviceName: '' });
  let e7 = await post('/api/subnet/enable', { nwid: anyNwid, phyIfaces: [anIface && anIface.name] });
  check('a network with no tunnel interface -> 400 no-tunnel-interface',
    e7.code === 400 && e7.json && e7.json.error === 'no-tunnel-interface', e7.code + ' ' + e7.body);

  ztNet = savedNet;

  /* ---- the ordering / rollback contract -------------------------------- */
  if (!anIface) {
    skip('NAT failure leaves no half-configured state', 'no local interface available to test with');
  } else {
    // A duplicated selection is de-duplicated: the ARGV note names it once.
    // (the name also appears in other notes, so count inside the argv note)
    let eDedupe = await post('/api/subnet/enable', {
      nwid: anyNwid, phyIfaces: [anIface.name, anIface.name],
    });
    const argvD = (eDedupe.json && eDedupe.json.notes || []).filter((n) => /^执行 subnet-up /.test(n))[0] || '';
    check('duplicated interface names are deduplicated before applying',
      eDedupe.code === 500 && eDedupe.json && eDedupe.json.error === 'nat-setup-failed' &&
      occurrences(argvD, anIface.name) === 1,
      eDedupe.code + ' argv=' + argvD);

    // only interfaces the server would accept (VMware adapters here contain
    // spaces and are rightly rejected before any command runs)
    const usableNames = localNames.filter((n) => !/\s/.test(n) && n.charAt(0) !== '-' && n.indexOf('/') === -1);
    const pick = usableNames.slice(0, 2);
    const beforePosts = centralSeen.posts.length;
    const beforeController = ztSeen.controllerHits;
    let e8 = await post('/api/subnet/enable', {
      nwid: anyNwid, phyIfaces: pick,
    });
    check('a NAT step that cannot run -> 500 nat-setup-failed (never a fake success)',
      e8.code === 500 && e8.json && e8.json.error === 'nat-setup-failed', e8.code + ' ' + e8.body);
    check('every selected interface is named in the subnet-up argv',
      pick.every((nm) => JSON.stringify((e8.json && e8.json.notes) || []).indexOf(nm) !== -1),
      JSON.stringify(e8.json && e8.json.notes));
    check('the failure carries the shell output as a diagnosis',
      !!(e8.json && /rc=/.test(JSON.stringify(e8.json.notes || []))), JSON.stringify(e8.json && e8.json.notes));
    check('ROLLBACK: subnet.conf was not left behind', !fs.existsSync(path.join(VAR, 'subnet.conf')));
    check('ROLLBACK: no managed route was registered before NAT worked',
      centralSeen.posts.length === beforePosts && ztSeen.controllerHits === beforeController,
      'central posts +' + (centralSeen.posts.length - beforePosts) +
      ', controller hits +' + (ztSeen.controllerHits - beforeController));

    const infoAfter = await get('/api/subnet/info');
    check('the app still reports itself as NOT enabled', infoAfter.json && infoAfter.json.config === null,
      JSON.stringify(infoAfter.json && infoAfter.json.config));

    /* old single-NIC config is migrated on read (PHY_IFACE/TARGET -> lists) */
    fs.writeFileSync(path.join(VAR, 'subnet.conf'),
      ['NWID=' + anyNwid, 'PHY_IFACE=' + anIface.name, 'ZT_IFACE=ztolddev',
       'PHY_CIDR=' + anIface.cidr, 'TARGET=10.99.0.0/23', 'VIA=172.27.0.1'].join('\n') + '\n');
    const infoLegacy = await get('/api/subnet/info');
    const cLegacy = infoLegacy.json && infoLegacy.json.config;
    check('an old single-NIC subnet.conf is migrated to lists',
      !!cLegacy &&
        JSON.stringify(cLegacy.phyIfaces) === JSON.stringify([anIface.name]) &&
        JSON.stringify(cLegacy.targets) === JSON.stringify(['10.99.0.0/23']),
      JSON.stringify(cLegacy));
    fs.unlinkSync(path.join(VAR, 'subnet.conf'));
  }

  let d1 = await post('/api/subnet/disable', {});
  check('disabling when nothing is enabled -> 200, not an error',
    d1.code === 200 && d1.json && d1.json.ok === true, d1.code + ' ' + d1.body);

  let m1 = await get('/api/subnet/enable');
  check('GET on an enable-only endpoint -> 405', m1.code === 405, 'got ' + m1.code);

  /* ======================= C. shell side ================================= */
  section('C. cmd/main subnet commands');

  const main = fs.readFileSync(path.join(HERE, 'fpk', 'cmd', 'main'), 'utf8');
  check('cmd/main handles subnet-up', /subnet-up\)/.test(main), 'no subnet-up case');
  check('cmd/main handles subnet-down', /subnet-down\)/.test(main), 'no subnet-down case');
  check('cmd/main handles subnet-status', /subnet-status\)/.test(main), 'no subnet-status case');
  check('the rules are added idempotently (-C before -A)',
    /-C POSTROUTING/.test(main) && /-t nat -A POSTROUTING/.test(main), 'no -C guard for MASQUERADE');
  check('MASQUERADE excludes the interface own subnet (multi-homed safety)',
    /-C POSTROUTING '!' -s "\$sn" -o "\$phy" -j MASQUERADE/.test(main),
    'rule must not masquerade traffic from the interface own subnet');
  check('the legacy unrestricted MASQUERADE rule is removed on apply',
    /while iptables -t nat -C POSTROUTING -o "\$phy" -j MASQUERADE/.test(main),
    'no legacy-rule cleanup loop');
  check('tunnel destinations are pinned to the main table (fnOS source-based ip rules)',
    /ip rule add to "\$dst" lookup main pref/.test(main),
    'no policy-routing guard');
  check('the policy rules are removed on subnet-down',
    /subnet_unfix_policy_rules/.test(main) && /subnet-down[\s\S]*subnet_unfix_policy_rules/.test(main),
    'no policy-rule cleanup');
  check('missing iptables is an error, not a silent pass',
    /iptables 不可用/.test(main), 'no iptables presence check');
  check('the applied rules are verified afterwards',
    /subnet_report/.test(main), 'no post-apply verification');
  check('subnet_apply takes the zt iface then a list of physical interfaces',
    /subnet_apply "\$zt" "\$@"/.test(main), 'subnet_apply is not list-shaped');
  check('interface names are validated on the shell side too',
    /valid_iface_name/.test(main), 'no valid_iface_name helper');
  check('status is reported on a per-interface line',
    /subnet_report_phy/.test(main), 'no per-interface report');
  check('subnet rules are re-applied when the service starts',
    /apply_subnet_on_boot/.test(main) && /^\s*apply_subnet_on_boot/m.test(main), 'not called from start');
  check('the config file is parsed, never sourced',
    /subnet_get\(\)/.test(main) && !/^\s*\.\s*"\$SUBNET_CONF"/m.test(main), 'subnet.conf may be sourced');

  /* ======================= D. uninstall safety =========================== */
  section('D. uninstall withdraws what it installed');

  const srv = fs.readFileSync(path.join(HERE, 'fpk', 'app', 'server', 'server.js'), 'utf8');
  check('server.js has a --subnet-withdraw CLI mode',
    /--subnet-withdraw/.test(srv) && /function withdrawSubnetCli/.test(srv), 'no CLI mode');
  check('the CLI removes the managed route via the shared helper',
    /removeManagedRoute\(\{\s*token:\s*readSavedToken\(\)/.test(srv), 'CLI does not call removeManagedRoute');
  check('the CLI does not open any listening socket',
    /if \(process\.argv\[2\] === '--subnet-withdraw'\) \{\s*\n\s*withdrawSubnetCli\(\);\s*\n\} else \{\s*\n\s*startServers\(\);/.test(srv),
    'listener start is not guarded by the CLI check');
  check('cmd/main can clean up from the saved config', /subnet-cleanup\)/.test(main), 'no subnet-cleanup case');

  const un = fs.readFileSync(path.join(HERE, 'fpk', 'cmd', 'uninstall_init'), 'utf8');
  const atWithdraw = un.indexOf('--subnet-withdraw');
  const atStop = un.indexOf('"$MAIN" stop');
  check('uninstall_init withdraws the managed route', atWithdraw !== -1, 'no withdraw call');
  check('it withdraws BEFORE stopping the service (needs the running daemon)',
    atWithdraw !== -1 && atStop !== -1 && atWithdraw < atStop,
    'withdraw at ' + atWithdraw + ', stop at ' + atStop);
  check('uninstall_init also cleans the local firewall rules', /subnet-cleanup/.test(un), 'no subnet-cleanup call');
  check('uninstall still preserves node identity by default', /preserving node identity/.test(un));
  check('the uninstall wizard can request a full data wipe',
    /wizard_remove_data/.test(un), 'no wizard_remove_data handling');
  check('selecting one NIC auto-includes sibling NICs on the same subnet',
    /wantedSubnets/.test(srv) && /autoIncluded/.test(srv), 'no same-subnet expansion');
  check('netstats endpoint serves tunnel traffic counters',
    /\/api\/netstats/.test(srv) && /readNetDev/.test(srv), 'no /api/netstats');

  console.log('\n' + pass + '/' + (pass + fail) + ' passed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  fakeZt.close();
  fakeCentral.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST HARNESS CRASHED:', e && e.stack || e);
  process.exit(1);
});
