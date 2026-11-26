'use strict';
/**
 * kb-core —— 知识库客户端的核心（纯 Node，无 Electron 依赖）。
 * 接口契约见 docs/ARCHITECTURE.md。
 * 设计原则：okf CLI 仍是唯一真相的实现，本模块只做「调用 + 编排」，不复制校验逻辑。
 */
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const IS_WIN = process.platform === 'win32';
const DEFAULT_ROOT = path.join(os.homedir(), 'KnowledgeBase');
/** 内置 OKF 脚手架；只在“空目录”首次打开时复制到 <root>/.okf。 */
const STARTER_DIR = path.join(__dirname, 'okf-starter');

/** 随包运行时目录：Windows 包把 python/ 与 git/ 放在 resources/runtime 下。 */
function runtimeDir() {
  if (process.env.KB_RUNTIME_DIR) return process.env.KB_RUNTIME_DIR;
  if (process.resourcesPath) {
    const d = path.join(process.resourcesPath, 'runtime');
    if (fs.existsSync(d)) return d;
  }
  return null;
}

function runtimePython() {
  const d = runtimeDir();
  if (!d) return null;
  const exe = path.join(d, 'python', 'python.exe');
  return fs.existsSync(exe) ? exe : null;
}

/** 把随包 python 与 git 前置到 PATH（仅 Windows；必须在 spawn git 之前调用）。 */
function prepareRuntimeEnv() {
  if (!IS_WIN) return null;
  const d = runtimeDir();
  if (!d) return null;
  const parts = [path.join(d, 'python'), path.join(d, 'git', 'cmd')].filter((x) => fs.existsSync(x));
  if (parts.length) process.env.PATH = parts.join(';') + ';' + (process.env.PATH || '');
  process.env.KB_RUNTIME_DIR = d;
  return d;
}
prepareRuntimeEnv();

function sameValue(a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); }

/** 从 Markdown 文本里取某个 frontmatter 字段的原始值（列表折成 [a, b]）。 */
function extractFmField(text, field) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + ':');
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) return null;
  const inline = lines[idx].replace(/^[^:]+:\s*/, '').trim();
  if (inline) return inline;
  const items = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const lm = /^\s*-\s+(.*)$/.exec(lines[i]);
    if (!lm) break;
    items.push(lm[1].trim());
  }
  return items.length ? '[' + items.join(', ') + ']' : '';
}

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status == null ? 1 : err.status, stdout: err.stdout || '', stderr: (err.stderr || String(err.message)) };
  }
}

function runPy(script, args, input, python = 'python3') {
  const r = run(python, [script, ...args], { input });
  if (r.code !== 0) throw new Error('python helper failed (' + python + '): ' + r.stderr);
  return r.stdout;
}

