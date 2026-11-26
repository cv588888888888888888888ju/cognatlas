'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const REAL = require('./_root');
const F = String.fromCharCode(96, 96, 96);
let fail = 0;
function check(n, c, d) { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (d ? '  ' + d : '')); if (!c) fail++; }
function git(a, cwd) { return execFileSync('git', a, { cwd, encoding: 'utf8' }); }
function runEval(env, src) {
  return new Promise((resolve) => {
    const ch = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP, env: { ...process.env, ...env, DISPLAY: ':99', KB_EVAL: src, KB_EVAL_WAIT: '900', KB_EVAL_TIMEOUT: '35000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { ch.kill('SIGKILL'); resolve({ out, timeout: true }); }, 90000);
    ch.on('exit', () => { clearTimeout(t); resolve({ out }); });
  });
}
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-plugin-'));
  const vault = path.join(tmp, 'vault');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(vault, '00-收件箱'), { recursive: true });
  fs.mkdirSync(path.join(vault, '_assets'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(path.join(REAL, '.okf'), path.join(vault, '.okf'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_assets', 'a.mp4'), 'x');
  fs.writeFileSync(path.join(vault, '_assets', 'p.png'), 'x');
  try { fs.symlinkSync('/etc/passwd', path.join(vault, '_assets', 'escape.mp4')); } catch (e) {}
  git(['init', '-q'], vault);
  git(['config', 'core.quotepath', 'false'], vault);
  git(['config', 'user.name', 'test'], vault);
  git(['config', 'user.email', 't@local'], vault);
  const bad1 = { name: 'badcomponent', version: 1, fence: 'kb-frame', component: 'iframe', props: { src: { required: true } } };
  const bad2 = { name: 'dup', version: 1, fence: 'kb-video', component: 'video', props: { src: { required: true } } };
  for (const pair of [['badcomponent', bad1], ['zdup', bad2]]) {
    const d = path.join(vault, '.okf', 'plugins', pair[0]);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify(pair[1]));
  }
  const head = ['---', 'type: Note', 'title: 视频', 'status: stable', 'generated:', '  by: human:user', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', '---', '', '# 视频', ''];
  const doc = head.concat([
    F + 'kb-video', 'src: https://example.com/a.mp4', 'poster: ../_assets/p.png', 'title: 远程演示', 'loop: true', F, '',
    F + 'kb-video', 'src: ../_assets/a.mp4', 'muted: true', F, '',
    F + 'kb-video', 'src: javascript:alert(1)', 'bogus: 1', F, ''
  ]).join('\n');
  fs.writeFileSync(path.join(vault, '00-收件箱', '视频.md'), doc);
  const fb = head.concat([F + 'kb-video', 'src: http://127.0.0.1:9/x.mp4', 'fallback: ../_assets/a.mp4', F, '']).join('\n');
  fs.writeFileSync(path.join(vault, '00-收件箱', '视频回退.md'), fb);
  const src = [
    'const t=window.__kbTest; const out={};',
    'await t.openDoc("00-收件箱/视频.md"); await new Promise(r=>setTimeout(r,1000));',
    'out.plugins=t.plugins(); out.blocks=document.querySelectorAll(".kb-plugin").length;',
    'out.videos=[...document.querySelectorAll("video.kb-video")].map(v=>({src:v.getAttribute("src")||"",poster:v.getAttribute("poster")||"",controls:v.controls,loop:v.loop,muted:v.muted,title:v.title}));',
    'out.errors=[...document.querySelectorAll(".kb-plugin-error")].map(e=>e.textContent);',
    'const c=await t.checkCurrentDoc(); out.check={counts:c&&c.counts,rows:t.checkPanel().rows};',
    'await t.openDoc("00-收件箱/视频回退.md"); await new Promise(r=>setTimeout(r,2600));',
    'const fv=document.querySelector("video.kb-video"); out.fallback={src:(fv&&fv.getAttribute("src"))||"",warns:[...document.querySelectorAll(".kb-plugin-warn")].map(e=>e.textContent)};',
    'out.asset={escape:await window.kb.assetUrl("../../etc/passwd","00-收件箱/视频.md"),symlink:await window.kb.assetUrl("../_assets/escape.mp4","00-收件箱/视频.md")};',
    'return out;'
  ].join('\n');
  runEval({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), KB_ROOT: vault, KB_NO_GUESS: '1' }, src).then((res) => {
    const m = /EVAL_RESULT (\{[\s\S]*\})/.exec(res.out);
    let o = null;
    try { o = m ? JSON.parse(m[1]) : null; } catch (e) {}
    check('EVAL 返回结果', !!o, o ? '' : res.out.slice(-300));
    if (!o) { console.log('\nRESULT FAIL(1)'); process.exit(1); }
    check('P1 只装载合法插件（非法组件/重复 fence 被跳过）', o.plugins.length === 1 && o.plugins[0].name === 'video', JSON.stringify(o.plugins));
    check('P2 远程 video 与属性正确', o.videos[0] && o.videos[0].src === 'https://example.com/a.mp4' && o.videos[0].controls === true && o.videos[0].loop === true && o.videos[0].title === '远程演示', JSON.stringify(o.videos[0]));
    check('P3 本地 video 解析为 file://', o.videos[1] && o.videos[1].src.startsWith('file://') && o.videos[1].src.endsWith('/_assets/a.mp4') && o.videos[1].muted === true, JSON.stringify(o.videos[1]));
    check('P4 坏块显示内联错误且不建 video', o.videos.length === 2 && o.errors.some((x) => x.includes('未知属性') && x.includes('javascript')), JSON.stringify(o.errors));
    check('P5 在线失败回退本地并黄条警告', o.fallback.src.startsWith('file://') && o.fallback.warns.some((x) => x.includes('已回退')), JSON.stringify(o.fallback));
    check('P6 检查器桥：okf 发现 VIDEO-* 且客户端面板可见', o.check && o.check.counts && o.check.counts.warns >= 2 && o.check.rows.some((x) => x.includes('VIDEO-BAD-SCHEME')) && o.check.rows.some((x) => x.includes('VIDEO-UNKNOWN-KEY')), JSON.stringify(o.check));
    check('P7 越界与符号链接逃逸被拒', o.asset.escape.ok === false && o.asset.escape.error === 'ASSET-OUTSIDE' && o.asset.symlink.ok === false && o.asset.symlink.error === 'ASSET-OUTSIDE', JSON.stringify(o.asset));
    console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
    process.exit(fail ? 1 : 0);
  });
}
main();
