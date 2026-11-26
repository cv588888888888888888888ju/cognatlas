'use strict';
/**
 * 身份与令牌的机械验收（C1/C2/C3/C5/C7）。
 * 沙箱写盘；真库只读。用法：node test/identity.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const APP = path.resolve(__dirname, '..');
const CLI = path.join(APP, 'core', 'cli.js');
const REAL = require('./_root');
let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) fail++;
}
function runCli(args, env) {
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-ident-'));
  const store = path.join(tmp, 'store');
  const cfg = path.join(tmp, 'cfg');
  fs.mkdirSync(store); fs.mkdirSync(cfg);
  const baseEnv = { ...process.env, KB_TOKEN_DIR: store, XDG_CONFIG_HOME: cfg, KB_ROOT: REAL };

  // C1/C2：签发、落盘、whoami、列表不显示明文
  const created = runCli(['token', 'new', '--name', 'me', '--save'], baseEnv);
  const token = created.out.trim().split('\n')[0];
  check('C1 token 只打印一次且形如 kbt_', created.rc === 0 && /^kbt_[0-9a-f]{32}$/.test(token), token.slice(0, 10) + '...');
  const tokenFile = path.join(cfg, 'kb', 'token');
  const perms = (fs.statSync(tokenFile).mode & 0o777).toString(8);
  const db = JSON.parse(fs.readFileSync(path.join(store, 'tokens.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(store, 'tokens.json'), 'utf8');
  check('C1 存储 0600 且不含明文', perms === '600' && !raw.includes('kbt_') && db.tokens.length === 1, 'perms=' + perms);
  const who = runCli(['whoami'], baseEnv);
  check('C2 whoami 解析 human:user', who.rc === 0 && who.out.includes('human:user'), who.out.trim());

  // C3：无令牌 / 非法令牌
  const noTokCfg = path.join(tmp, 'empty'); fs.mkdirSync(noTokCfg);
  const noTok = runCli(['whoami'], { ...baseEnv, XDG_CONFIG_HOME: noTokCfg, KB_TOKEN: '', KB_TOKEN_DIR: store });
  check('C3 无令牌直接拒绝', noTok.rc === 2 && noTok.out.includes('AUTH-NEEDED'), 'rc=' + noTok.rc);
  const bad = runCli(['whoami'], { ...baseEnv, KB_TOKEN: 'kbt_deadbeef' });
  check('C3 非法令牌 AUTH-INVALID', bad.rc === 2 && bad.out.includes('AUTH-INVALID'), 'rc=' + bad.rc);

  // 吊销
  const rev = runCli(['token', 'revoke', 'me'], baseEnv);
  const after = runCli(['whoami'], baseEnv);
  check('C2 吊销后失效', rev.rc === 0 && after.rc === 2 && after.out.includes('AUTH-INVALID'), 'rc=' + after.rc);

  // C5：agent 身份落到 git author
  const fix = path.join(tmp, 'vault');
  fs.mkdirSync(fix);
  fs.cpSync(path.join(REAL, '.okf'), path.join(fix, '.okf'), { recursive: true });
  fs.chmodSync(path.join(fix, '.okf', 'okf'), 0o755);
  fs.mkdirSync(path.join(fix, '00-收件箱'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: fix });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: fix });
  execFileSync('git', ['config', 'user.email', 't@local'], { cwd: fix });
  const agent = runCli(['token', 'new', '--name', 'dsh', '--runtime', 'deepseekharness', '--session', 's1'], baseEnv).out.trim().split('\n')[0];
  const note = ['---', 'type: Note', 'title: 身份测试', 'status: draft', 'generated:',
    '  by: agent:deepseekharness:s1', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false',
    '---', '', '# 身份测试', ''].join('\n');
  const r = execFileSync('node', [CLI, 'save', '00-收件箱/身份测试.md'], {
    input: note, encoding: 'utf8',
    env: { ...baseEnv, KB_ROOT: fix, KB_TOKEN: agent },
  });
  const author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: fix, encoding: 'utf8' }).trim();
  check('C5 git author = agent 身份', author === 'agent:deepseekharness:s1', author + ' / ' + r.trim());

  // C7：客户端身份与提交者显示
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const evalSrc = "const t=window.__kbTest; await t.openDoc('00-收件箱/身份测试.md'); await new Promise(r=>setTimeout(r,300)); const before=t.committer(); t.typeText('\\n\\n<!-- C6 -->'); const saved=await t.save(); await new Promise(r=>setTimeout(r,300)); return {identity:t.identity(), committer:before, after:t.committer(), saved:saved&&saved.ok};";
  const res = await new Promise((resolve) => {
    const ch = spawn(path.join(APP, 'node_modules', '.bin', 'electron'),
      ['.', '--headless', '--disable-gpu', '--no-sandbox'], {
        cwd: APP, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_DATA_HOME: path.join(home, '.local', 'share'), KB_ROOT: fix, KB_NO_GUESS: '1',
          DISPLAY: ':99', KB_EVAL: evalSrc, KB_EVAL_WAIT: '900', KB_EVAL_TIMEOUT: '20000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { ch.kill('SIGKILL'); resolve({ out, timeout: true }); }, 60000);
    ch.on('exit', () => { clearTimeout(timer); resolve({ out }); });
  });
  const m = /EVAL_RESULT (\{.*\})/.exec(res.out);
  let ev = null;
  try { ev = m ? JSON.parse(m[1]) : null; } catch (e) {}
  check('C7 客户端 human:user 且显示最后提交者',
    !!ev && ev.identity === 'human:user' && /agent:deepseekharness:s1/.test(ev.committer || '') && /human:user/.test(ev.after || ''),
    ev ? ev.identity + ' / 保存前 ' + ev.committer + ' / 保存后 ' + ev.after : 'no EVAL_RESULT');

  // C4：客户端首启自动签发 human:user 令牌（0600）
  const cliTokFile = path.join(home, '.config', 'cognatlas', 'token');
  let tokPerms = '';
  try { tokPerms = (fs.statSync(cliTokFile).mode & 0o777).toString(8); } catch (e) {}
  const clientStore = path.join(home, '.local', 'share', 'kb-service', 'tokens.json');
  let storeOk = false;
  try { storeOk = JSON.parse(fs.readFileSync(clientStore, 'utf8')).tokens.some((t) => t.identity === 'human:user'); } catch (e) {}
  check('C4 客户端自动签发 human:user 令牌', tokPerms === '600' && storeOk, 'perms=' + tokPerms + ' store=' + storeOk);

  // C6：客户端保存的作者 = human:user
  const c6Author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: fix, encoding: 'utf8' }).trim();
  const c6Msg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: fix, encoding: 'utf8' }).trim();
  check('C6 客户端保存 git author = human:user', c6Author === 'human:user' && !!ev && ev.saved === true, c6Author + ' / ' + c6Msg);

  console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