class KB {
  constructor(root = DEFAULT_ROOT) {
    this.root = path.resolve(root);
    this.okf = path.join(this.root, '.okf', 'okf');
    this.okfScript = path.join(this.root, '.okf', 'okf_commit.py');
    this.python = process.env.KB_PYTHON || (IS_WIN ? (runtimePython() || 'python') : 'python3');
    // 打包后 core/fm.py 在 app.asar 里，python 读不了虚拟路径 → 用 asar 外置副本
    const inside = path.join(__dirname, 'fm.py');
    this.fmPy = inside.includes('.asar')
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'core', 'fm.py')
      : inside;
    this.docs = [];
    this.byPath = new Map();
    this.identity = 'human:user';
    this.token = null;
    this.identityName = '';
  }

  /** okf 的统一调用方式：POSIX 跑 .okf/okf 脚本；Windows 直接让随包 python 跑 okf_commit.py。 */
  okfCommand(args) {
    return IS_WIN
      ? { cmd: this.python, args: [this.okfScript, ...args] }
      : { cmd: this.okf, args };
  }

  runOkf(args, opts = {}) {
    const inv = this.okfCommand(args);
    return run(inv.cmd, inv.args, { ...opts, env: opts.env || this.gitEnv() });
  }

  /** 身份由调用方注入（CLI 从 token 解析，客户端从首启签发的 token 解析）。 */
  setAuth({ identity, token, name } = {}) {
    if (identity) this.identity = identity;
    this.token = token || null;
    this.identityName = name || '';
    return this;
  }

  gitEnv() {
    const id = this.identity || 'human:user';
    return {
      ...process.env,
      GIT_AUTHOR_NAME: id,
      GIT_AUTHOR_EMAIL: id.replace(/[^A-Za-z0-9._-]+/g, '.') + '@kb.local',
      GIT_COMMITTER_NAME: id,
      GIT_COMMITTER_EMAIL: id.replace(/[^A-Za-z0-9._-]+/g, '.') + '@kb.local',
    };
  }

  /** 当前文档最后一次提交（git 作者 + 时间），供状态栏显示。 */
  lastCommit(rel) {
    const r = run('git', ['log', '-1', '--format=%an%x09%aI%x09%h', '--', rel], { cwd: this.root });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [author, date, sha] = r.stdout.trim().split('\t');
    return { author, date, sha };
  }

  // ---------------------------------------------------------------- 索引
  async load() {
    const ensured = this.ensureRepo();
    if (!ensured.ok) throw new Error(ensured.error + (ensured.detail ? ': ' + ensured.detail : ''));
    this.bootstrap = ensured;
    // git 视野 = 已跟踪 + 未跟踪未忽略（口径同 okf 的 git_scoped_markdown）
    const listed = run('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '*.md'], { cwd: this.root });
    if (listed.code !== 0) throw new Error('git ls-files 失败：' + listed.stderr);
    const others = run('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard', '*.md'], { cwd: this.root });
    const rels = [...new Set([...listed.stdout.split('\0'), ...others.stdout.split('\0')].filter(Boolean))].sort();
    const reserved = new Set((this.canon().reserved_filenames || []).map((x) => String(x).toLowerCase()));
    this.docs = [];
    this.byPath.clear();
    this.reservedDocs = [];      // 保留名文件（readme/index/log/skill）：不进树，但它们的链接仍算反链
    for (const rel of rels) {
      const isReserved = reserved.has(path.posix.basename(rel).toLowerCase());   // 口径同 okf 的 reserved_filenames
      const abs = path.join(this.root, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }        // 索引里有、工作区已删：跳过（同 ghost 口径）
      if (!st.isFile()) continue;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      let data = null, body = text;
      try {
        const parsed = JSON.parse(runPy(this.fmPy, ['parse'], text, this.python));
        data = parsed.data; body = parsed.body;
      } catch { /* 解析失败就当无头部 */ }
      const d = {
        path: rel,
        title: (data && typeof data.title === 'string' && data.title) || firstHeading(body) || path.basename(rel, '.md'),
        type: data ? data.type : null,
        status: data ? data.status : null,
        tags: data ? asList(data.tags) : [],
        stale_after: data ? data.stale_after : null,
        mtime: st.mtimeMs,
        data, body,
      };
      if (isReserved) { this.reservedDocs.push(d); continue; }
      this.docs.push(d);
      this.byPath.set(rel, d);
    }
    return this;
  }

  /** 空目录判定：只有 .git（上一次只初始化过仓库）也算空；有任何用户文件就不动。 */
  isEmptyDir() {
    try {
      return fs.readdirSync(this.root).every((name) => name === '.git');
    } catch {
      return !fs.existsSync(this.root);
    }
  }

  /** 把内置 OKF 脚手架复制到 <root>/.okf；先写临时目录再改名，失败不留下半个 .okf。 */
  installOkfStarter() {
    const dest = path.join(this.root, '.okf');
    if (fs.existsSync(dest)) return { ok: false, error: 'OKF-EXISTS' };
    if (!fs.existsSync(STARTER_DIR)) return { ok: false, error: 'STARTER-MISSING', detail: STARTER_DIR };
    const tmp = path.join(this.root, '.okf.tmp-' + process.pid + '-' + Date.now());
    const copyTree = (src, out) => {
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        fs.mkdirSync(out, { recursive: true });
        for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(out, name));
        return;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, fs.readFileSync(src));
    };
    try {
      fs.mkdirSync(tmp, { recursive: true });
      copyTree(STARTER_DIR, tmp);
      if (!IS_WIN) fs.chmodSync(path.join(tmp, 'okf'), 0o755);
      fs.renameSync(tmp, dest);
      return { ok: true };
    } catch (err) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不掩盖原始错误 */ }
      return { ok: false, error: 'OKF-STARTER-FAILED', detail: String(err && err.message || err) };
    }
  }

  /** 首次建库时把 .okf 提交进 git；失败只记在返回值里，不阻止已经可用的库打开。 */
  commitStarter() {
    const add = run('git', ['add', '--', '.okf'], { cwd: this.root });
    if (add.code !== 0) return { ok: false, error: 'GIT-ADD-FAILED', detail: (add.stdout + add.stderr).trim() };
    const c = run('git', ['commit', '-m', '初始化 OKF 知识库'], { cwd: this.root });
    return c.code === 0
      ? { ok: true }
      : { ok: false, error: 'GIT-COMMIT-FAILED', detail: (c.stdout + c.stderr).trim() };
  }

  /**
   * 打开知识库前的初始化：
   * - 空目录（含只有 .git 的旧空目录）→ 自动生成 .okf 工具链并做首次提交；
   * - 已有 .okf 的库 → 只补 git 配置，绝不动 .okf；
   * - 非空且无 .okf 的目录 → 保持原行为（git init / 可读可编辑，保存降级 NO-OKF）。
   */
  ensureRepo() {
    const rootExists = fs.existsSync(this.root);
    const empty = !rootExists || this.isEmptyDir();
    if (!rootExists) fs.mkdirSync(this.root, { recursive: true });

    let scaffolded = false;
    if (empty && !fs.existsSync(path.join(this.root, '.okf'))) {
      const starter = this.installOkfStarter();
      if (!starter.ok) return starter;
      scaffolded = true;
    }

    const has = run('git', ['rev-parse', '--git-dir'], { cwd: this.root });
    let created = false;
    if (has.code !== 0) {
      const init = run('git', ['init', '-q'], { cwd: this.root });
      if (init.code !== 0) return { ok: false, error: 'GIT-INIT-FAILED', detail: (init.stdout + init.stderr).trim() };
      created = true;
    }
    run('git', ['config', 'core.quotepath', 'false'], { cwd: this.root });
    if (IS_WIN) {
      // MinGit 的系统配置默认 core.autocrlf=true，会把 LF 文档签成 CRLF，导致保存后整篇“被改动”
      run('git', ['config', 'core.autocrlf', 'false'], { cwd: this.root });
      run('git', ['config', 'core.safecrlf', 'false'], { cwd: this.root });
    }
    if (run('git', ['config', 'user.name'], { cwd: this.root }).code !== 0) run('git', ['config', 'user.name', 'cognatlas'], { cwd: this.root });
    if (run('git', ['config', 'user.email'], { cwd: this.root }).code !== 0) run('git', ['config', 'user.email', 'cognatlas@localhost'], { cwd: this.root });

    const initialCommit = scaffolded ? this.commitStarter() : null;
    return { ok: true, created, scaffolded, initialCommit };
  }

  hasOkf() { return fs.existsSync(IS_WIN ? this.okfScript : this.okf); }

  tree() {
    const root = { name: '', dirs: new Map(), files: [] };
    for (const d of this.docs) {
      const parts = d.path.split('/');
      let node = root;
      for (const p of parts.slice(0, -1)) {
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      }
      node.files.push({ path: d.path, title: d.title, type: d.type, status: d.status, tags: d.tags });
    }
    const conv = (n) => ({
      name: n.name,
      dirs: [...n.dirs.values()].map(conv).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      files: n.files.sort((a, b) => a.path.localeCompare(b.path, 'zh')),
    });
    return conv(root);
  }

  // ---------------------------------------------------------------- 补全
  vocab() {
    const tags = new Set(), types = new Set(), statuses = new Set();
    for (const d of this.docs) {
      for (const t of d.tags) tags.add(String(t));
      if (d.type) types.add(String(d.type));
      if (d.status) statuses.add(String(d.status));
    }
    return { tags: [...tags].sort(), types: [...types].sort(), statuses: [...statuses].sort() };
  }

  canon() {
    const cfgPath = path.join(this.root, '.okf', 'config.yaml');
    if (!fs.existsSync(cfgPath)) return { canonical_order: [], required: [], reserved_filenames: [] };
    try {
      return JSON.parse(runPy(this.fmPy, ['canon', cfgPath], '', this.python));
    } catch {
      return { canonical_order: [], required: [] };
    }
  }

  completeTag(q = '', limit = 20) {
    const ql = q.toLowerCase();
    return this.vocab().tags.filter((t) => t.toLowerCase().includes(ql)).slice(0, limit);
  }

  completeField(q = '') {
    return this.canon().canonical_order.filter((f) => f.includes(q));
  }

  completeType(q = '') {
    return this.vocab().types.filter((t) => t.toLowerCase().includes(q.toLowerCase()));
  }

  completeLink(q = '', limit = 20) {
    const ql = q.toLowerCase();
    return this.docs
      .filter((d) => d.path.toLowerCase().includes(ql) || d.title.toLowerCase().includes(ql))
      .slice(0, limit)
      .map((d) => ({ path: d.path, title: d.title }));
  }

  // ---------------------------------------------------------------- 条目（属性行）：历史 / 标签 / 检索
  setEntryTagsPath(p) { this._entryTagsPath = p; this._entryTags = null; }
  entryTagsPath() {
    return this._entryTagsPath || path.join(process.env.HOME || '/tmp', '.local', 'share', 'cognatlas', 'entry-tags.json');
  }
  _loadEntryTags() {
    if (this._entryTags) return this._entryTags;
    try { this._entryTags = JSON.parse(fs.readFileSync(this.entryTagsPath(), 'utf8')); }
    catch { this._entryTags = {}; }
    return this._entryTags;
  }
  _saveEntryTags() {
    const fp = this.entryTagsPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(this._entryTags || {}, null, 2));
  }
  ownEntryTags(rel, field) {
    const doc = this._loadEntryTags()[rel] || {};
    return Array.isArray(doc[field]) ? doc[field] : [];
  }
  entryTags(rel, field) {
    const d = this.byPath.get(rel);
    return { ok: true, rel, field, inherited: d ? d.tags.map(String) : [], own: this.ownEntryTags(rel, field) };
  }
  setEntryTags(rel, field, tags) {
    const all = this._loadEntryTags();
    const doc = all[rel] || (all[rel] = {});
    const list = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))];
    if (list.length) doc[field] = list; else delete doc[field];
    if (!Object.keys(doc).length) delete all[rel];
    this._entryTags = all;
    this._saveEntryTags();
    return this.entryTags(rel, field);
  }
  propHistory(rel, field, limit = 40) {
    const fmt = '--format=%H%x09%an%x09%aI';
    const lg = run('git', ['-c', 'core.quotepath=false', 'log', '--max-count=' + limit, fmt, '--', rel], { cwd: this.root });
    if (lg.code !== 0) return { ok: false, error: 'GIT-LOG-FAILED', stderr: lg.stderr };
    const rows = [];
    for (const line of lg.stdout.split('\n').filter(Boolean)) {
      const [sha, author, date] = line.split('\t');
      const show = run('git', ['-c', 'core.quotepath=false', 'show', sha + ':' + rel], { cwd: this.root });
      if (show.code !== 0) continue;
      rows.push({ sha, author, date, value: extractFmField(show.stdout, field) });
    }
    const merged = [];
    for (const r of rows) {
      if (merged.length && sameValue(merged[merged.length - 1].value, r.value)) continue;
      merged.push(r);
    }
    return {
      ok: true, rel, field, count: merged.length,
      items: merged.map((it, i) => ({
        sha: it.sha, sha7: it.sha.slice(0, 7), author: it.author, date: it.date, value: it.value,
        prev: i + 1 < merged.length ? merged[i + 1].value : null, changed: i > 0,
      })),
    };
  }
  tagSearch(tag) {
    const t = String(tag || '').replace(/^#/, '').trim().toLowerCase();
    const out = [];
    for (const d of this.docs) {
      const own = this._loadEntryTags()[d.path] || {};
      const ents = Object.keys(own).filter((f) => (own[f] || []).some((x) => String(x).toLowerCase() === t));
      const fileHit = d.tags.some((x) => String(x).toLowerCase() === t);
      if (fileHit || ents.length) out.push({ path: d.path, title: d.title, tags: d.tags.map(String), entries: ents });
    }
    return { ok: true, tag: t, docs: out };
  }

  // ---------------------------------------------------------------- 反链
  linksOut(rel) {
    const d = this.byPath.get(rel);
    if (!d) return [];
    return extractLinks(d.body);
  }

  backlinks(rel) {
    const target = normalizeLinkTarget(rel);
    const out = [];
    for (const d of [...this.docs, ...this.reservedDocs]) {
      if (d.path === rel) continue;
      const hits = extractLinks(d.body).filter((l) => normalizeLinkTarget(l.target) === target
                                             || path.posix.basename(normalizeLinkTarget(l.target)) === path.posix.basename(target));
      if (hits.length) out.push({ path: d.path, title: d.title, count: hits.length });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // ---------------------------------------------------------------- 链接目标解析 + 预览摘要（悬浮/跳转共用）
  // 协议分类：http/https 网页、mailto 邮件、库内路径；其余显式拒绝（file: 只走插件资产通道）
  classifyHref(target) {
    const t = String(target == null ? '' : target).trim();
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(t);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return { kind: 'external', scheme: 'web', url: t };
    if (scheme === 'mailto') return { kind: 'external', scheme: 'mail', url: t };
    if (scheme === 'file') return { kind: 'blocked', reason: 'FILE-LINK', scheme, target: t };
    if (['javascript', 'data', 'vbscript', 'about', 'chrome', 'devtools'].includes(scheme)) {
      return { kind: 'blocked', reason: 'BAD-SCHEME', scheme, target: t };
    }
    return { kind: 'blocked', reason: 'UNSUPPORTED-SCHEME', scheme, target: t };
  }

  resolveLink(target, fromRel) {
    let t = String(target == null ? '' : target).trim();
    if (!t) return null;
    const href = this.classifyHref(t);
    if (href) return href;
    t = t.split('#')[0].trim();
    if (!t) return null;
    const clean = t.replace(/^<|>$/g, '');
    const candidates = [];
    candidates.push(clean.replace(/\\/g, '/'));
    if (fromRel) candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean.replace(/\\/g, '/'))));
    const base = path.posix.basename(clean.replace(/\\/g, '/')).replace(/\.md$/i, '');
    for (const d of this.docs) {
      if (candidates.includes(d.path)) return { kind: 'internal', doc: d };
    }
    for (const d of this.docs) {
      const stem = path.posix.basename(d.path, '.md');
      if (stem === base || d.title === base || (base && (stem.endsWith(base) || d.title.includes(base)))) return { kind: 'internal', doc: d };
    }
    return { kind: 'missing', target: clean };
  }

  resolveAsset(target, fromRel) {
    let t = String(target == null ? '' : target).trim().replace(/^<|>$/g, '');
    if (/^https?:\/\//i.test(t)) return { kind: 'remote', url: t };
    t = t.split('#')[0].trim();
    if (!t) return null;
    let rel = t.replace(/\\/g, '/');
    if (rel.startsWith('/')) rel = rel.replace(/^\/+/, '');
    else rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel || ''), rel));
    const abs = path.join(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return { kind: 'file', abs, rel };
  }

  peek(target, fromRel) {
    const r = this.resolveLink(target, fromRel);
    if (!r) return { ok: false, error: 'EMPTY-TARGET' };
    if (r.kind === 'external') return { ok: true, kind: 'external', scheme: r.scheme, url: r.url, title: r.url, excerpt: '' };
    if (r.kind === 'blocked') {
      const why = {
        'FILE-LINK': '普通链接不允许打开本地文件（本地媒体请用插件块）',
        'BAD-SCHEME': '这个协议被禁止（javascript:/data: 等可执行内容）',
        'UNSUPPORTED-SCHEME': '不支持的链接协议：' + (r.scheme || ''),
      }[r.reason] || r.reason;
      return { ok: true, kind: 'blocked', reason: r.reason, scheme: r.scheme, target: r.target, title: r.target, excerpt: why };
    }
    if (r.kind === 'missing') return { ok: true, kind: 'missing', target: r.target, title: r.target, excerpt: '库里没有找到这个链接目标' };
    const doc = r.doc;
    const plain = String(doc.body || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~\x60>#-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      ok: true, kind: 'internal', path: doc.path, title: doc.title,
      type: doc.type, status: doc.status, stale_after: doc.stale_after,
      excerpt: plain.slice(0, 220), updated: doc.mtime ? new Date(doc.mtime).toISOString().slice(0, 10) : '',
      backlinks: this.backlinks(doc.path).length,
    };
  }

  // ---------------------------------------------------------------- 检索（服务优先，本地兜底）
  // ---------------------------------------------------------------- 检索语法（CLI 与客户端共用）
  // tag:a,b 任一命中即可；重复写 tag:a tag:b 表示同时满足；-tag:x 排除；
  // path:/type:/status: 支持逗号并列；引号包住的是短语；裸 #tag 等价 tag:tag。
  parseQuery(q) {
    const raw = String(q || '');
    const toks = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(raw))) toks.push(m[1] !== undefined ? '\u0000' + m[1] : m[2]);
    const out = { terms: [], tags: [], notTags: [], paths: [], types: [], statuses: [] };
    for (let tk of toks) {
      let phrase = false;
      if (tk.startsWith('\u0000')) { tk = tk.slice(1); phrase = true; }
      let neg = false;
      if (!phrase && tk.startsWith('-') && tk.length > 1) { neg = true; tk = tk.slice(1); }
      const mm = /^(tag|path|type|status):(.*)$/i.exec(tk);
      if (mm && mm[2].trim()) {
        const key = mm[1].toLowerCase();
        const vals = mm[2].split(',').map((x) => x.trim()).filter(Boolean);
        if (key === 'tag') { (neg ? out.notTags : out.tags).push(...vals); continue; }
        if (neg) { out.terms.push('-' + tk); continue; }
        else if (key === 'path') out.paths.push(...vals);
        else if (key === 'type') out.types.push(...vals);
        else out.statuses.push(...vals);
        continue;
      }
      if (!phrase && /^#[^\s#]+$/.test(tk)) { out.tags.push(tk.slice(1)); continue; }
      out.terms.push((neg ? '-' : '') + tk);
    }
    for (const k of ['tags', 'notTags', 'paths', 'types', 'statuses']) out[k] = [...new Set(out[k])];
    return out;
  }

  async searchQuery(q, { limit = 20 } = {}) {
    const p = this.parseQuery(q);
    const text = p.terms.filter((t) => !t.startsWith('-')).join(' ').trim();
    const today = new Date().toISOString().slice(0, 10);
    let hits = [];
    let source = 'local-index';
    if (text) {
      const r = await this.search(text, { limit: Math.max(limit * 5, 50) });
      hits = (r && r.hits) || [];
      source = (r && r.source) || 'local-fallback';
      const neg = p.terms.filter((t) => t.startsWith('-')).map((t) => t.slice(1).toLowerCase()).filter(Boolean);
      if (neg.length) hits = hits.filter((h) => !neg.some((n) => ((h.title || '') + '\n' + (h.snippet || '')).toLowerCase().includes(n)));
    } else {
      hits = this.docs.map((d) => ({
        path: d.path, title: d.title, type: d.type, status: d.status, tags: d.tags,
        stale_after: d.stale_after, mtime: d.mtime, score: 0, snippet: '', warnings: [],
      })).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    }
    const tagMap = this._loadEntryTags();
    const low = (x) => String(x == null ? '' : x).toLowerCase();
    const tagWhere = (rel, t) => {
      const d = this.byPath.get(rel);
      if (d && d.tags.some((x) => low(x) === low(t))) return { where: 'file', field: null };
      const own = tagMap[rel] || {};
      for (const f of Object.keys(own)) if ((own[f] || []).some((x) => low(x) === low(t))) return { where: 'entry', field: f };
      return null;
    };
    const out = [];
    for (const h of hits) {
      const d = this.byPath.get(h.path);
      if (!d) continue;
      if (p.paths.length && !p.paths.some((x) => low(h.path).includes(low(x)))) continue;
      if (p.types.length && !p.types.some((x) => low(d.type) === low(x))) continue;
      if (p.statuses.length && !p.statuses.some((x) => low(d.status) === low(x))) continue;
      const matched = [];
      let ok = true;
      for (const t of p.tags) {
        const w = tagWhere(d.path, t);
        if (!w) { ok = false; break; }
        matched.push({ tag: t, where: w.where, field: w.field });
      }
      if (!ok) continue;
      if (p.notTags.some((t) => tagWhere(d.path, t))) continue;
      const expired = !!(d.stale_after && String(d.stale_after).slice(0, 10) < today);
      out.push({
        ...h, path: d.path, title: d.title || h.title, type: d.type, status: d.status, tags: d.tags,
        stale_after: d.stale_after, expired,
        warnings: expired ? ['expired: stale_after=' + String(d.stale_after).slice(0, 10) + '（该文档已过期，结论需复核）'] : [],
        tagMatches: matched,
      });
      if (out.length >= limit) break;
    }
    return { ok: true, query: q, parsed: p, source, count: out.length, hits: out };
  }

  async search(q, { limit = 10, excludeExpired = false } = {}) {
    const serveBase = process.env.KB_SERVE_URL || 'http://127.0.0.1:18812';
    const remote = await httpJson('POST', serveBase + '/search', { q, limit, exclude_expired: excludeExpired },
      this.token ? { Authorization: 'Bearer ' + this.token } : {});
    if (remote && remote.auth === false) return { ok: false, error: 'AUTH-INVALID', source: 'kb-serve' };
    if (remote && remote.ok) return { ...remote, source: 'kb-serve' };
    const ql = q.toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const hits = [];
    for (const d of this.docs) {
      const idx = (d.body + '\n' + d.title).toLowerCase().indexOf(ql);
      if (idx < 0) continue;
      const expired = !!(d.stale_after && String(d.stale_after).slice(0, 10) < today);
      if (expired && excludeExpired) continue;
      const lo = Math.max(0, idx - 40), hi = Math.min(d.body.length, idx + ql.length + 60);
      hits.push({
        path: d.path, title: d.title, status: d.status, stale_after: d.stale_after, expired,
        score: 0, snippet: d.body.slice(lo, hi).replace(/\s+/g, ' '),
        warnings: expired ? ['expired: stale_after=' + String(d.stale_after).slice(0, 10) + '（该文档已过期，结论需复核）'] : [],
      });
      if (hits.length >= limit) break;
    }
    return { ok: true, query: q, count: hits.length, hits, source: 'local-fallback' };
  }

  // ---------------------------------------------------------------- 写入（保存即入库）
  save(rel, text, { expectMtime = null, message = null } = {}) {
    const abs = path.join(this.root, rel);
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs) : null;
    if (existed && expectMtime && Math.abs(fs.statSync(abs).mtimeMs - expectMtime) > 1) {
      return { ok: false, error: 'CONFLICT', detail: '文件在编辑器外被改过，先重载再保存' };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    if (!this.hasOkf()) {
      // 新库（无 .okf）：文件已落盘，跳过入库校验，不假装提交成功
      return { ok: true, mtime: fs.statSync(abs).mtimeMs, uncommitted: true, note: 'NO-OKF', text: fs.readFileSync(abs, 'utf8') };
    }
    const msg = message || (existed ? '更新 ' : '新增 ') + path.basename(rel, '.md');
    const r = this.runOkf(['commit', '--by', this.identity, '--no-source-checked', '-m', msg, rel], { cwd: this.root });
    if (r.code !== 0) {
      if (before !== null) fs.writeFileSync(abs, before); else fs.rmSync(abs, { force: true });
      return { ok: false, error: 'LINT-REJECT', detail: (r.stdout + r.stderr).trim().slice(0, 2000), code: r.code };
    }
    return { ok: true, mtime: fs.statSync(abs).mtimeMs, stdout: r.stdout.trim(), text: fs.readFileSync(abs, 'utf8') };
  }

  // 变更清单（git status 视角，只取 .md）；commit 不给消息时据此合成
  changedFiles() {
    const r = run('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z'], { cwd: this.root });
    const out = [];
    for (const part of String(r.stdout || '').split('\0')) {
      if (!part) continue;
      const p = part.slice(3).trim();
      if (p.endsWith('.md')) out.push(p);
    }
    return out;
  }

  commit(message = null, rels = null) {
    let msg = message;
    if (!msg) {
      const list = (rels && rels.length) ? rels : this.changedFiles();
      const stems = list.map((x) => path.posix.basename(x, '.md'));
      msg = stems.length === 1 ? '更新 ' + stems[0]
        : stems.length > 1 ? '批量更新 ' + stems.length + ' 篇：' + stems.slice(0, 3).join('、') + (stems.length > 3 ? '…' : '')
          : '知识库同步';
    }
    const args = ['commit', '--by', this.identity, '--no-source-checked', '-m', msg];
    if (rels && rels.length) args.push(...rels);
    const r = this.runOkf(args, { cwd: this.root });
    return { ok: r.code === 0, code: r.code, detail: (r.stdout + r.stderr).trim().slice(0, 2000) };
  }

  // ---------------------------------------------------------------- 改名 + 自动改链
  rename(oldRel, newRel, { message = null } = {}) {
    const oldAbs = path.join(this.root, oldRel), newAbs = path.join(this.root, newRel);
    if (!fs.existsSync(oldAbs)) return { ok: false, error: 'PATH-NOT-FOUND', detail: oldRel };
    if (fs.existsSync(newAbs)) return { ok: false, error: 'TARGET-EXISTS', detail: newRel };
    const touched = new Map();     // rel -> 原文，用于回滚
    const oldStem = path.posix.basename(oldRel, '.md');
    const newStem = path.posix.basename(newRel, '.md');
    for (const d of this.docs) {
      const rewritten = rewriteLinks(d.body, oldRel, newRel, oldStem, newStem, d.path);
      if (rewritten !== d.body) touched.set(d.path, d.body);
    }
    try {
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      fs.renameSync(oldAbs, newAbs);
      for (const [rel, body] of touched) {
        const d = this.byPath.get(rel);
        const abs = path.join(this.root, rel);
        const orig = fs.readFileSync(abs, 'utf8');
        const rewritten = rewriteLinks(orig, oldRel, newRel, oldStem, newStem, rel);
        fs.writeFileSync(abs, rewritten, 'utf8');
        const lint = this.runOkf(['lint', rel], { cwd: this.root });
        if (lint.code !== 0) throw new Error('lint failed on ' + rel + ': ' + (lint.stdout + lint.stderr).slice(0, 500));
      }
      const msg = message || '改名 ' + oldStem + ' -> ' + newStem;
      const files = [newRel, ...touched.keys()];
      const c = this.runOkf(['commit', '--by', this.identity, '--no-source-checked', '-m', msg, ...files], { cwd: this.root });
      if (c.code !== 0) throw new Error('commit failed: ' + (c.stdout + c.stderr).slice(0, 500));
      return { ok: true, renamed: oldRel, to: newRel, relinked: touched.size };
    } catch (err) {
      fs.renameSync(newAbs, oldAbs);
      for (const [rel, body] of touched) fs.writeFileSync(path.join(this.root, rel), body, 'utf8');
      return { ok: false, error: 'RENAME-FAILED', detail: String(err.message) };
    }
  }
}

