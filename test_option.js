/* Exercises /api/network-option against a FAKE ZeroTier JSON API.
 *
 * The previous smoke test accepted "200 or 500" for this endpoint, which is
 * exactly how the CLI-only implementation shipped broken. This test stands up a
 * stub API on 127.0.0.1, points the server at it through zt/zerotier-one.port,
 * and asserts the toggle really reaches the API and is verified by a re-read.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const VAR = path.join(HERE, 'test-var', 'option');
const ZT = path.join(VAR, 'zt');
const FAKE_PORT = 19393;
const WEB_PORT = 13344;
const NWID = '856127940c1ded1a';
const TOKEN = 'fake-token-1234';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}

// ---- stub ZeroTier API -----------------------------------------------------
const netState = {};
const seen = { auth: null, posts: [] };
let rejectPost = false;

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.auth = req.headers['x-zt1-auth'];
    const id = (req.url || '').replace(/^\/network\//, '');
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST') {
      if (rejectPost) { reply(400, { error: 'stub rejects writes' }); return; }
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch (_) {}
      seen.posts.push(j);
      netState[id] = Object.assign({ nwid: id, status: 'OK' }, netState[id], j);
      reply(200, {});
      return;
    }
    if (req.method === 'GET') { reply(200, netState[id] || { nwid: id }); return; }
    reply(405, {});
  });
});

function post(pathname, obj) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const r = http.request({
      host: '127.0.0.1', port: WEB_PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: t }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e && e.message) }));
    r.write(payload);
    r.end();
  });
}

(async function main() {
  fs.rmSync(VAR, { recursive: true, force: true });
  fs.mkdirSync(ZT, { recursive: true });
  fs.writeFileSync(path.join(ZT, 'authtoken.secret'), TOKEN + '\n');
  fs.writeFileSync(path.join(ZT, 'zerotier-one.port'), String(FAKE_PORT) + '\n');

  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  // APPDEST must make WWW_ROOT=<fpk>/app/www and MAIN_SCRIPT=<fpk>/cmd/main
  process.env.TRIM_APPDEST = path.join(HERE, 'fpk', 'app');
  process.env.TRIM_PKGVAR = VAR;
  process.env.TRIM_APPNAME = 'ztmesh';
  process.env.TRIM_SERVICE_PORT = String(WEB_PORT);
  process.env.TRIM_TEMP_LOGFILE = path.join(HERE, 'test-var', 'option-main.log');

  require(path.join(HERE, 'fpk', 'app', 'server', 'server.js'));
  await new Promise((r) => setTimeout(r, 400));

  // 1. enable a setting
  let r1 = await post('/api/network-option', { nwid: NWID, option: 'allowDefault', value: true });
  check('enable allowDefault -> 200', r1.code === 200, 'got ' + r1.code + ' ' + r1.body);
  check('setting reached the ZeroTier API', netState[NWID] && netState[NWID].allowDefault === true,
    'api state = ' + JSON.stringify(netState[NWID]));
  check('boolean (not 1/0) was posted', JSON.stringify(seen.posts[0]) === '{"allowDefault":true}',
    'posted ' + JSON.stringify(seen.posts[0]));
  check('X-ZT1-Auth token was injected', seen.auth === TOKEN, 'saw ' + seen.auth);

  // 2. disable it again — proves false is not mistaken for "no value"
  let r2 = await post('/api/network-option', { nwid: NWID, option: 'allowDefault', value: false });
  check('disable allowDefault -> 200', r2.code === 200, 'got ' + r2.code + ' ' + r2.body);
  check('disable really applied', netState[NWID].allowDefault === false,
    'api state = ' + JSON.stringify(netState[NWID]));

  // 3. a different option must not clobber the others
  await post('/api/network-option', { nwid: NWID, option: 'allowManaged', value: true });
  check('other keys survive a toggle', netState[NWID].allowDefault === false && netState[NWID].allowManaged === true,
    JSON.stringify(netState[NWID]));

  // 4. when the API refuses, the CLI fallback is tried and the failure is
  //    reported with a diagnosis instead of a bare 500
  rejectPost = true;
  let r4 = await post('/api/network-option', { nwid: NWID, option: 'allowDNS', value: true });
  check('api refusal -> 500 (not a silent success)', r4.code === 500, 'got ' + r4.code + ' ' + r4.body);
  let d4 = {};
  try { d4 = JSON.parse(r4.body); } catch (_) {}
  check('failure carries a diagnosis', typeof d4.detail === 'string' && d4.detail.length > 0,
    'detail = ' + JSON.stringify(d4.detail));
  check('diagnosis shows the api rejection', /not applied/.test(d4.detail || ''), d4.detail);
  rejectPost = false;

  // 5. validation still enforced
  let r5 = await post('/api/network-option', { nwid: 'nope', option: 'allowDNS', value: true });
  check('bad network id -> 400', r5.code === 400, 'got ' + r5.code);
  let r6 = await post('/api/network-option', { nwid: NWID, option: 'allowEvil', value: true });
  check('bad option -> 400', r6.code === 400, 'got ' + r6.code);

  // 6. the placeholder elements must actually be hideable (regression guard for
  //    the missing generic .hidden rule)
  const css = fs.readFileSync(path.join(HERE, 'fpk', 'app', 'www', 'css', 'style.css'), 'utf8');
  const hiddenRule = /(^|[\s},])\.hidden\s*\{[^}]*display\s*:\s*none/m.test(css);
  check('a generic .hidden rule exists', hiddenRule, 'style.css has no bare .hidden { display:none }');
  const html = fs.readFileSync(path.join(HERE, 'fpk', 'app', 'www', 'index.html'), 'utf8');
  check('empty placeholders use .hidden', /id="netEmpty"[^>]*class="empty hidden"/.test(html),
    'netEmpty markup changed');

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  fake.close();
  process.exit(fail === 0 ? 0 : 1);
})();
