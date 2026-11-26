'use strict';
/** 插件信任运行时验收（T1–T5）。沙箱写盘；Electron 固定 DISPLAY=:99。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const APP = path.resolve(__dirname, '..');
const REAL = require('./_root');
let fail = 0;
function check(name, cond, detail) { console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : '')); if (!cond) fail++; }
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

function runEval(env, src) {
  return new Promise((resolve) => {
    const ch = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
      cwd: APP, env: { ...process.env, ...env, DISPLAY: ':99', KB_EVAL: src, KB_EVAL_WAIT: '900', KB_EVAL_TIMEOUT: '35000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { ch.kill('SIGKILL'); resolve({ out, timeout: true }); }, 90000);
    ch.on('exit', () => { clearTimeout(timer); resolve({ out }); });
  });
}
function parse(res) { const m = /EVAL_RESULT (\{.*\})/.exec(res.out); try { return m ? JSON.parse(m[1]) : null; } catch (e) { return null; } }

function plugin(dir, name, manifest, code) {
  const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify(manifest, null, 2));
  if (code != null) fs.writeFileSync(path.join(d, 'client.js'), code);
}

const DEMO = [
  '(function(){',
  '  var probe = {kb: typeof window.kb, node: typeof process, ipc: typeof ipcRenderer, req: typeof require};',
  '  kbPlugin.ui.html(\'<div id="demo-hello">hello-plugin</div><pre id="probe">\' + JSON.stringify(probe) + \'</pre>\');',
  '  kbPlugin.ui.css(\'#demo-hello{color:rgb(1, 2, 3)}\');',
  '  kbPlugin.commands.register({id:"ping", title:"Demo Ping"});',
  '  kbPlugin.commands.register({id:"css", title:"Demo CSS"});',
  '  kbPlugin.commands.register({id:"nav", title:"Demo Nav"});',
  '  kbPlugin.commands.register({id:"navfile", title:"Demo NavFile"});',
  '  kbPlugin.on(async function(e){',
  '    if (!e || e.type !== "command") return;',
  '    if (e.id === "ping") { var t = await kbPlugin.webview.eval("document.title"); kbPlugin.ui.html(\'<div id="demo-hello">cmd:\' + t + \'</div>\'); }',
  '    if (e.id === "css") { await kbPlugin.webview.css("body{background:rgb(1,2,3)}"); kbPlugin.ui.html(\'<div id="demo-css">css-ok</div>\'); }',
  '    if (e.id === "nav") { await kbPlugin.webview.navigate("http://127.0.0.1:PORT/safe.html"); }',
  '    if (e.id === "navfile") { await kbPlugin.webview.navigate("file:///etc/passwd"); }',
  '  });',
  '})();',
].join('\n');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-plugin-rt-'));
  const vault = path.join(tmp, 'vault');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(vault, '00-收件箱'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(path.join(REAL, '.okf'), path.join(vault, '.okf'), { recursive: true });
  fs.chmodSync(path.join(vault, '.okf', 'okf'), 0o755);
  git(['init', '-q'], vault); git(['config', 'core.quotepath', 'false'], vault);
  git(['config', 'user.name', 'test'], vault); git(['config', 'user.email', 't@local'], vault);
  fs.writeFileSync(path.join(vault, '00-收件箱', '插件.md'), ['---', 'type: Note', 'title: 插件', 'status: stable', 'generated:', '  by: human:user', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', '---', '', '# 插件', ''].join('\n'));

  const pdir = path.join(vault, '.okf', 'plugins');
  plugin(pdir, 'demo', { name: 'demo', fence: 'demo', component: 'custom', trusted: true, client: 'client.js', capabilities: ['ui', 'webview', 'commands'] }, '');
  plugin(pdir, 'secret', { name: 'secret', fence: 'secret', component: 'custom', trusted: false, client: 'client.js', capabilities: ['ui'] }, 'kbPlugin.ui.html(\'<div id="secret-ui">secret</div>\');');
  plugin(pdir, 'missing', { name: 'missing', fence: 'missing', component: 'custom', client: 'missing.js' }, null);
  plugin(pdir, 'huge', { name: 'huge', fence: 'huge', component: 'custom', client: 'client.js' }, '/*' + 'x'.repeat(530 * 1024) + '*/');
  plugin(pdir, 'badname', { name: 'badname', fence: 'badname', component: 'custom', client: '../evil.js' }, 'alert(1)');

  const server = http.createServer((req, res) => {
    if ((req.url || '') === '/safe.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>SAFE</title></head><body>safe</body></html>'); }
    else { res.writeHead(404); res.end('no'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const code = DEMO.replace('PORT', String(server.address().port));
  fs.writeFileSync(path.join(pdir, 'demo', 'client.js'), code);

  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), KB_ROOT: vault, KB_NO_GUESS: '1' };
  const src = [
    'const t=window.__kbTest;',
    'await new Promise(r=>setTimeout(r,1200));',
    'const out={plugins:await window.kb.plugins(),rt:t.pluginRuntime()};',
    'out.code={missing:await window.kb.pluginCode("missing"),huge:await window.kb.pluginCode("huge"),secret:await window.kb.pluginCode("secret"),badname:await window.kb.pluginCode("badname")};',
    'out.code.missing=(out.code.missing||{}).error; out.code.huge=(out.code.huge||{}).error; out.code.secret=(out.code.secret||{}).error; out.code.badname=(out.code.badname||{}).error;',
    't.openWeb(' + JSON.stringify(base + '/safe.html') + '); await new Promise(r=>setTimeout(r,1500));',
    't.runCommand("plugin:demo:ping"); await new Promise(r=>setTimeout(r,700)); out.ping=t.pluginRuntime(); out.title=t.webTitle();',
    't.runCommand("plugin:demo:css"); await new Promise(r=>setTimeout(r,700)); out.cssOk=await t.webEval("getComputedStyle(document.body).backgroundColor");',
    't.runCommand("plugin:demo:nav"); await new Promise(r=>setTimeout(r,1200)); out.navUrl=t.webState().url;',
    't.runCommand("plugin:demo:navfile"); await new Promise(r=>setTimeout(r,900)); out.navFileUrl=t.webState().url;',
    'out.uiText=document.getElementById("plugin-ui").textContent;',
    'out.hasSecret=!!document.getElementById("secret-ui");',
    'return out;',
  ].join('\n');
  const res = await runEval(env, src);
  const out = parse(res);
  const names = out ? (out.plugins.plugins || []).map((p) => p.name) : [];
  check('T1 trusted:false 不加载', !!out && out.rt.clients.length === 1 && out.rt.clients[0].name === 'demo' && !out.hasSecret, out ? JSON.stringify(out.rt.clients.map((c) => c.name)) + ' secretUI=' + out.hasSecret : 'no EVAL_RESULT');
  check('T1 全局关闭不加载 client', !!out && out.plugins.client_enabled === true, 'client_enabled=' + (out && out.plugins.client_enabled));
  check('T1 非法 client 名被清单拒绝', !!out && names.includes('demo') && !names.includes('badname'), names.join(','));
  check('T2 缺失/超大 client 不加载且不影响 demo', !!out && out.code.missing === 'CLIENT-MISSING' && out.code.huge === 'CLIENT-TOO-LARGE' && out.rt.clients.length === 1, JSON.stringify(out && out.code));
  check('T3 UI HTML/CSS + 命令注册', !!out && /hello-plugin/.test(out.rt.ui[0] ? out.rt.ui[0].html : '') && out.rt.commands.some((c) => c.id === 'plugin:demo:ping') && out.rt.css.includes('plugin-css-demo'), out ? out.rt.css.join(',') : '');
  const probe = out && out.rt.ui[0] ? out.rt.ui[0].html : '';
  check('T4 插件拿不到 kb/node/ipc/require', /"kb":"undefined"/.test(probe) && /"node":"undefined"/.test(probe) && /"ipc":"undefined"/.test(probe) && /"req":"undefined"/.test(probe), probe.slice(0, 140));
  check('T5 webview.eval 返回 SAFE', !!out && out.title === 'SAFE' && /cmd:SAFE/.test(out.ping ? out.ping.ui[0].html : ''), out ? out.title : '');
  check('T5 webview.css 生效', !!out && out.cssOk === 'rgb(1, 2, 3)', out && out.cssOk);
  check('T5 navigate 允许 http、拒绝 file', !!out && /safe\.html$/.test(out.navUrl) && /safe\.html$/.test(out.navFileUrl), out ? out.navUrl + ' / ' + out.navFileUrl : '');

  const res2 = await runEval({ ...env, KB_NO_PLUGIN_CLIENT: '1' }, 'const t=window.__kbTest; await new Promise(r=>setTimeout(r,1000)); return {p:await window.kb.plugins(),rt:t.pluginRuntime()};');
  const out2 = parse(res2);
  check('T1 KB_NO_PLUGIN_CLIENT=1 全局关闭', !!out2 && out2.p.client_enabled === false && out2.rt.clients.length === 0 && out2.rt.ui.length === 0, out2 ? 'clients=' + out2.rt.clients.length + ' ui=' + out2.rt.ui.length : 'no EVAL_RESULT');

  server.close();
  console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });