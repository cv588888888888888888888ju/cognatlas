'use strict';
/** 链接三态验收：悬浮预览 / 左键跳转 / 中键新窗口（只读真库） */
const { spawn } = require('node:child_process');
const path = require('node:path');
const APP = path.resolve(__dirname, '..');
const KB = require('./_root');
const DOC = '30-Agent工程/30.7-多Agent并行协作/superagent-prototype/docs/001-domain.md';

function runScene(src, kbRoot = KB) {
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: '/tmp/kbc-test-config-' + process.pid + '-' + Math.random().toString(36).slice(2, 7), KB_ROOT: kbRoot, KB_EVAL: src, KB_EVAL_WAIT: '1600', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('EVAL_RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice(12)) : null; } catch (e) { result = { parseError: String(e) }; }
      resolve(result);
    });
  });
}

(async () => {
  const r = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('${DOC}');
    const before = t.currentRel();
    const links = t.links();
    t.hoverLink(0);
    await new Promise(r => setTimeout(r, 900));
    const peekShown = t.peekVisible();
    const peekText = t.peekText();
    t.hidePeek();
    const w0 = await t.windowCount();
    const opened = await t.openLink(0, true);
    await new Promise(r => setTimeout(r, 900));
    const w1 = await t.windowCount();
    const jumped = await t.openLink(0, false);
    const afterJump = t.currentRel();
    return { before, links: links.slice(0, 4), linkCount: links.length, peekShown, peekText: peekText.slice(0, 120), jumped, afterJump, w0, w1, opened };
  `);
  console.log(JSON.stringify(r, null, 0));
  const ok = r && r.linkCount >= 1 && r.peekShown === true && r.afterJump && r.afterJump !== r.before && r.w1 > r.w0;
  console.log('RESULT ' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
})();
