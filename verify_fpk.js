// 校验构建出的 .fpk：结构、权限、二进制架构与内容契约。
// 用法: node verify_fpk.js [ztmesh-x86_64.fpk|ztmesh-arm.fpk]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FP = path.resolve(__dirname, process.argv[2] || 'ztmesh-x86_64.fpk');
const raw = zlib.gunzipSync(fs.readFileSync(FP));

// 从文件名推断目标平台（ztmesh-arm.fpk -> arm）
const PLAT = (FP.match(/ztmesh-(\w+)\.fpk$/) || [])[1] || 'x86_64';
const EXPECTED_MACHINE = PLAT === 'arm' ? 183 : 62;   // 183=aarch64, 62=x86-64
const EXPECTED_MANIFEST_PLAT = PLAT === 'x86_64' ? 'x86' : PLAT;

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

const appTgz = outer.find((e) => e.name === 'app.tgz');
let inner = [];
if (appTgz && appTgz.size) inner = parseTar(zlib.gunzipSync(appTgz.data));
console.log('\n=== app.tgz ===');
for (const e of inner) console.log(`  ${e.mode.toString(8).padStart(4, '0')} ${String(e.size).padStart(9)} ${isDir(e) ? 'd' : '-'} ${e.name}`);

const find = (list, n) => list.find((e) => e.name === n || e.name === './' + n);

const REQUIRED_OUTER = ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'config/privilege', 'config/resource', 'wizard/install', 'wizard/uninstall'];
const REQUIRED_CMD = ['main', 'install_init', 'install_callback', 'upgrade_init', 'upgrade_callback', 'uninstall_init', 'uninstall_callback', 'config_init', 'config_callback'];
// 2.0: 后端是 Go 单二进制 app/bin/ztmesh-server，不再是 server/server.js
const REQUIRED_INNER = ['bin/ztmesh-server', 'ui/config', 'ui/images/icon_64.png', 'ui/images/icon_256.png', 'www/index.html', 'www/css/style.css', 'www/js/app.js', 'www/images/icon_64.png', 'zt/zerotier-one'];

console.log('\n=== CHECKS ===');
let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); };

for (const n of REQUIRED_OUTER) ok(!!find(outer, n), `outer has ${n}`);
for (const n of REQUIRED_CMD) {
  const e = find(outer, 'cmd/' + n);
  ok(e && (e.mode & 0o111) === 0o111, `cmd/${n} present and executable (mode ${e ? e.mode.toString(8) : 'missing'})`);
}
for (const n of REQUIRED_INNER) ok(!!find(inner, n), `app/ has ${n}`);

// ELF 头 + e_machine 必须与包平台一致（两个二进制都查）
function checkElf(entry, label) {
  if (!entry) { ok(false, `${label} missing, cannot check ELF`); return; }
  const d = entry.data;
  const isElf = d.length > 20 && d[0] === 0x7f && d[1] === 0x45 && d[2] === 0x4c && d[3] === 0x46;
  ok(isElf, `${label} is an ELF binary`);
  if (!isElf) return;
  const machine = d[5] === 1 ? d.readUInt16LE(18) : d.readUInt16BE(18);
  ok(machine === EXPECTED_MACHINE, `${label} is ${PLAT} (e_machine=${machine}, expected ${EXPECTED_MACHINE})`);
  ok((entry.mode & 0o111) === 0o111, `${label} executable (mode ${entry.mode.toString(8)})`);
}

checkElf(find(inner, 'bin/ztmesh-server'), 'bin/ztmesh-server');
checkElf(find(inner, 'zt/zerotier-one'), 'zt/zerotier-one');

// 2.0 起不再打包 Node 后端源码
const legacyServer = inner.filter((e) => /^\.?\/?server\//.test(e.name));
ok(legacyServer.length === 0, `no legacy Node backend in app.tgz (${legacyServer.map((e) => e.name).join(', ') || 'none'})`);

// 前端仍须走统一网关入口（API_BASE 由 app.js 拼接）
const ajs = find(inner, 'www/js/app.js');
if (ajs) ok(ajs.data.toString().includes('API_BASE'), 'app.js uses API_BASE for gateway compatibility');
else ok(false, 'www/js/app.js missing, cannot check API_BASE');

// JSON 有效性
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
  ok(platMatch && platMatch[1] === EXPECTED_MANIFEST_PLAT, `manifest platform matches package (${platMatch && platMatch[1]}, expected ${EXPECTED_MANIFEST_PLAT})`);

  // 2.0: 单一静态二进制，不再声明 nodejs_v22 依赖
  ok(!/^install_dep_apps\s*=/m.test(t), 'manifest no longer declares install_dep_apps (no external runtime)');

  // 端口统一为 13443（旧版 cmd/main 缺省 3443 与 manifest 不一致）
  const portMatch = t.match(/^service_port\s*=\s*(\d+)/m);
  ok(portMatch && portMatch[1] === '13443', `service_port is 13443 (${portMatch && portMatch[1]})`);

  // checksum 必须是最终 app.tgz 字节的 md5
  const declaredSum = (t.match(/^checksum\s*=\s*(\S+)/m) || [])[1];
  ok(!!declaredSum, `manifest declares checksum (${declaredSum})`);
  if (appTgz && declaredSum) {
    const actual = crypto.createHash('md5').update(appTgz.data).digest('hex');
    ok(actual === declaredSum, `checksum matches md5(app.tgz) (declared ${declaredSum}, actual ${actual})`);
  }
}

// 包内不得残留运行时文件
const stray = [...outer, ...inner].filter((e) => /\.(sock|pid)$|pending_network|authtoken|identity\.|zt_disabled|autostart\.conf/.test(e.name));
ok(stray.length === 0, `no stray runtime files in package (${stray.map((s) => s.name).join(', ') || 'none'})`);

console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' CHECK(S) FAILED'}`);
process.exit(bad === 0 ? 0 : 1);
