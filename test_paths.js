/* test_paths.js — regression test for cmd/main discovery.
 *
 * The bug this exists to prevent: fnOS passes TRIM_APPDEST as the *resolved*
 * payload directory (/vol1/@appcenter/zerotier), whose parent is NOT the app
 * root -- the lifecycle scripts live at /var/apps/<appname>/cmd/. Deriving the
 * path from dirname(APPDEST) produced /vol1/@appcenter/cmd/main, and every
 * `bash <script>` died with exit 127 "No such file or directory".  The user hit
 * this on real hardware, so it gets a fixture-based test.
 *
 * Part A drives each lifecycle script's own find_main() text (extracted from the
 * real files, not a copy) under dash.
 * Part B drives the real web server over HTTP.
 * Part C checks the failure message names every probed location.
 *
 * Requires dash (tools/mingit/usr/bin/dash.exe), which is a Cygwin program and
 * needs an unsandboxed run.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HERE = __dirname;
const DASH = path.join(HERE, 'tools', 'mingit', 'usr', 'bin', 'dash.exe');
const SERVER = path.join(HERE, 'fpk', 'app', 'server', 'server.js');
const CMD_DIR = path.join(HERE, 'fpk', 'cmd');

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
}
function skip(name, why) { skipped++; console.log('SKIP  ' + name + ' -- ' + why); }

// Cygwin sees C:\Users\x as /c/Users/x
function posix(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase());
}
// ...and back again: /c/Users/x -> C:\Users\x
function toWin(p) {
  const s = String(p).trim();
  const m = s.match(/^\/([A-Za-z])\/(.*)$/);
  if (m) return m[1].toUpperCase() + ':' + path.sep + m[2].replace(/\//g, path.sep);
  return s.replace(/\//g, path.sep);
}
const MINGIT = path.join(HERE, 'tools', 'mingit');

const FIX = path.join(HERE, '_pathtest');
const APPS = path.join(FIX, 'apps', 'ztmesh');        // the app root (has cmd/)
const PAYLOAD = path.join(FIX, 'vol1', '@appcenter', 'ztmesh'); // == TRIM_APPDEST
const WRONG = path.join(FIX, 'vol1', '@appcenter', 'cmd', 'main'); // what the old code used

function writeFile(p, text, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
  if (mode) { try { fs.chmodSync(p, mode); } catch (_) {} }
}

function buildFixture(opts) {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIX, 'var'), { recursive: true });
  fs.mkdirSync(path.join(FIX, 'tmp'), { recursive: true });
  fs.mkdirSync(PAYLOAD, { recursive: true });
  writeFile(path.join(PAYLOAD, 'www', 'index.html'), '<html>payload</html>');
  if (opts.appRoot) {
    writeFile(path.join(APPS, 'meta', '.keep'), '');
    writeFile(path.join(APPS, 'cmd', 'main'), STUB_MAIN, 0o755);
  }
  if (opts.inPayload) writeFile(path.join(PAYLOAD, 'cmd', 'main'), STUB_MAIN, 0o755);
}

const STUB_MAIN = '#!/bin/bash\necho "STUB-MAIN-REACHED:$*"\nexit 0\n';

/* Extract find_main() plus its MAIN/APPROOT derivations verbatim from a real
 * script, so the test exercises the shipped text rather than a re-implementation
 * that can silently drift away from it. */
const APPROOT_LINE = '[ -n "$APPROOT" ] || APPROOT="$(dirname "$APPDEST")"';
function extractResolver(src) {
  const start = src.indexOf('find_main(){');
  if (start === -1) return null;
  const end = src.indexOf(APPROOT_LINE, start);
  if (end === -1) return null;
  return src.slice(start, end + APPROOT_LINE.length);
}

function runDash(script, env) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = spawn(DASH, [script], { env });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/* dash needs MinGit's own bin directories on PATH or ordinary utilities like
 * `dirname` are "not found"; a Windows-style PATH is useless to it. */
function dashEnv(extra) {
  const env = {
    PATH: [MINGIT + '/usr/bin', MINGIT + '/mingw64/bin', MINGIT + '/bin'].map(posix).join(':'),
    SystemRoot: process.env.SystemRoot || '',
  };
  Object.assign(env, extra || {});
  return env;
}

/* server.js spawns `bash` by name, which does not exist on this Windows box.
 * Drop a dash copy named bash.exe next to MinGit's msys-2.0.dll so the HTTP
 * path can be exercised end-to-end (fnOS has a real bash; we only need an
 * interpreter that runs the same scripts the same way).  The copy must live in
 * that same directory: an MSYS2 binary cannot find its runtime DLL elsewhere.
 * This touches tools/ only -- nothing here is packaged. */
function makeBashShim() {
  const bin = path.join(MINGIT, 'usr', 'bin');
  const shim = path.join(bin, 'bash.exe');
  if (!fs.existsSync(shim)) fs.copyFileSync(DASH, shim);
  return bin;
}

function serverPath(bin) {
  return bin + path.delimiter + (process.env.PATH || '');
}

function post(port, urlPath, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e && e.message) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

function startServer(port, extraEnv) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, extraEnv);
    const p = spawn(process.env.NODE_BIN || process.execPath, [SERVER], { env });
    let out = '';
    const onData = (d) => {
      out += d;
      if (out.indexOf('listening on') !== -1) resolve({ proc: p, port });
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ proc: null, port }));
    setTimeout(() => resolve({ proc: p, port }), 6000);
  });
}

(async function main() {
  console.log('=== A. lifecycle scripts locate cmd/main under the real fnOS layout ===');

  const scripts = ['install_callback', 'upgrade_init', 'upgrade_callback', 'config_callback', 'uninstall_init'];
  const sources = {};
  scripts.forEach((s) => { sources[s] = fs.readFileSync(path.join(CMD_DIR, s), 'utf8'); });

  const missing = scripts.filter((s) => !extractResolver(sources[s]));
  check('every script defines find_main() and derives APPROOT', missing.length === 0,
    'missing in: ' + missing.join(', '));
  check('no script derives cmd/main from dirname(APPDEST) any more',
    scripts.every((s) => !/MAIN="\$\(dirname "\$APPDEST"\)/.test(sources[s])),
    'a script still uses the broken derivation');
  check('server.js no longer derives MAIN_SCRIPT that way either',
    !/MAIN_SCRIPT = path\.join\(path\.dirname\(APPDEST\), 'cmd', 'main'\)/.test(
      fs.readFileSync(SERVER, 'utf8')));

  buildFixture({ appRoot: true });
  check('fixture: the old, wrong path does not exist', !fs.existsSync(WRONG), WRONG);

  for (const s of scripts) {
    const block = extractResolver(sources[s]);
    const probe = [
      'set -u',
      'APPNAME="${TRIM_APPNAME:-ztmesh}"',
      'APPDEST="${TRIM_APPDEST:-/var/apps/${APPNAME}/target}"',
      block,
      'echo "MAIN=$MAIN"',
      'echo "APPROOT=$APPROOT"',
      'exit 0',
    ].join('\n') + '\n';
    const probeFile = path.join(FIX, 'probe_' + s + '.sh');
    writeFile(probeFile, probe);

    const r = await runDash(posix(probeFile), dashEnv({
      TRIM_APPNAME: 'ztmesh',
      TRIM_APPDEST: posix(PAYLOAD),
      TRIM_PKGMETA: posix(path.join(APPS, 'meta')),
      TRIM_PKGVAR: posix(path.join(FIX, 'var')),
      TRIM_PKGTMP: posix(path.join(FIX, 'tmp')),
    }));
    const m = (r.out.match(/^MAIN=(.*)$/m) || [])[1] || '';
    const root = (r.out.match(/^APPROOT=(.*)$/m) || [])[1] || '';
    const found = m !== '' && fs.existsSync(toWin(m));
    const notTheOldPath = !/@appcenter\/cmd\/main/.test(m);

    check(s + ': finds a cmd/main that really exists', found, 'MAIN=' + JSON.stringify(m) + ' err=' + r.err.trim());
    check(s + ': never resolves to the old broken path', notTheOldPath, 'MAIN=' + m);
    check(s + ': APPROOT points at the directory holding cmd/',
      root.trim() === posix(APPS), 'APPROOT=' + root.trim() + ' want ' + posix(APPS));
  }

  // Fallback chain: no TRIM_PKGMETA, cmd/ shipped inside the payload instead.
  console.log('\n=== A2. fallback works when the app root is elsewhere ===');
  buildFixture({ inPayload: true });
  const probe2 = path.join(FIX, 'probe_fallback.sh');
  writeFile(probe2, [
    'set -u',
    'APPNAME="${TRIM_APPNAME:-ztmesh}"',
    'APPDEST="${TRIM_APPDEST:-/var/apps/${APPNAME}/target}"',
    extractResolver(sources['config_callback']),
    'echo "MAIN=$MAIN"',
    'exit 0',
  ].join('\n') + '\n');
  const r2 = await runDash(posix(probe2), dashEnv({
    TRIM_APPNAME: 'ztmesh',
    TRIM_APPDEST: posix(PAYLOAD),
    TRIM_PKGVAR: posix(path.join(FIX, 'var')),
    TRIM_PKGTMP: posix(path.join(FIX, 'tmp')),
  }));
  const m2 = ((r2.out.match(/^MAIN=(.*)$/m) || [])[1] || '').trim();
  check('falls through to the payload layout when TRIM_PKGMETA is unset',
    m2 === posix(path.join(PAYLOAD, 'cmd', 'main')), 'MAIN=' + m2);
  check('that path really exists', fs.existsSync(toWin(m2)));

  console.log('\n=== B. the web server can reach cmd/main over HTTP ===');
  buildFixture({ appRoot: true });
  const BIN = makeBashShim();
  const PORT = 13346;
  const srv = await startServer(PORT, {
    TRIM_APPNAME: 'ztmesh',
    TRIM_APPDEST: PAYLOAD,
    TRIM_PKGMETA: path.join(APPS, 'meta'),
    TRIM_PKGVAR: path.join(FIX, 'var'),
    TRIM_PKGTMP: path.join(FIX, 'tmp'),
    TRIM_SERVICE_PORT: String(PORT),
    PATH: serverPath(BIN),
  });
  if (!srv.proc) {
    skip('service start reaches cmd/main', 'server did not start');
  } else {
    const r = await post(PORT, '/api/service/start', {});
    let body = {};
    try { body = JSON.parse(r.text); } catch (_) {}
    check('POST /api/service/start returns 200', r.status === 200, 'status=' + r.status + ' body=' + r.text.slice(0, 300));
    check('the response carries the stub script output',
      /STUB-MAIN-REACHED:\s*zt-start/.test(String(body.output || '')), 'output=' + JSON.stringify(body.output));
    check('no bare 127 / "No such file or directory" anywhere',
      !/No such file or directory/.test(r.text), r.text.slice(0, 300));

    console.log('\n=== C. a missing cmd/main says exactly where it looked ===');
    const PORT2 = 13347;
    const srv2 = await startServer(PORT2, {
      TRIM_APPNAME: 'zerotier_nope',
      TRIM_APPDEST: path.join(FIX, 'vol1', '@appcenter', 'zerotier_nope'),
      TRIM_PKGMETA: path.join(FIX, 'apps', 'zerotier_nope', 'meta'),
      TRIM_PKGVAR: path.join(FIX, 'var'),
      TRIM_PKGTMP: path.join(FIX, 'tmp'),
      TRIM_SERVICE_PORT: String(PORT2),
      PATH: serverPath(BIN),
    });
    if (!srv2.proc) {
      skip('missing cmd/main is reported with probed paths', 'server did not start');
    } else {
      const r2 = await post(PORT2, '/api/service/start', {});
      let b2 = {};
      try { b2 = JSON.parse(r2.text); } catch (_) {}
      const out2 = String(b2.output || r2.text);
      check('reports failure rather than pretending to succeed', r2.status === 500, 'status=' + r2.status);
      check('names the probed locations', /cmd\/main not found\. probed:/.test(out2), out2.slice(0, 400));
      check('includes the documented /var/apps/<appname> path',
        /[\\/]var[\\/]apps[\\/]zerotier_nope[\\/]cmd[\\/]main/.test(out2), out2.slice(0, 400));
      check('includes the payload-relative fallbacks', /@appcenter/.test(out2), out2.slice(0, 400));
      srv2.proc.kill('SIGKILL');
    }
    srv.proc.kill('SIGKILL');
  }

  fs.rmSync(FIX, { recursive: true, force: true });
  console.log('\n' + pass + '/' + (pass + fail) + ' passed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
