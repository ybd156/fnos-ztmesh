// In-process smoke test for app/server/server.js.
// server.js listens as a side effect of being required, so we drive it from
// the same process with Node's http client (the sandbox blocks child_process
// with piped stdio, which would otherwise be the natural way to do this).
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 13343;

process.env.TRIM_APPNAME = 'ztmesh';
process.env.TRIM_APPDEST = path.join(ROOT, 'fpk', 'app');
process.env.TRIM_PKGVAR = path.join(ROOT, 'test-var');
process.env.TRIM_PKGTMP = path.join(ROOT, 'test-tmp');
process.env.TRIM_SERVICE_PORT = String(PORT);
fs.mkdirSync(process.env.TRIM_PKGVAR, { recursive: true });
fs.mkdirSync(process.env.TRIM_PKGTMP, { recursive: true });

require(path.join(ROOT, 'fpk', 'app', 'server', 'server.js'));

function request(p, method, json) {
  return new Promise((resolve) => {
    const payload = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const NWID = '8056c2e21c000001';

// [label, path, method, body, expectSubstring|null, allowedStatuses]
const checks = [
  ['GET / serves the console', '/', 'GET', undefined, '异地组网控制台', [200]],
  ['GET /app/ztmesh/ (gateway prefix)', '/app/ztmesh/', 'GET', undefined, '异地组网控制台', [200]],
  ['GET /app/ztmesh/index.html', '/app/ztmesh/index.html', 'GET', undefined, '异地组网控制台', [200]],
  ['GET css/style.css', '/app/ztmesh/css/style.css', 'GET', undefined, 'sidebar', [200]],
  ['GET js/app.js', '/app/ztmesh/js/app.js', 'GET', undefined, 'API_BASE', [200]],
  ['GET images/icon_64.png', '/app/ztmesh/images/icon_64.png', 'GET', undefined, null, [200]],
  ['GET images/icon_256.png', '/app/ztmesh/images/icon_256.png', 'GET', undefined, null, [200]],
  ['traversal /../manifest is blocked', '/../manifest', 'GET', undefined, null, [403]],
  ['API proxy w/o daemon -> JSON 503', '/app/ztmesh/api/status', 'GET', undefined, 'zerotier-service-not-ready', [503]],
  ['service start w/o bash -> JSON error', '/app/ztmesh/api/service/start', 'POST', undefined, null, [500]],
  ['network-option rejects GET', '/app/ztmesh/api/network-option', 'GET', undefined, 'method-not-allowed', [405]],
  ['network-option rejects bad nwid', '/app/ztmesh/api/network-option', 'POST', { nwid: 'zz', option: 'allowDefault', value: true }, 'invalid-network-id', [400]],
  ['network-option rejects unknown key', '/app/ztmesh/api/network-option', 'POST', { nwid: NWID, option: 'evil', value: true }, 'invalid-option', [400]],
  ['netstats returns JSON with ifaces array', '/app/ztmesh/api/netstats', 'GET', undefined, '"ifaces"', [200]],
  ['network-option accepts a valid request', '/app/ztmesh/api/network-option', 'POST', { nwid: NWID, option: 'allowDefault', value: true }, 'allowDefault', [200, 500]],
];

(async () => {
  await new Promise((r) => setTimeout(r, 400));
  let pass = 0;
  for (const [label, p, method, body, expect, statuses] of checks) {
    const r = await request(p, method, body);
    const okStatus = statuses.includes(r.status);
    const okBody = expect === null ? true : (r.body || '').includes(expect);
    const ok = okStatus && okBody;
    if (ok) pass++;
    let line = `${ok ? 'PASS' : 'FAIL'}  ${label}\n        status=${r.status} (want ${statuses.join('|')}) type=${r.type || '-'} len=${(r.body || '').length}`;
    if (!okBody) line += `  MISSING:${expect}`;
    if (!okStatus || !okBody) line += `\n        body: ${(r.body || '').slice(0, 200)}`;
    console.log(line);
  }

  // The packaged UI must actually expose the per-network option toggles.
  const ajs = fs.readFileSync(path.join(ROOT, 'fpk', 'app', 'www', 'js', 'app.js'), 'utf8');
  const uiOk = ['allowManaged', 'allowGlobal', 'allowDefault', 'allowDNS', 'network-option'].every((k) => ajs.includes(k));
  if (uiOk) pass++;
  else console.log('FAIL  app.js exposes all four option toggles');
  console.log(`${uiOk ? 'PASS' : 'FAIL'}  app.js exposes all four option toggles`);

  console.log(`\n${pass}/${checks.length + 1} passed`);
  process.exit(pass === checks.length + 1 ? 0 : 1);
})();
