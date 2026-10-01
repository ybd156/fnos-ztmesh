// Verify the built .fpk end-to-end: structure, modes, and file contents.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('child_process');
const crypto = require('crypto');

const FP = path.join(__dirname, process.argv[2] || 'ztmesh-x86_64.fpk');
const raw = zlib.gunzipSync(fs.readFileSync(FP));

// Detect expected platform from filename (e.g. ztmesh-arm.fpk -> arm)
const PLAT = (FP.match(/ztmesh-(\w+)\.fpk$/) || [])[1] || 'x86_64';
const EXPECTED_MACHINE = PLAT === 'arm' ? 183 : 62;   // 183=aarch64, 62=x86-64

function parseTar(buf) {
  const out = [];
  for (let o = 0; o + 512 <= buf.length; ) {
    const h = buf.slice(o, o + 512);
    const str = (s, n) => h.slice(s, s + n).toString('utf8').replace(/\0.*$/, '').trim();
    const name = str(0, 100);
    if (!name) break;
    const size = parseInt(str(124, 12), 8) || 0;
    const mode = parseInt(str(100, 8), 8) || 0;
    const type = String.fromCharCode(h[156]) || '0';
    const prefix = str(345, 155);
    const full = prefix ? prefix + '/' + name : name;
    const dataStart = o + 512;
    out.push({ name: full, size, mode, type, data: buf.slice(dataStart, dataStart + size) });
    o = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const outer = parseTar(raw);
const isDir = (e) => e.type === '5' || e.name.endsWith('/');

console.log('=== OUTER ===');
for (const e of outer) console.log(`  ${e.mode.toString(8).padStart(4, '0')} ${String(e.size).padStart(9)} ${isDir(e) ? 'd' : '-'} ${e.name}`);

const appTgz = outer.find((e) => e.name === 'app.tgz' || e.name === 'app/' || e.name === 'app');
let inner = [];
if (appTgz && appTgz.size) inner = parseTar(zlib.gunzipSync(appTgz.data));
console.log('\n=== app.tgz ===');
for (const e of inner) console.log(`  ${e.mode.toString(8).padStart(4, '0')} ${String(e.size).padStart(9)} ${isDir(e) ? 'd' : '-'} ${e.name}`);

const find = (list, n) => list.find((e) => e.name === n || e.name === './' + n);

const REQUIRED_OUTER = ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'config/privilege', 'config/resource', 'wizard/install', 'wizard/uninstall'];
const REQUIRED_CMD = ['main', 'install_init', 'install_callback', 'upgrade_init', 'upgrade_callback', 'uninstall_init', 'uninstall_callback', 'config_init', 'config_callback'];
const REQUIRED_INNER = ['server/server.js', 'ui/config', 'ui/images/icon_64.png', 'ui/images/icon_256.png', 'www/index.html', 'www/css/style.css', 'www/js/app.js', 'www/images/icon_64.png', 'zt/zerotier-one'];

console.log('\n=== CHECKS ===');
let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); };

for (const n of REQUIRED_OUTER) ok(!!find(outer, n), `outer has ${n}`);
for (const n of REQUIRED_CMD) {
  const e = find(outer, 'cmd/' + n);
  ok(e && (e.mode & 0o111) === 0o111, `cmd/${n} present and executable (mode ${e ? e.mode.toString(8) : 'missing'})`);
}
for (const n of REQUIRED_INNER) ok(!!find(inner, n), `app/ has ${n}`);

const zt = find(inner, 'zt/zerotier-one');
ok(zt && (zt.mode & 0o111) === 0o111, `zt/zerotier-one executable (mode ${zt ? zt.mode.toString(8) : 'missing'})`);
if (zt) {
  const elf = zt.data.slice(0, 4);
  ok(elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46, 'zt/zerotier-one is an ELF binary');
  ok(zt.data.readUInt16LE(18) === EXPECTED_MACHINE, `zt/zerotier-one is ${PLAT} (e_machine=${zt.data.readUInt16LE(18)}, expected ${EXPECTED_MACHINE})`);
}
const sv = find(inner, 'www/css/style.css');
const sjs = find(inner, 'server/server.js');
if (sjs) ok(sjs.data.toString().includes('GATEWAY_PREFIX'), 'server.js contains gateway-prefix routing');
const ajs = find(inner, 'www/js/app.js');
if (ajs) ok(ajs.data.toString().includes('API_BASE'), 'app.js uses API_BASE for gateway compatibility');

// JSON validity
for (const [list, n] of [[outer, 'config/privilege'], [outer, 'config/resource'], [outer, 'wizard/install'], [inner, 'ui/config']]) {
  const e = find(list, n);
  if (!e) { ok(false, `${n} missing`); continue; }
  try { JSON.parse(e.data.toString()); ok(true, `${n} is valid JSON`); }
  catch (err) { ok(false, `${n} invalid JSON: ${err.message}`); }
}

// manifest
const mf = find(outer, 'manifest');
if (mf) {
  const t = mf.data.toString();
  console.log('\n=== manifest ===');
  console.log(t.split('\n').map((l) => '  ' + l).join('\n'));
  for (const k of ['appname', 'version', 'platform', 'source', 'desktop_uidir', 'desktop_applaunchname', 'service_port'])
    ok(new RegExp('^' + k + '\\s*=', 'm').test(t), `manifest declares ${k}`);
  const platMatch = t.match(/^platform\s*=\s*(\S+)/m);
  const expectedManifestPlat = PLAT === 'x86_64' ? 'x86' : PLAT;
  ok(platMatch && platMatch[1] === expectedManifestPlat, `manifest platform matches package (${platMatch && platMatch[1]}, expected ${expectedManifestPlat})`);

  // fnpack records md5(app.tgz) as the package checksum; our mode repair
  // rewrites app.tgz, so the declared digest must be the repaired one.
  const appE = outer.find((e) => e.name === 'app.tgz');
  const declaredSum = (t.match(/^checksum\s*=\s*(\S+)/m) || [])[1];
  ok(!!declaredSum, `manifest declares checksum (${declaredSum})`);
  if (appE && declaredSum) {
    const actual = crypto.createHash('md5').update(appE.data).digest('hex');
    ok(actual === declaredSum, `checksum matches md5(app.tgz) (declared ${declaredSum}, actual ${actual})`);
  }
}

// no stray runtime files
const stray = [...outer, ...inner].filter((e) => /\.(sock|pid)$|pending_network|authtoken|identity\./.test(e.name));
ok(stray.length === 0, `no stray runtime files in package (${stray.map((s) => s.name).join(', ') || 'none'})`);

console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' CHECK(S) FAILED'}`);
process.exit(bad === 0 ? 0 : 1);
