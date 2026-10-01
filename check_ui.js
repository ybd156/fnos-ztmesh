/* Cross-check the frontend: every $('#id') in app.js must exist in index.html,
 * every data-view must have a matching #view-<name>, and every CSS class used by
 * the subnet view must be defined in style.css. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'fpk', 'app', 'www');
const js = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

let fail = 0;
function check(ok, msg) {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) fail++;
}

const refIds = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) refIds.add(m[1]);
const haveIds = new Set();
for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) haveIds.add(m[1]);

const missing = [...refIds].filter((i) => !haveIds.has(i)).sort();
console.log(`app.js references ${refIds.size} element ids; index.html defines ${haveIds.size}`);
check(missing.length === 0, missing.length ? 'MISSING IN HTML: ' + missing.join(', ') : 'every referenced element id exists in index.html');

const views = new Set();
for (const m of html.matchAll(/data-view="([a-z]+)"/g)) views.add(m[1]);
const secs = new Set();
for (const m of html.matchAll(/id="view-([a-z]+)"/g)) secs.add(m[1]);
const noSection = [...views].filter((v) => !secs.has(v));
const noNav = [...secs].filter((s) => !views.has(s));
console.log(`nav views: ${[...views].join(', ')} | sections: ${[...secs].join(', ')}`);
check(noSection.length === 0 && noNav.length === 0,
  (noSection.length ? 'nav without section: ' + noSection.join(', ') + '; ' : '') +
  (noNav.length ? 'section without nav: ' + noNav.join(', ') : '') || 'nav and sections line up');

const subnetIds = ['subnetBadge', 'subnetPhy', 'subnetPhyLabel', 'subnetTarget', 'subnetNet',
  'subnetToken', 'subnetTokenState', 'btnSubnetOn', 'btnSubnetOff', 'btnSaveToken',
  'btnClearToken', 'btnToggleToken', 'subnetStatus', 'subnetLog'];
const missSub = subnetIds.filter((i) => !haveIds.has(i));
check(missSub.length === 0, missSub.length ? 'subnet ids missing: ' + missSub.join(', ') : 'all subnet-routing ids present');

const classes = ['select.input', '.field-row', '.field-label', '.subnet-status', '.subnet-row',
  '.subnet-row-label', '.subnet-row-value', '.subnet-log'];
const missCls = classes.filter((c) => !css.includes(c + ' {') && !css.includes(c + '{') && !css.includes(c));
check(missCls.length === 0, missCls.length ? 'css rules missing: ' + missCls.join(', ') : 'subnet-routing css rules present');

/* selectors the JS actually uses on the element classes.
 * Some markup (net-opts, subnet-row) is generated in app.js template strings,
 * so scan both files or every dynamically-created class looks unused. */
const jsClasses = new Set();
for (const src of [html, js]) {
  for (const m of (src.match(/class="[^"]*"/g) || [])) {
    m.slice(7, -1).split(/\s+/).forEach((c) => { if (c && !c.includes('$')) jsClasses.add(c); });
  }
}
const unusedCss = ['net-opts', 'subnet-row', 'subnet-log', 'field-row'].filter((c) => !jsClasses.has(c));
check(unusedCss.length === 0, unusedCss.length ? 'classes in css but not in html: ' + unusedCss.join(', ') : 'subnet classes are used by index.html');

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL UI CHECKS PASSED');
process.exit(fail ? 1 : 0);
