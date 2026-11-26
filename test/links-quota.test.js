'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const links = require('../lib/links-store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-quota-'));
let fail = 0;
function check(n, c, d) { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (d ? '  ' + d : '')); if (!c) fail++; }
try {
  const base = Date.now();
  for (let i = 0; i < 500; i++) {
    links.save({ url: 'http://quota.test/' + i, title: 't' + i, html: '<p>' + i + '</p>', ts: base + i }, { dir });
  }
  check('Q1 500 条可保存', links.recent(1, { dir }).length === 1);
  let err = '';
  try { links.save({ url: 'http://quota.test/overflow', title: 'x', html: '<p>x</p>', ts: base + 999 }, { dir }); } catch (e) { err = String(e.message || e); }
  check('Q2 第 501 条报 SNAP-QUOTA', /SNAP-QUOTA/.test(err), err);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
process.exit(fail ? 1 : 0);
