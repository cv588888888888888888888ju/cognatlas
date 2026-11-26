'use strict';
/** KBC 条目判据（E1–E5）：条目侧栏历史 / 悬浮复制 / 专属标签 / tag: 检索。 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const SRC = '/tmp/kbc-try-vault';
const SB = '/tmp/kbc-entry-sandbox';
const HOME = '/tmp/kbc-entry-home';
const DOC = '20-学科学习/概率论与数理统计/概率论与数理统计-随机事件与概率公理化.md';

function sh(cmd) { return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' }); }
function build() {
  sh('/usr/bin/rm -rf ' + SB + ' ' + HOME);
  fs.mkdirSync(SB, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  sh('cp -a ' + SRC + '/. ' + SB + '/');
  return SB;
}

function runScene(src, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: HOME + '/.config', HOME, KB_ROOT: SB, KB_EVAL: src, KB_EVAL_WAIT: String(opts.wait || 2000), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 90000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('EVAL_RESULT '));
      let result = null;
      if (line) { try { result = JSON.parse(line.slice(12)); } catch (e) { result = { parseError: String(e) }; } }
      resolve({ result, out: out.split('\n').filter((l) => l.includes('[renderer]')).slice(-6), stderrTail: err.split('\n').filter(Boolean).slice(-3).join(' | ') });
    });
  });
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail));
  if (!pass) process.exitCode = 1;
}

(async () => {
  build();
  const sleep = 'await new Promise(r => setTimeout(r, ';

  {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      document.querySelector('#props .prop-row[data-field="source_checked"] .prop-key').click();
      ${sleep}800));
      const p = t.entryPanel();
      const vals = [...document.querySelectorAll('#ep-history .ep-val')].map(e => e.textContent);
      return { p, vals };
    `);
    const x = r.result || {};
    record('E1', x.p && x.p.open === true && /source_checked/.test(x.p.title || '') && x.p.path === DOC && x.p.histCount >= 2, x);
    record('E2', (x.vals || []).length >= 2 && /true → false/.test(x.vals[0] || ''), { vals: x.vals });
  }

  {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      const ok = t.copyEntry('title');
      ${sleep}250));
      const clip = await window.kb.clipboard();
      const tools = document.querySelector('#props .prop-row[data-field="title"] .prop-tools');
      return { ok, clip, tools: !!tools, toolCount: tools ? tools.querySelectorAll('.prop-tool').length : 0 };
    `);
    const x = r.result || {};
    record('E3', x.ok === true && x.tools === true && x.toolCount === 3 && /^title: /.test(x.clip || '') && /概率论/.test(x.clip || ''), x);
  }

  {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      await t.setEntryTag('description', ['概率论', '专测标签']);
      await t.openEntry('description');
      ${sleep}500));
      const p = t.entryPanel();
      await t.openDoc('${DOC}');
      await t.openEntry('description');
      ${sleep}400));
      return { p, p2: t.entryPanel() };
    `);
    const x = r.result || {};
    const tagsOk = (a) => a && (a.own || []).includes('专测标签') && (a.inherited || []).includes('概率论');
    record('E4', tagsOk(x.p) && tagsOk(x.p2), x);
    const side = path.join(HOME, '.config/cognatlas/entry-tags.json');
    let sideOk = false;
    try { const j = JSON.parse(fs.readFileSync(side, 'utf8')); sideOk = !!(j[DOC] && (j[DOC].description || []).includes('专测标签')); } catch (e) { sideOk = false; }
    record('E4b', sideOk, { side });
  }

  {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      await t.setEntryTag('description', ['专测标签']);
      document.getElementById('search-input').value = 'tag:专测标签';
      document.getElementById('search-input').dispatchEvent(new Event('input', { bubbles: true }));
      ${sleep}900));
      const hits = [...document.querySelectorAll('#search-list .result')].map(e => e.textContent);
      return { hits, count: hits.length };
    `);
    const x = r.result || {};
    record('E5', x.count === 1 && /标签命中：专测标签（条目 description）/.test(x.hits[0] || ''), x);
  }

  console.log('RESULT ' + (results.every((r) => r.pass) ? 'PASS' : 'FAIL'));
  process.exit(process.exitCode || 0);
})();
