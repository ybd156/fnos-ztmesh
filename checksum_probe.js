// Determine what the fnpack-generated manifest "checksum" field actually covers.
// If it covers modes/tar bytes, post-hoc mode repair would invalidate it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const RAW = path.join(HERE, '_raw');

const rawFpk = fs.readFileSync(path.join(RAW, 'zerotier.fpk'));
const gz = zlib.gunzipSync(rawFpk);

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
    const dataStart = o + 512;
    out.push({ name, size, mode, type, data: buf.slice(dataStart, dataStart + size) });
    o = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const outer = parseTar(gz);
const mfEntry = outer.find((e) => e.name === 'manifest');
const manifest = mfEntry.data.toString();
const declared = (manifest.match(/^checksum\s*=\s*(\S+)/m) || [])[1];
console.log('\ndeclared checksum :', declared, `(${declared ? declared.length * 4 : 0} bits)`);

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha = (b, a) => crypto.createHash(a).update(b).digest('hex');

const files = outer.filter((e) => String.fromCharCode(e.type) === '0' || e.type === '0');
const appTgzE = outer.find((e) => e.name === 'app.tgz');
const inner = appTgzE ? parseTar(zlib.gunzipSync(appTgzE.data)) : [];
const innerFiles = inner.filter((e) => e.type === '0');

const catFiles = (list) => Buffer.concat(list.map((e) => e.data));
const catNameData = (list) => Buffer.concat(list.flatMap((e) => [Buffer.from(e.name + '\n'), e.data]));
const catModeData = (list) => Buffer.concat(list.flatMap((e) => [Buffer.from(e.name + ':' + e.mode.toString(8) + '\n'), e.data]));

const candidates = {
  'md5(whole .fpk file)': md5(rawFpk),
  'md5(gunzipped outer tar)': md5(gz),
  'sha256(whole .fpk file)': sha(rawFpk, 'sha256'),
  'md5(manifest bytes)': md5(mfEntry.data),
  'md5(manifest minus checksum line)': md5(Buffer.from(manifest.split('\n').filter((l) => !/^checksum\s*=/.test(l)).join('\n'))),
  'md5(app.tgz raw bytes)': md5(appTgzE.data),
  'md5(gunzipped app.tar)': md5(zlib.gunzipSync(appTgzE.data)),
  'md5(concat outer file contents)': md5(catFiles(files)),
  'md5(concat NAME+contents, outer)': md5(catNameData(files)),
  'md5(concat NAME:MODE+contents, outer)': md5(catModeData(files)),
  'md5(concat inner file contents)': md5(catFiles(innerFiles)),
  'md5(concat NAME+contents, inner)': md5(catNameData(innerFiles)),
  'md5(concat NAME:MODE+contents, inner)': md5(catModeData(innerFiles)),
  'md5(concat inner then outer)': md5(Buffer.concat([catFiles(innerFiles), catFiles(files)])),
};

console.log('\ncandidate digest                                                 match');
for (const [label, v] of Object.entries(candidates)) {
  const m = v === declared;
  console.log(`  ${label.padEnd(42)} ${v}  ${m ? '  <<<< MATCH' : ''}`);
}
