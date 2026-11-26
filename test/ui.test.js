'use strict';
/** KBC UI 判据无头驱动（A14/A16/A17/A18/A19/A20）。每个场景一个 Electron 进程，渲染进程跑脚本并回传 EVAL_RESULT。 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const KB_REAL = require('./_root');
const SB = '/tmp/kbc-ui-sandbox';
const DOC = '70-元知识/70.1-OKF规范要点.md';
const DOMAIN = '30-Agent工程/30.7-多Agent并行协作/superagent-prototype/docs/001-domain.md';

function sh(cmd, opts) { return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', ...opts }); }

function buildSandbox() {
  sh('/usr/bin/rm -rf ' + SB);
  fs.mkdirSync(SB, { recursive: true });
  sh("cd " + KB_REAL + " && find . -name '*.md' -print0 | tar --null -T - -cf - | tar -xf - -C " + SB);
  sh('cp -a ' + KB_REAL + '/.okf/. ' + SB + '/.okf/');
  sh('cd ' + SB + ' && git init -q && git config core.quotepath false && git config user.name "kb selftest" && git config user.email "kb@localhost" && git add -A && git commit -qm "sandbox init"');
  return SB;
}

function runScene(src, opts) {
  opts = opts || {};
  const kbRoot = opts.kbRoot || SB;
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: '/tmp/kbc-test-config-' + process.pid + '-' + Math.random().toString(36).slice(2, 7), KB_ROOT: kbRoot, KB_EVAL: src, KB_EVAL_WAIT: String(opts.wait || 1800), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('EVAL_RESULT '));
      let result = null;
      if (line) { try { result = JSON.parse(line.slice(12)); } catch (e) { result = { parseError: String(e) }; } }
      resolve({ code, result, out: out.split('\n').filter((l) => l.includes('[renderer]') || l.includes('[renderer-gone]')).slice(-8), stderrTail: err.split('\n').filter(Boolean).slice(-4).join(' | ') });
    });
  });
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail));
  if (!pass) process.exitCode = 1;
}

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'setup') { buildSandbox(); console.log('sandbox ready ' + SB); return; }
  if (!fs.existsSync(SB)) buildSandbox();

  if (mode === 'all' || mode === 'A14') {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      t.cursorTo(t.doc().length);
      t.typeText('\\n\\n中文输入测试 2026-11-25');
      const typed = t.doc().includes('中文输入测试 2026-11-25');
      const res = await t.save();
      await new Promise(r => setTimeout(r, 1200));
      const disk = (await window.kb.read('${DOC}')).text;
      return { typed, saveOk: !!(res && res.ok), onDisk: disk.includes('中文输入测试 2026-11-25'), status: t.status() };
    `);
    const x = r.result || {};
    if (r.result && r.result.error) x.rendererLog = r.out;
    record('A14', x.typed === true && x.saveOk === true && x.onDisk === true, x);
  }

  if (mode === 'all' || mode === 'A16') {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      const clicked = t.clickProp('tags');
      await new Promise(r => setTimeout(r, 600));
      const input = t.propInput();
      const sugg = t.suggestions();
      input.value = 'Agent工程';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 3000));
      const disk = (await window.kb.read('${DOC}')).text;
      const m = /tags:\\s*(.+)/.exec(disk);
      return { clicked, inputShown: !!input, suggCount: sugg.length, hasAgent: sugg.includes('Agent工程'), tagsLine: m ? m[1].trim() : null, status: t.status() };
    `);
    const x = r.result || {};
    record('A16', x.clicked === true && x.suggCount > 0 && x.hasAgent === true && /Agent工程/.test(x.tagsLine || ''), x);
  }

  if (mode === 'all' || mode === 'A17') {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOC}');
      t.cursorTo(t.doc().length);
      t.typeText('\\n\\n[[00');
      await new Promise(r => setTimeout(r, 1500));
      const box = document.querySelector('.cm-tooltip-autocomplete');
      const opts = box ? [...box.querySelectorAll('li')].map(e => e.textContent) : [];
      const links = await t.complete('link', '00');
      return { tooltip: !!box, optionCount: opts.length, sample: opts.slice(0, 3), linkCount: links.length, status: t.status() };
    `);
    const x = r.result || {};
    record('A17', x.tooltip === true && x.optionCount >= 1, x);
  }

  if (mode === 'all' || mode === 'A18') {
    const r = await runScene(`
      const t = window.__kbTest;
      await t.openDoc('${DOMAIN}');
      const before = t.currentRel();
      const bl = t.backlinks();
      const clicked = t.clickBacklink(0);
      await new Promise(r => setTimeout(r, 1500));
      return { count: bl.length, first: bl[0] || null, clicked, after: t.currentRel(), changed: t.currentRel() !== before };
    `, { kbRoot: KB_REAL });
    const x = r.result || {};
    record('A18', x.count >= 7 && x.clicked === true && x.changed === true, x);
  }

  if (mode === 'all' || mode === 'A19') {
    const r = await runScene(`
      const t = window.__kbTest;
      t.openPalette();
      await new Promise(r => setTimeout(r, 400));
      const all = t.paletteItems();
      t.paletteType('保存');
      await new Promise(r => setTimeout(r, 300));
      const filtered = t.paletteItems();
      return { open: t.paletteOpen(), allCount: all.length, filtered, hit: filtered.some(s => s.includes('保存')) };
    `);
    const x = r.result || {};
    record('A19', x.open === true && x.allCount >= 8 && x.hit === true, x);
  }

  if (mode === 'all' || mode === 'A20') {
    const r = await runScene(`
      const t = window.__kbTest;
      t.focusSearch();
      const hits = await t.doSearch('OKF');
      const first = t.searchResults().slice(0, 3);
      const tagHits = await t.doSearch('tag:OKF -tag:P0');
      const top = document.getElementById('topbar').getBoundingClientRect();
      const tabs = document.getElementById('tabs').getBoundingClientRect();
      t.renderResults([{ title: '过期夹具', path: '70-元知识/过期夹具.md', snippet: '...', warnings: ['expired: stale_after=2026-01-01（该文档已过期，结论需复核）'] }]);
      const el = document.querySelector('#search-list .w');
      const warnText = el ? el.textContent : '';
      return { open: t.searchOpen(), hits: hits.length, first, tagCount: tagHits.length,
               aboveTabs: top.top < tabs.top, warnText, hasExpired: warnText.includes('expired') };
    `, { kbRoot: KB_REAL });
    const x = r.result || {};
    record('A20', x.open === true && x.hits >= 1 && x.tagCount >= 1 && x.aboveTabs === true && x.hasExpired === true, x);
  }

  if (mode === 'all' || mode === 'A20b') {
    const r = await runScene(`
      const t = window.__kbTest;
      t.focusSearch();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const panel = document.querySelector('.cm-search');
      return { findOpen: !!panel, hasInput: !!(panel && panel.querySelector('input')) };
    `, { kbRoot: KB_REAL });
    const x = r.result || {};
    record('A20b', x.findOpen === true && x.hasInput === true, x);
  }

  if (mode === 'all' || mode === 'A21') {
    const home = process.env.HOME || require('node:os').homedir();
    const launcher = process.env.KB_LAUNCHER || path.join(home, '.local/bin/cognatlas');
    const desk = process.env.KB_DESKTOP || path.join(home, '.local/share/applications/cognatlas.desktop');
    const exists = fs.existsSync(launcher) && fs.existsSync(desk);
    let dv = 'skip', rc = null;
    try { dv = sh('desktop-file-validate ' + desk + ' 2>&1 || true').trim(); } catch (e) { dv = String(e); }
    try {
      const out = require('node:child_process').execFileSync(launcher, ['-e', 'process.exit(7)'], { env: { ...process.env, DISPLAY: ':99', ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 });
      rc = 0;
    } catch (e) { rc = e.status; }
    record('A21', exists && dv === '' && rc === 7, { exists, desktopValidate: dv, passthroughCode: rc });
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('RESULT ' + (pass === results.length ? 'PASS' : 'FAIL') + ' ' + pass + '/' + results.length);
})();