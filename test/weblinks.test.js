'use strict';
/**
 * 外链安全与快照回退验收（W1–W8）。
 * 沙箱写盘；真库只读；Electron 固定 DISPLAY=:99。
 * 用法：node test/weblinks.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const APP = path.resolve(__dirname, '..');
const REAL = require('./_root');
let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) fail++;
}
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

function runEval(env, src) {
  return new Promise((resolve) => {
    const ch = spawn(path.join(APP, 'node_modules', '.bin', 'electron'),
      ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
        cwd: APP,
        env: { ...process.env, ...env, DISPLAY: ':99', KB_EVAL: src, KB_EVAL_WAIT: '900', KB_EVAL_TIMEOUT: '35000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { ch.kill('SIGKILL'); resolve({ out, timeout: true }); }, 90000);
    ch.on('exit', () => { clearTimeout(timer); resolve({ out }); });
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-weblinks-'));
  const vault = path.join(tmp, 'vault');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(vault, '00-收件箱'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(path.join(REAL, '.okf'), path.join(vault, '.okf'), { recursive: true });
  git(['init', '-q'], vault);
  git(['config', 'core.quotepath', 'false'], vault);
  git(['config', 'user.name', 'test'], vault);
  git(['config', 'user.email', 't@local'], vault);
  const doc = [
    '---', 'type: Note', 'title: 链接', 'status: stable', 'generated:',
    '  by: human:user', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', '---', '',
    '# 链接', '',
    '[网页](https://example.com/a?b=1)', '[邮件](mailto:a@b.c)', '[文件](file:///etc/passwd)',
    '[脚本](javascript:alert(1))', '[数据](data:text/html,<script>alert(1)</script>)',
    '[未知](ftp://example.com/x)', '[相对](00-收件箱/链接.md)', ''
  ].join('\n');
  fs.writeFileSync(path.join(vault, '00-收件箱', '链接.md'), doc);

  const server = http.createServer((req, res) => {
    const u = req.url || '/';
    if (u === '/popup.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>POPUP</title></head><body><script>window.open("https://example.com/x")</script></body></html>');
    } else if (u === '/nav.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>NAV</title></head><body><script>setTimeout(function(){location.href="file:///etc/passwd"},100)</script></body></html>');
    } else if (u === '/safe.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>SAFE</title></head><body>safe</body></html>');
    } else { res.writeHead(404); res.end('no'); }
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;
    const offline = 'http://127.0.0.1:9/offline';
    const src = [
      'const t=window.__kbTest;',
      'await t.openDoc("00-收件箱/链接.md");',
      'const rel=t.currentRel();',
      'const out={peeks:{},norm:[],open:{},popup:{},nav:{},snap:{},csp:{},quota:{},auto:{}};',
      'for (const u of ["https://example.com/a?b=1","mailto:a@b.c","file:///etc/passwd","javascript:alert(1)","data:text/html,<script>alert(1)</script>","ftp://example.com/x"]) {',
      '  const r=await window.kb.peek(u,rel); out.peeks[u]={kind:r&&r.kind,reason:r&&r.reason,scheme:r&&r.scheme,target:r&&r.target};',
      '}',
      'for (const u of ["javascript:alert(1)","file:///etc/passwd","data:text/html,x","https://a.com/x","a.com/x"]) out.norm.push([u,t.normalizeWebUrl(u)]);',
      'out.open.file=await window.kb.openExternal("file:///etc/passwd");',
      'out.open.js=await window.kb.openExternal("javascript:alert(1)");',
      't.openWeb(' + JSON.stringify(base + '/popup.html') + '); await new Promise(r=>setTimeout(r,1600));',
      'out.popup={windows:await window.kb.windowCount(),state:t.webState(),title:t.webTitle()};',
      't.openWeb(' + JSON.stringify(base + '/nav.html') + '); await new Promise(r=>setTimeout(r,1600));',
      'out.nav={windows:await window.kb.windowCount(),state:t.webState(),title:t.webTitle()};',
      'const u=' + JSON.stringify(offline) + ';',
      'await window.kb.snapSave({url:u,title:"OFF",html:"<html><head><title>OFFTITLE</title></head><body>snap</body></html>"});',
      't.openWeb(u); await new Promise(r=>setTimeout(r,2200));',
      'out.snap={state:t.webState(),title:t.webTitle()};',
      'const s2=await window.kb.snapSave({url:"http://x/pwn",title:"PWN",html:"<html><head><title>SAFE</title></head><body><script>document.title=1</script><img src=x onerror=document.title=2></body></html>"});',
      'const g=await window.kb.snapGet(s2.meta.id); out.csp.saved=(g&&g.html)||"";',
      'await t.openSnapshot(s2.meta.id); await new Promise(r=>setTimeout(r,900)); out.csp.title=t.webTitle();',
      'out.quota.badGet=await window.kb.snapGet("../../etc/passwd"); out.quota.badUrl=await window.kb.snapUrl("../../etc/passwd");',
      'const big=await window.kb.snapSave({url:"http://x/big",title:"BIG",html:"<p>"+"a".repeat(6*1024*1024)+"</p>"});',
      'out.quota.big=!!(big&&big.ok); out.quota.truncated=!!(big&&big.ok&&big.meta.bytes.truncated);',
      'const u2=' + JSON.stringify(base + '/safe.html') + '; t.openWeb(u2); await new Promise(r=>setTimeout(r,3200));',
      'out.auto.count=(await window.kb.snapList(u2)).length; out.auto.fallback=t.webState().fallback;',
      'return out;'
    ].join('\n');

    runEval({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), KB_ROOT: vault, KB_NO_GUESS: '1' }, src).then((res) => {
      server.close();
      const m = /EVAL_RESULT (\{[\s\S]*\})/.exec(res.out);
      let o = null;
      try { o = m ? JSON.parse(m[1]) : null; } catch (e) {}
      check('EVAL 返回结果', !!o, o ? '' : res.out.slice(-300));
      if (!o) { console.log('\nRESULT FAIL(1)'); process.exit(1); }
      check('W1 file: 被拒', o.peeks['file:///etc/passwd'].kind === 'blocked' && o.peeks['file:///etc/passwd'].reason === 'FILE-LINK');
      check('W1 javascript: 被拒', o.peeks['javascript:alert(1)'].kind === 'blocked' && o.peeks['javascript:alert(1)'].reason === 'BAD-SCHEME');
      check('W1 data: 被拒', o.peeks['data:text/html,<script>alert(1)</script>'].kind === 'blocked');
      check('W1 ftp: 明确不支持', o.peeks['ftp://example.com/x'].reason === 'UNSUPPORTED-SCHEME');
      check('W1 https/mailto 仍可用', o.peeks['https://example.com/a?b=1'].kind === 'external' && o.peeks['mailto:a@b.c'].scheme === 'mail');
      check('W2 地址栏只接受 http/https', o.norm[0][1] === null && o.norm[1][1] === null && o.norm[2][1] === null && o.norm[3][1] === 'https://a.com/x' && o.norm[4][1] === 'https://a.com/x', JSON.stringify(o.norm));
      check('W2 openExternal 拒绝 file/js', o.open.file.error === 'SCHEME-NOT-ALLOWED' && o.open.js.error === 'SCHEME-NOT-ALLOWED');
      check('W3 window.open 不开新窗', o.popup.windows === 1 && o.popup.state.url.endsWith('/popup.html'));
      check('W3 导航到 file:// 被拦', o.nav.state.url.endsWith('/nav.html'), o.nav.state.url);
      check('W5 在线失败自动回退快照', o.snap.state.url.startsWith('file://') && /离线快照/.test(o.snap.state.fallback) && o.snap.title === 'OFFTITLE', JSON.stringify(o.snap));
      check('W6 快照 CSP 且脚本不执行', o.csp.saved.includes('Content-Security-Policy') && !/<script/i.test(o.csp.saved) && o.csp.title === 'SAFE', o.csp.title);
      check('W6 路径穿越被拒', o.quota.badGet === null && o.quota.badUrl.ok === false);
      check('W6 超大页面截断', o.quota.big && o.quota.truncated);
      check('W8 在线页自动快照', o.auto.count >= 1 && o.auto.fallback === '', JSON.stringify(o.auto));
      console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
      process.exit(fail ? 1 : 0);
    });
  });
}
main();
