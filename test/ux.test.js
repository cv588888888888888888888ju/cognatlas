'use strict';
/** 面向用户能力的无头判据：新建/重命名对话框、自动保存、失败横幅、快速切换、脏状态同步。 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const KB_REAL = require('./_root');
const SB = '/tmp/kbc-ux-sandbox';

function sh(cmd) { return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' }); }
function buildSandbox() {
  sh('/usr/bin/rm -rf ' + SB);
  fs.mkdirSync(SB, { recursive: true });
  sh("cd " + KB_REAL + " && find . -name '*.md' -print0 | tar --null -T - -cf - | tar -xf - -C " + SB);
  sh('cp -a ' + KB_REAL + '/.okf/. ' + SB + '/.okf/');
  sh('cd ' + SB + ' && git init -q && git config core.quotepath false && git config user.name "kb ux" && git config user.email "kb@localhost" && git add -A && git commit -qm init');
}

function runScene(src, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = spawn(path.join(APP, 'node_modules/.bin/electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP,
      env: { ...process.env, DISPLAY: ':99', XDG_CONFIG_HOME: '/tmp/kbc-test-config-' + process.pid + '-' + Math.random().toString(36).slice(2, 7), KB_ROOT: opts.kbRoot || SB, KB_EVAL: src, KB_EVAL_WAIT: String(opts.wait || 1800), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 90000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('EVAL_RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice(12)) : null; } catch (e) { result = { parseError: String(e) }; }
      resolve(result);
    });
  });
}

let failed = 0;
function record(id, pass, detail) {
  if (!pass) failed++;
  console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + JSON.stringify(detail));
}

(async () => {
  buildSandbox();

  const u1 = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('70-元知识/70.1-OKF规范要点.md');
    t.runCommand('new');
    await new Promise(r => setTimeout(r, 400));
    const opened = t.dialogOpen();
    t.dialogSet('用户测试笔记');
    t.dialogOk();
    await new Promise(r => setTimeout(r, 1200));
    const rel = t.currentRel();
    let disk = '';
    try { disk = (await window.kb.read(rel)).text; } catch (e) { disk = 'ERR:' + e.message; }
    return { opened, rel, hasTitle: disk.includes('title: 用户测试笔记'), dirty: t.dirty(), status: t.status() };
  `);
  record('U1 新建笔记（对话框）', u1 && u1.opened === true && u1.rel === '00-收件箱/用户测试笔记.md' && u1.hasTitle === true, u1);

  const u3 = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('70-元知识/70.1-OKF规范要点.md');
    t.cursorTo(t.doc().length);
    t.typeText(String.fromCharCode(10, 10) + '自动保存测试 2026-11-25');
    await new Promise(r => setTimeout(r, 200));
    const dirtyNow = t.dirty();
    await new Promise(r => setTimeout(r, 2200));
    const w = await t.windowState();
    const disk = (await window.kb.read('70-元知识/70.1-OKF规范要点.md')).text;
    return { dirtyNow, dirtyAfter: t.dirty(), mainDirty: w.dirty, onDisk: disk.includes('自动保存测试 2026-11-25'), status: t.status(), right: t.statusRight() };
  `);
  record('U3 自动保存（1.2s）', u3 && u3.dirtyNow === true && u3.dirtyAfter === false && u3.mainDirty === false && u3.onDisk === true, u3);

  const u4 = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('70-元知识/70.1-OKF规范要点.md');
    t.setDoc(t.doc().replace('tags:', 'tags: [坏掉的未闭合'));
    await new Promise(r => setTimeout(r, 2400));
    return { banner: t.bannerVisible(), status: t.status(), stillHasText: t.doc().includes('坏掉的未闭合'), dirty: t.dirty() };
  `);
  record('U4 保存失败横幅', u4 && u4.banner === true && String(u4.status).indexOf('保存被拒') === 0 && u4.stillHasText === true && u4.dirty === true, u4);

  const u5 = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('70-元知识/70.1-OKF规范要点.md');
    await t.openSwitcher();
    const opened = t.switcherOpen();
    const n = t.switcherItems().length;
    t.switcherType('50.11');
    const filtered = t.switcherItems();
    const first = document.querySelector('#switcher-list .item');
    if (first) first.click();
    await new Promise(r => setTimeout(r, 800));
    return { opened, total: n, filtered: filtered.slice(0, 3), after: t.currentRel(), closed: !t.switcherOpen() };
  `);
  record('U5 快速切换 Ctrl+O', u5 && u5.opened === true && u5.total >= 30 && u5.filtered.length >= 1 && String(u5.after).includes('50.11') && u5.closed === true, u5);

  const u2 = await runScene(`
    const t = window.__kbTest;
    await t.openDoc('00-收件箱/用户测试笔记.md');
    const pend = t.renameCurrent();
    await new Promise(r => setTimeout(r, 400));
    const opened = t.dialogOpen();
    t.dialogSet('00-收件箱/重命名后的笔记.md');
    t.dialogOk();
    await new Promise(r => setTimeout(r, 1500));
    let err = null;
    await pend.catch((e) => { err = String(e); });
    const rel = t.currentRel();
    let oldGone = false;
    try { await window.kb.read('00-收件箱/用户测试笔记.md'); } catch (e) { oldGone = true; }
    return { opened, rel, oldGone, err, banner: document.getElementById('banner').textContent, status: t.status() };
  `);
  record('U2 重命名（对话框 + 改链）', u2 && u2.opened === true && u2.rel === '00-收件箱/重命名后的笔记.md' && u2.oldGone === true, u2);

  console.log('RESULT ' + (failed ? 'FAIL ' + failed : 'PASS'));
  process.exit(failed ? 1 : 0);
})();
