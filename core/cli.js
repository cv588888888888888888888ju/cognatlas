'use strict';
/**
 * kb —— 知识库命令行（身份、令牌与提交消息自动推断）。
 * 契约见 docs/ARCHITECTURE.md 与 README.md。
 */
const path = require('node:path');
const fs = require('node:fs');
const { KB } = require('./kb-core');
const tokens = require('./token-store');
const identity = require('./identity');

function usage() {
  console.log(['kb <命令> [参数]', '',
    '  status                     全库合规概览（转发 okf status）',
    '  tree                       列出库内文档',
    '  new <标题> [--dir D] [--type T]   新建笔记（含 frontmatter 骨架）',
    '  commit [-m 消息] [文件…]    提交（身份自动带上）',
    '  save <相对路径>            以 stdin 为正文保存并入库',
    '  rename <旧路径> <新路径>    改名并自动改全库链接',
    '  search <词|tag:a -tag:b path:x type:Note> [--limit N]    检索（优先 kb-serve）',
    '  whoami [--json]            显示当前 token 解析到的身份',
    '  token new --name NAME [--runtime R] [--session S] [--save]   签发令牌（明文只打印一次）',
    '  token list [--json]        列出令牌（不显示明文）',
    '  token revoke <name|id>     吊销令牌', '',
    '令牌顺序：KB_TOKEN > KB_TOKEN_FILE > ~/.config/kb/token > 客户端 token；缺失直接拒绝。'].join('\n'));
}

function authFail(r) {
  if (r.error === 'AUTH-NEEDED') {
    console.error('AUTH-NEEDED：' + (r.detail || '未找到 token'));
  } else {
    console.error('AUTH-INVALID：token 无效或已吊销');
  }
  return 2;
}

function tokenCmd(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'new') {
    const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
    const name = arg('--name');
    const runtime = arg('--runtime');
    const session = arg('--session');
    if (!name) { console.error('用法：kb token new --name NAME [--runtime R] [--session S] [--save]'); return 2; }
    const r = tokens.createToken({ name, runtime, session });
    if (!r.ok) { console.error(r.error + (r.detail ? '：' + r.detail : '')); return 1; }
    console.log(r.token);
    console.error('身份：' + r.record.identity + '（' + r.record.name + '）');
    if (rest.includes('--save')) {
      identity.saveTokenFile(identity.cliTokenPath(), r.token);
      console.error('已保存到 ' + identity.cliTokenPath());
    }
    return 0;
  }
  const auth = identity.resolve();
  if (!auth.ok) return authFail(auth);
  if (sub === 'list') {
    const list = tokens.listTokens();
    if (rest.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log('（没有令牌）'); return 0; }
    for (const t of list) console.log([t.name, t.identity, t.created_at, t.revoked ? 'revoked' : 'active'].join('\t'));
    return 0;
  }
  if (sub === 'revoke') {
    const key = rest[0];
    if (!key) { console.error('用法：kb token revoke NAME_OR_ID'); return 2; }
    const r = tokens.revokeToken(key);
    if (!r.ok) { console.error('没有找到未吊销的令牌：' + key); return 1; }
    console.log('已吊销 ' + r.revoked + ' 个令牌');
    return 0;
  }
  console.error('未知 token 子命令：' + (sub || ''));
  return 2;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); return 0; }
  if (cmd === 'token') return tokenCmd(rest);

  const auth = identity.resolve();
  if (!auth.ok) return authFail(auth);

  if (cmd === 'whoami') {
    const out = { identity: auth.identity, name: auth.name, source: auth.source, id: auth.id };
    console.log(rest.includes('--json') ? JSON.stringify(out, null, 2) : auth.identity + '（' + auth.name + '，来源 ' + auth.source + '）');
    return 0;
  }

  const kb = new KB(process.env.KB_ROOT || undefined);
  kb.setAuth({ identity: auth.identity, token: auth.token, name: auth.name });

  if (cmd === 'status') {
    const r = kb.runOkf(['status'], { cwd: kb.root });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    return r.code;
  }

  await kb.load();

  if (cmd === 'tree') { console.log(kb.docs.map((d) => d.path).join('\n')); return 0; }

  if (cmd === 'new') {
    const title = rest.filter((a) => !a.startsWith('--'))[0];
    if (!title) { console.error('用法：kb new <标题> [--dir D] [--type T]'); return 2; }
    const di = rest.indexOf('--dir');
    const dir = di >= 0 ? rest[di + 1] : '00-收件箱';
    const ti = rest.indexOf('--type');
    const type = ti >= 0 ? rest[ti + 1] : 'Note';
    const now = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
    const rel = path.posix.join(dir, title + '.md');
    if (fs.existsSync(path.join(kb.root, rel))) { console.error('已存在：' + rel); return 1; }
    const text = ['---', 'type: ' + type, 'title: ' + title, 'status: draft', 'generated:',
                  '  by: ' + auth.identity, '  at: "' + now + '"', 'source_checked: false', '---', '',
                  '# ' + title, '', ''].join('\n');
    const r = kb.save(rel, text, { message: '新增 ' + title });
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    console.log(rel);
    return 0;
  }

  if (cmd === 'commit') {
    const mi = rest.indexOf('-m');
    const message = mi >= 0 ? rest[mi + 1] : null;
    const rels = rest.filter((a, i) => !a.startsWith('-') && i !== mi + 1);
    const r = kb.commit(message, rels.length ? rels : null);
    process.stdout.write(r.detail + '\n');
    return r.ok ? 0 : 1;
  }

  if (cmd === 'save') {
    const rel = rest[0];
    if (!rel) { console.error('用法：kb save <相对路径>（正文从 stdin 读）'); return 2; }
    const text = fs.readFileSync(0, 'utf8');
    const r = kb.save(rel, text);
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    console.log('saved ' + rel);
    return 0;
  }

  if (cmd === 'rename') {
    const [a, b] = rest;
    if (!a || !b) { console.error('用法：kb rename <旧路径> <新路径>'); return 2; }
    const r = kb.rename(a, b);
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }

  if (cmd === 'search') {
    const q = rest.filter((a) => !a.startsWith('--'))[0];
    const li = rest.indexOf('--limit');
    const limit = li >= 0 ? Number(rest[li + 1]) : 10;
    if (!q) { console.error('用法：kb search <词> [--limit N]'); return 2; }
    const r = await kb.searchQuery(q, { limit });
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }

  usage();
  return 2;
}

main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
