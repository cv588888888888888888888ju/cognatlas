'use strict';
/** 命令面板场景判据（P1–P8）：Ctrl+P 全局开合 / Esc / 点外 / 鼠标移开 / 过滤 / 焦点归还。 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const APP = path.resolve(__dirname, '..');
const HOME = '/tmp/kbc-palette-home';
const KB = '/tmp/kbc-entry-sandbox';
const DOC = '20-学科学习/概率论与数理统计/概率论与数理统计-随机事件与概率公理化.md';

function runScene(src) {
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: HOME + '/.config', HOME, KB_ROOT: KB, KB_EVAL: src, KB_EVAL_WAIT: '2600', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('EVAL_RESULT '));
      resolve(line ? JSON.parse(line.slice(12)) : { error: 'NO-RESULT', tail: out.slice(-400) });
    });
  });
}

const results = [];
function rec(id, pass, d) { results.push(pass); console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(d)); if (!pass) process.exitCode = 1; }

(async () => {
  const r = await runScene(`
    const t = window.__kbTest;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...mods }));
    await t.openDoc('${DOC}');
    await sleep(400);

    // P1 编辑器焦点下 Ctrl+P
    document.querySelector('.cm-content').focus();
    key('p'); await sleep(300);
    const p1 = t.paletteOpen();

    // P3 再按一次 Ctrl+P 关闭
    key('p'); await sleep(200);
    const p3 = !t.paletteOpen();

    // P2 焦点不在编辑器（body）也能开
    document.body.focus();
    key('p'); await sleep(250);
    const p2 = t.paletteOpen();

    // P7 过滤
    const before = t.paletteItems().length;
    t.paletteFilter('保存');
    const filtered = t.paletteItems();

    // P4 Esc 关闭
    key('Escape'); await sleep(150);
    const p4 = !t.paletteOpen();

    // P5 点面板外关闭
    key('p'); await sleep(250);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(150);
    const p5 = !t.paletteOpen();

    // P6 鼠标移开关闭
    key('p'); await sleep(250);
    document.getElementById('palette').dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    await sleep(320);
    const p6 = !t.paletteOpen();

    // P8 关闭后焦点回到编辑器
    const focused = document.activeElement && (document.activeElement.closest ? !!document.activeElement.closest('.cm-editor') : false);

    return { p1, p2, p3, p4, p5, p6, focused, before, filtered };
  `);

  rec('P1', r.p1 === true, r);
  rec('P2', r.p2 === true, { p2: r.p2 });
  rec('P3', r.p3 === true, { p3: r.p3 });
  rec('P4', r.p4 === true, { p4: r.p4 });
  rec('P5', r.p5 === true, { p5: r.p5 });
  rec('P6', r.p6 === true, { p6: r.p6 });
  rec('P7', Array.isArray(r.filtered) && r.filtered.some((x) => /保存并入库/.test(x)), { filtered: r.filtered });
  rec('P8', r.focused === true, { focused: r.focused });
  console.log('RESULT ' + (results.every(Boolean) ? 'PASS' : 'FAIL'));
  process.exit(process.exitCode || 0);
})();