// ---------------------------------------------------------------- 小工具
function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function firstHeading(body) {
  const m = /^#\s+(.+)$/m.exec(body || '');
  return m ? m[1].trim() : null;
}

function normalizeLinkTarget(t) {
  return String(t || '').trim().replace(/\\/g, '/').replace(/\.md$/, '');
}

function extractLinks(body) {
  const out = [];
  const text = body || '';
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const inner = m[1].split('|')[0].split('#')[0].trim();
    if (inner) out.push({ kind: 'wiki', target: inner, raw: m[0] });
  }
  for (const m of text.matchAll(/\]\(([^)\s]+\.md)(?:\s+"[^"]*")?\)/g)) {
    out.push({ kind: 'md', target: decodeURIComponent(m[1]), raw: m[0] });
  }
  return out;
}

function relTarget(fromRel, toRel) {
  const fromDir = path.posix.dirname(fromRel);
  const rel = path.posix.relative(fromDir, toRel);
  return rel.split('/').map((s) => s.split('#')[0]).map(encodeURIComponent).join('/');
}

function rewriteLinks(body, oldRel, newRel, oldStem, newStem, fromRel) {
  let out = String(body || '');
  out = out.replace(/\[\[([^\]]+)\]\]/g, (whole, inner) => {
    const [targetPart, ...rest] = inner.split('|');
    const [t, hash] = targetPart.split('#');
    const clean = t.trim().replace(/\.md$/, '');
    if (clean === oldRel.replace(/\.md$/, '') || clean === oldStem) {
      const repl = (clean.includes('/') ? newRel.replace(/\.md$/, '') : newStem) + (hash ? '#' + hash : '');
      return '[[' + repl + (rest.length ? '|' + rest.join('|') : '') + ']]';
    }
    return whole;
  });
  out = out.replace(/\]\(([^)\s]+\.md)(\s+"[^"]*")?\)/g, (whole, target, title) => {
    const decoded = decodeURIComponent(target);
    if (decoded === oldRel || path.posix.basename(decoded) === path.posix.basename(oldRel)) {
      return '](' + relTarget(fromRel || oldRel, newRel) + (title || '') + ')';
    }
    return whole;
  });
  return out;
}

function httpJson(method, url, payload, extraHeaders = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const body = payload ? JSON.stringify(payload) : null;
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
                                 headers: { 'Content-Type': 'application/json', ...extraHeaders, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
                                 timeout: 1500 }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      if (body) req.write(body);
      req.end();
    } catch { resolve(null); }
  });
}

module.exports = { KB, extractLinks, rewriteLinks, run, runPy, IS_WIN, runtimeDir, runtimePython, prepareRuntimeEnv };
