'use strict';
/** KBC 检索键盘模型无头判据（K1–K7）。每个场景一个 Electron 进程；K5b 复用同一 XDG_CONFIG_HOME 验证持久化。 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP = path.resolve(__dirname, '..');
const KB_REAL = require('./_root');

function runScene(src, opts) {
  opts = opts || {};
  const configDir = opts.configDir || ('/tmp/kbc-keys-config-' + process.pid + '-' + Math.random().toString(36).slice(2, 7));
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: configDir, KB_ROOT: KB_REAL, KB_EVAL: src,
        KB_EVAL_WAIT: String(opts.wait || 1500), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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
      resolve({ code, result, configDir, stderrTail: err.split('\n').filter(Boolean).slice(-3).join(' | ') });
    });
  });
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail));
  if (!pass) process.exitCode = 1;
}

const PRESS = "const press = (k) => document.getElementById('search-input').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));";

(async () => {
  const mode = process.argv[2] || 'all';
  const want = (id) => mode === 'all' || mode === id;

  if (want('K1')) {
    const r = await runScene(`
      try {
        const t = window.__kbTest;
        const inp = document.getElementById('search-input');
        t.focusSearch();
        inp.value = 'tag:OKF';
        await t.doSearch('tag:OKF');
        await new Promise(r => setTimeout(r, 150));
        ${PRESS}
        const count = t.searchResults().length;
        const start = t.searchActiveIndex();
        const ariaStart = t.searchItems().filter(x => x.selected === 'true').map(x => x.index);
        press('ArrowDown'); press('ArrowDown');
        const after2 = t.searchActiveIndex();
        press('ArrowUp');
        const afterUp = t.searchActiveIndex();
        for (let i = 0; i < 30; i++) press('ArrowDown');
        const wrapped = t.searchActiveIndex();
        const foot = (document.querySelector('#search-list .sl-foot') || {}).textContent || '';
        const role = document.getElementById('search-list').getAttribute('role');
        return { count, start, ariaStart, after2, afterUp, wrapped, foot, role,
          ariaExpanded: inp.getAttribute('aria-expanded') };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `);
    const x = r.result || {};
    record('K1', x.start === 0 && x.after2 === 2 && x.afterUp === 1
      && x.wrapped === (x.afterUp + 30) % x.count && x.ariaStart && x.ariaStart[0] === 0, x);
    record('K7', /↑/.test(x.foot || '') && /Enter/.test(x.foot || '') && /Esc/.test(x.foot || '') && x.role === 'listbox' && x.ariaExpanded === 'true', x);
  }

  if (want('K2')) {
    const r = await runScene(`
      try {
        const t = window.__kbTest;
        const inp = document.getElementById('search-input');
        t.focusSearch();
        inp.value = 'tag:OKF';
        await t.doSearch('tag:OKF');
        await new Promise(r => setTimeout(r, 150));
        ${PRESS}
        const paths = t.searchResults().map(h => h.path.split('  ')[0]);
        press('ArrowDown'); press('ArrowDown'); press('ArrowUp');
        const idx = t.searchActiveIndex();
        press('Enter');
        await new Promise(r => setTimeout(r, 800));
        const opened = t.currentRel();
        const expected = paths[idx];
        const closedAfterOpen = !t.searchOpen();
        // Esc：重开检索再收起
        t.focusSearch();
        await new Promise(r => setTimeout(r, 150));
        const beforeEsc = t.searchOpen();
        press('Escape');
        const afterEsc = t.searchOpen();
        const focusInEditor = !!document.activeElement && document.activeElement.classList.contains('cm-content');
        return { idx, opened, expected, match: opened === expected, closedAfterOpen, beforeEsc, afterEsc, focusInEditor };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `);
    const x = r.result || {};
    record('K2', x.match === true && x.closedAfterOpen === true && x.beforeEsc === true && x.afterEsc === false && x.focusInEditor === true, x);
  }

  if (want('K4')) {
    const r = await runScene(`
      try {
        const t = window.__kbTest;
        const inp = document.getElementById('search-input');
        t.focusSearch();
        inp.value = 'tag:OKF';
        await t.doSearch('tag:OKF');
        await new Promise(r => setTimeout(r, 200));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        const nodes = [...document.querySelectorAll('#search-list .result')];
        nodes[3].dispatchEvent(new MouseEvent('mouseenter'));
        const hovered = t.searchActiveIndex();
        return { hovered, selected: t.searchItems().filter(x => x.active).map(x => x.index) };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `);
    const x = r.result || {};
    record('K4', x.hovered === 3 && x.selected && x.selected[0] === 3, x);
  }

  let sharedConfig = null;
  if (want('K5')) {
    const r = await runScene(`
      try {
        const t = window.__kbTest;
        const inp = document.getElementById('search-input');
        t.searchClearHistory();
        t.focusSearch();
        inp.value = 'tag:OKF';
        await t.doSearch('tag:OKF');
        await new Promise(r => setTimeout(r, 150));
        ${PRESS}
        press('Enter');
        await new Promise(r => setTimeout(r, 800));
        const hist = t.searchHistory();
        inp.value = '';
        t.focusSearch();
        await new Promise(r => setTimeout(r, 120));
        const shown = document.querySelectorAll('#search-list .result.hist').length;
        const raw = localStorage.getItem('kb:searchHistory');
        return { hist, shown, raw };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `);
    sharedConfig = r.configDir;
    const x = r.result || {};
    record('K5', Array.isArray(x.hist) && x.hist[0] === 'tag:OKF' && x.shown === 1 && !!x.raw, x);

    const r2 = await runScene(`
      try {
        const t = window.__kbTest;
        const hist = t.searchHistory();
        t.focusSearch();
        await new Promise(r => setTimeout(r, 120));
        const shown = document.querySelectorAll('#search-list .result.hist').length;
        return { hist, shown };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `, { configDir: sharedConfig });
    record('K5b', r2.result && Array.isArray(r2.result.hist) && r2.result.hist[0] === 'tag:OKF' && r2.result.shown === 1, r2.result || {});
  }

  if (want('K6')) {
    const r = await runScene(`
      try {
        const t = window.__kbTest;
        t.searchClearHistory();
        t.searchPushHistory('alpha');
        t.searchPushHistory('beta');
        t.focusSearch();
        await new Promise(r => setTimeout(r, 120));
        const before = document.querySelectorAll('#search-list .result.hist').length;
        document.querySelector('#search-list .hist-del').click();
        await new Promise(r => setTimeout(r, 80));
        const afterDel = t.searchHistory();
        const shownAfterDel = document.querySelectorAll('#search-list .result.hist').length;
        document.querySelector('#search-list .sl-clear').click();
        await new Promise(r => setTimeout(r, 80));
        const afterClear = t.searchHistory();
        const keyGone = localStorage.getItem('kb:searchHistory') === null;
        return { before, afterDel, shownAfterDel, afterClear, keyGone };
      } catch (e) { return { error: String(e && e.stack || e) }; }
    `);
    const x = r.result || {};
    record('K6', x.before === 2 && x.afterDel && x.afterDel.length === 1 && x.shownAfterDel === 1
      && x.afterClear && x.afterClear.length === 0 && x.keyGone === true, x);
  }

  const passed = results.filter((x) => x.pass).length;
  console.log('RESULT ' + (passed === results.length ? 'PASS' : 'FAIL') + ' ' + passed + '/' + results.length);
})().catch((e) => { console.error(e); process.exit(1); });
