'use strict';
/**
 * 空目录自动建库的机械验收（独立于真库）：
 *   node test/bootstrap.test.js
 * 覆盖：空目录生成 .okf / save 真提交 / health / 已有 OKF 不改写 / 非空目录不建库。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { KB } = require('../core/kb-core');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function noteText(title) {
  return [
    '---',
    'type: Note',
    'title: ' + title,
    'status: draft',
    'generated:',
    '  by: human:user',
    '  at: "2026-11-26T16:20:00+08:00"',
    'source_checked: false',
    '---',
    '',
    '# ' + title,
    '',
    'hello',
    '',
  ].join('\n');
}

async function main() {
  // 1) 真正空目录：自动生成 .okf、首次提交、保存走 okf commit
  const empty = tmp('kbc-boot-empty-');
  const kb = new KB(empty);
  await kb.load();
  check('空目录 bootstrap.scaffolded', kb.bootstrap && kb.bootstrap.scaffolded === true, JSON.stringify(kb.bootstrap));
  check('空目录 hasOkf', kb.hasOkf());
  for (const rel of ['.okf/okf_commit.py', '.okf/okf', '.okf/config.yaml', '.okf/health.yaml', '.okf/checkers/broken-links/checker.py']) {
    check('生成 ' + rel, fs.existsSync(path.join(empty, rel)));
  }
  check('生成 okf 可执行', (fs.statSync(path.join(empty, '.okf/okf')).mode & 0o111) !== 0);
  const first = kb.save('00-收件箱/第一条.md', noteText('第一条'));
  check('空目录 save 成功', first.ok === true, JSON.stringify(first).slice(0, 500));
  check('空目录 save 真提交', !first.note && !first.uncommitted, JSON.stringify(first).slice(0, 500));
  const log = sh('git', ['log', '--oneline'], empty);
  check('首次提交存在', /初始化 OKF 知识库/.test(log), log.trim().split('\n')[0]);
  check('保存后有提交', /新增 第一条/.test(log), log.trim().split('\n')[0]);
  const health = JSON.parse(sh(path.join(empty, '.okf/okf'), ['health', '--json'], empty));
  check('空目录 health 可跑', health.ok === true, 'errors=' + health.errors + ' warns=' + health.warns);
  const checked = JSON.parse(sh(path.join(empty, '.okf/okf'), ['check', '--json', '00-收件箱/第一条.md'], empty));
  check('空目录 check --json 可跑', checked.ok === true && Array.isArray(checked.findings));

  // 2) 已有 .okf 的库：只打开，不覆盖、不重复初始化
  const before = read(path.join(empty, '.okf/okf_commit.py')) + read(path.join(empty, '.okf/config.yaml'));
  const kb2 = new KB(empty);
  await kb2.load();
  check('已有 OKF 不重复 scaffold', kb2.bootstrap && kb2.bootstrap.scaffolded === false, JSON.stringify(kb2.bootstrap));
  check('已有 OKF 内容不变', read(path.join(empty, '.okf/okf_commit.py')) + read(path.join(empty, '.okf/config.yaml')) === before);

  // 3) 只有 .git 的旧空目录：补建 .okf（此前版本只做 git init 的情况）
  const oldRepo = tmp('kbc-boot-git-');
  sh('git', ['init', '-q'], oldRepo);
  const kb3 = new KB(oldRepo);
  await kb3.load();
  check('仅 .git 的旧空目录补建', kb3.hasOkf() && kb3.bootstrap.scaffolded === true, JSON.stringify(kb3.bootstrap));

  // 4) 非空且无 .okf：只读可编辑，不自动改写，save 返回 NO-OKF
  const nonEmpty = tmp('kbc-boot-nonempty-');
  const userFile = path.join(nonEmpty, '用户文件.md');
  fs.writeFileSync(userFile, '# 用户自己的内容\n\n不要动。\n');
  const kb4 = new KB(nonEmpty);
  await kb4.load();
  check('非空目录不建 .okf', !kb4.hasOkf() && !fs.existsSync(path.join(nonEmpty, '.okf')));
  const noOkf = kb4.save('新笔记.md', noteText('新笔记'));
  check('非空目录 save 降级 NO-OKF', noOkf.ok === true && noOkf.note === 'NO-OKF' && noOkf.uncommitted === true);
  check('非空目录用户文件未删除', fs.existsSync(userFile) && read(userFile) === '# 用户自己的内容\n\n不要动。\n');

  if (failures) {
    console.error('\n[FAIL] ' + failures + ' 项未通过');
    process.exit(1);
  }
  console.log('\n[PASS] bootstrap 全部通过');
}

main().catch((err) => { console.error(err && (err.stack || err.message) || err); process.exit(1); });
