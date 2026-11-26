'use strict';
/**
 * kb-core 的机械验收（§3 A4–A12）。用法：node test/kb-core.test.js <case>
 * case ∈ tree|complete|links|backlinks|search|save|rename|all
 * 读写类用例自动建沙箱 /tmp/kbc-sandbox-<ts>（真库只读）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { KB } = require('../core/kb-core');

const REAL = require('./_root');
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

function sh(cmd, args, cwd, input) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', input });
}

function makeSandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-sandbox-'));
  fs.cpSync(path.join(REAL, '.okf'), path.join(sb, '.okf'), { recursive: true });
  fs.mkdirSync(path.join(sb, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'notes', 'plain.md'), '# 无头草稿\n\n正文一行。\n');
  fs.writeFileSync(path.join(sb, 'notes', 'linked.md'), '---\ntype: Note\ntitle: 被链接的\nstatus: stable\ngenerated:\n  by: process:kb\n  at: "2026-01-01T00:00:00+08:00"\nsource_checked: false\n---\n\n# 被链接的\n');
  fs.writeFileSync(path.join(sb, 'notes', 'ref.md'), '---\ntype: Note\ntitle: 引用者\nstatus: stable\ngenerated:\n  by: process:kb\n  at: "2026-01-01T00:00:00+08:00"\nsource_checked: false\n---\n\n见 [被链接的](linked.md) 与 [[linked]]。\n');
  sh('git', ['init', '-q', '.'], sb);
  sh('git', ['config', 'core.quotepath', 'false'], sb);
  sh('git', ['config', 'user.email', 'test@local'], sb);
  sh('git', ['config', 'user.name', 'test'], sb);
  sh('git', ['add', '-A'], sb);
  sh('git', ['commit', '-qm', 'base'], sb);
  return sb;
}

async function main() {
  const which = process.argv[2] || 'all';
  const want = (c) => which === 'all' || which === c;

  if (want('tree')) {
    const kb = await new KB(REAL).load();
    const statusJson = JSON.parse(sh(path.join(REAL, '.okf', 'okf'), ['status', '--json'], REAL));
    check('A4 tree 条目数 = status.total', kb.docs.length === statusJson.total, 'docs=' + kb.docs.length + ' total=' + statusJson.total);
    check('A4 每项含 path/title/type/status', kb.docs.every((d) => d.path && d.title && 'type' in d && 'status' in d));
  }

  if (want('complete')) {
    const kb = await new KB(REAL).load();
    const tags = new Set(kb.docs.flatMap((d) => d.tags.map(String)));
    const sug = kb.completeTag('a');
    check('A5 completeTag 只出库内 tag', sug.length > 0 && sug.every((t) => tags.has(t)), 'n=' + sug.length);
    const fields = kb.completeField();
    const canon = kb.canon().canonical_order;
    check('A5 completeField = canonical_order', JSON.stringify(fields) === JSON.stringify(canon), canon.join(','));
    const types = kb.completeType();
    const seen = new Set(kb.docs.map((d) => d.type).filter(Boolean));
    check('A5 completeType 全部在库内出现过', types.length > 0 && types.every((t) => seen.has(t)), types.join(','));
  }

  if (want('links')) {
    const kb = await new KB(REAL).load();
    const cand = kb.completeLink('30');
    check('A6 completeLink 指向真实文件', cand.length > 0 && cand.every((c) => fs.existsSync(path.join(REAL, c.path))), 'n=' + cand.length);
  }

  if (want('backlinks')) {
    const kb = await new KB(REAL).load();
    const target = '30-Agent工程/30.7-多Agent并行协作/superagent-prototype/docs/001-domain.md';
    const bl = kb.backlinks(target);
    check('A7 001-domain.md 反链 ≥ 7', bl.length >= 7, 'n=' + bl.length);
    check('A7 每条源文件存在', bl.every((b) => fs.existsSync(path.join(REAL, b.path))));
  }

  if (want('search')) {
    const kb = await new KB(REAL).load();
    const auth = require('../core/identity').resolve();
    if (auth.ok) kb.setAuth(auth);
    const r = await kb.search('OKF', { limit: 3 });
    check('A8 search 命中 ≥ 1 且字段齐', r.ok && r.hits.length >= 1 && r.hits.every((h) => h.path && h.title && 'score' in h && 'snippet' in h), 'source=' + r.source);
  }

  if (want('save') || which === 'all') {
    const sb = makeSandbox();
    const kb = new KB(sb); await kb.load();
    const before = sh('git', ['rev-list', '--count', 'HEAD'], sb).trim();
    const r = kb.save('notes/plain.md', '# 无头草稿\n\n正文一行，保存后应自动补头部并入库。\n');
    check('A10 保存成功', r.ok, JSON.stringify(r).slice(0, 160));
    const after = sh('git', ['rev-list', '--count', 'HEAD'], sb).trim();
    check('A10 多出一条 commit', Number(after) === Number(before) + 1, before + ' -> ' + after);
    const dirty = sh('git', ['status', '--porcelain'], sb).trim();
    check('A10 工作区对该文件干净', dirty === '', JSON.stringify(dirty));
    const disk = fs.readFileSync(path.join(sb, 'notes', 'plain.md'), 'utf8');
    check('A15 磁盘已补 frontmatter', /^---\ntype:/.test(disk) && disk.includes('human:user'), disk.split('\n').slice(0, 3).join(' | '));

    const original = fs.readFileSync(path.join(sb, 'notes', 'ref.md'));
    const shaBefore = require('node:crypto').createHash('sha256').update(original).digest('hex');
    const bad = kb.save('notes/ref.md', '---\ntype: [未闭合\n---\n\n坏头部\n');
    const shaAfter = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(sb, 'notes', 'ref.md'))).digest('hex');
    check('A11 lint 拒绝且文件逐字节不变', !bad.ok && bad.error === 'LINT-REJECT' && shaBefore === shaAfter, bad.error || '');
    const cnt = sh('git', ['rev-list', '--count', 'HEAD'], sb).trim();
    check('A11 失败不产生 commit', Number(cnt) === Number(after), cnt);

    const mt = fs.statSync(path.join(sb, 'notes', 'plain.md')).mtimeMs - 5000;
    const conflict = kb.save('notes/plain.md', '外部改过\n', { expectMtime: mt });
    check('A12 外部已改 -> CONFLICT', !conflict.ok && conflict.error === 'CONFLICT', conflict.error || '');
    fs.rmSync(sb, { recursive: true, force: true });
  }

  if (want('rename') || which === 'all') {
    const sb = makeSandbox();
    const kb = new KB(sb); await kb.load();
    const r = kb.rename('notes/linked.md', 'notes/renamed.md');
    check('A9 改名成功', r.ok, JSON.stringify(r));
    const ref = fs.readFileSync(path.join(sb, 'notes', 'ref.md'), 'utf8');
    check('A9 旧名 0 命中', !/linked\.md|\[\[linked\]\]/.test(ref), ref.split('\n').slice(-3).join(' | '));
    check('A9 新名已写入', ref.includes('renamed'), '');
    const lint = execFileSync(path.join(sb, '.okf', 'okf'), ['lint', 'notes/ref.md'], { cwd: sb, encoding: 'utf8' });
    check('A9 改链后 lint 通过', true, lint.trim().slice(0, 60));
    fs.rmSync(sb, { recursive: true, force: true });
  }

  console.log(failures === 0 ? 'RESULT PASS' : 'RESULT FAIL(' + failures + ')');
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
