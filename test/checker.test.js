'use strict';
/** 检查器插件的机械验收（C8–C12）。沙箱副本，真库只读。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = path.resolve(__dirname, '..');
const REAL = require('./_root');
let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) fail++;
}
function sh(cmd, args, cwd, input) {
  try { return { rc: 0, out: execFileSync(cmd, args, { cwd, input, encoding: 'utf8' }) }; }
  catch (e) { return { rc: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}
function writeNote(fix, rel, opts = {}) {
  const lines = ['---', 'type: Note', 'title: ' + (opts.title || '检查器测试'), 'status: draft', 'generated:',
    '  by: human:user', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false'];
  if (opts.stale) lines.push('stale_after: 2020-01-01');
  lines.push('---', '', '# ' + (opts.title || '检查器测试'), '');
  if (opts.body) lines.push(opts.body);
  fs.mkdirSync(path.dirname(path.join(fix, rel)), { recursive: true });
  fs.writeFileSync(path.join(fix, rel), lines.join('\n') + '\n');
}

function main() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-chk-'));
  fs.cpSync(path.join(REAL, '.okf'), path.join(fix, '.okf'), { recursive: true });
  fs.chmodSync(path.join(fix, '.okf', 'okf'), 0o755);
  sh('git', ['init', '-q'], fix);
  sh('git', ['config', 'user.name', 'test'], fix);
  sh('git', ['config', 'user.email', 't@local'], fix);
  sh('git', ['add', '-A'], fix);
  sh('git', ['commit', '-qm', 'base'], fix);
  const okf = path.join(fix, '.okf', 'okf_commit.py');

  writeNote(fix, 'notes/bad.md', { body: '- [[根本不存在的文档]]\n- [缺失](notes/nope.md)\n', stale: true });
  const chk = sh('python3', [okf, 'check', '--json', 'notes/bad.md'], fix);
  let res = null;
  try { res = JSON.parse(chk.out); } catch (e) {}
  check('C8 发现 LINK-MISSING 与 STALE-DOC',
    chk.rc === 0 && res && res.findings.some((f) => f.code === 'LINK-MISSING') && res.findings.some((f) => f.code === 'STALE-DOC'),
    res ? res.counts.errors + ' error / ' + res.counts.warns + ' warn' : chk.out.slice(0, 120));
  const strict = sh('python3', [okf, 'check', '--strict', 'notes/bad.md'], fix);
  check('C11 --strict 把 warning 变为非零', strict.rc === 1, 'rc=' + strict.rc);

  // gate=warn 放行
  let before = sh('git', ['rev-list', '--count', 'HEAD'], fix).out.trim();
  const warnCommit = sh('python3', [okf, 'commit', '--by', 'human:user', '--no-source-checked', '-m', 'warn', 'notes/bad.md'], fix);
  let after = sh('git', ['rev-list', '--count', 'HEAD'], fix).out.trim();
  check('C10 warn 门禁提交成功', warnCommit.rc === 0 && Number(after) === Number(before) + 1, before + ' -> ' + after);

  // gate=block + error 插件 => 阻断且不新增 commit
  fs.mkdirSync(path.join(fix, '.okf', 'checkers', 'boom'), { recursive: true });
  fs.writeFileSync(path.join(fix, '.okf', 'checkers', 'boom', 'checker.py'),
    'NAME="boom"\nDEFAULT_LEVEL="error"\ndef check(ctx):\n    return [{"level":"error","code":"BOOM","message":"强制错误"}]\n');
  const cfgPath = path.join(fix, '.okf', 'config.yaml');
  let cfg = fs.readFileSync(cfgPath, 'utf8').replace('gate: warn', 'gate: block');
  fs.writeFileSync(cfgPath, cfg);
  writeNote(fix, 'notes/block.md', { title: '阻断测试' });
  before = sh('git', ['rev-list', '--count', 'HEAD'], fix).out.trim();
  const block = sh('python3', [okf, 'commit', '--by', 'human:user', '--no-source-checked', '-m', 'block', 'notes/block.md'], fix);
  after = sh('git', ['rev-list', '--count', 'HEAD'], fix).out.trim();
  check('C10 block 门禁拒绝提交', block.rc === 1 && before === after && block.out.includes('检查器未通过'), 'rc=' + block.rc);

  fs.rmSync(path.join(fix, '.okf', 'checkers', 'boom'), { recursive: true, force: true });

  // 崩溃 / 超时隔离
  fs.mkdirSync(path.join(fix, '.okf', 'checkers', 'crash'), { recursive: true });
  fs.writeFileSync(path.join(fix, '.okf', 'checkers', 'crash', 'checker.py'),
    'NAME="crash"\ndef check(ctx):\n    raise RuntimeError("boom-crash")\n');
  fs.mkdirSync(path.join(fix, '.okf', 'checkers', 'slow'), { recursive: true });
  fs.writeFileSync(path.join(fix, '.okf', 'checkers', 'slow', 'checker.py'),
    'import time\nNAME="slow"\ndef check(ctx):\n    time.sleep(10)\n    return []\n');
  cfg = fs.readFileSync(cfgPath, 'utf8').replace('timeout_seconds: 5', 'timeout_seconds: 1');
  fs.writeFileSync(cfgPath, cfg);
  const iso = sh('timeout', ['30', 'python3', okf, 'check', 'notes/bad.md'], fix);
  check('C9 崩溃/超时记 CHECKER-ERROR 且不中断',
    iso.rc === 0 && iso.out.includes('CHECKER-ERROR') && iso.out.includes('boom-crash') && iso.out.includes('超时'),
    'rc=' + iso.rc);
  fs.rmSync(path.join(fix, '.okf', 'checkers', 'crash'), { recursive: true, force: true });
  fs.rmSync(path.join(fix, '.okf', 'checkers', 'slow'), { recursive: true, force: true });

  // 关闭 checkers 后格式门禁仍在
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace('checkers:\n  enabled: true', 'checkers:\n  enabled: false'));
  fs.writeFileSync(path.join(fix, 'notes/badyaml.md'), '---\ntype: [未闭合\n---\n\n# 坏 YAML\n');
  const gate = sh('python3', [okf, 'commit', '--by', 'human:user', '--no-source-checked', '-m', 'badyaml', 'notes/badyaml.md'], fix);
  check('C12 关闭 checkers 后格式门禁仍拒绝', gate.rc !== 0, 'rc=' + gate.rc);

  console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
  process.exit(fail ? 1 : 0);
}
main();
