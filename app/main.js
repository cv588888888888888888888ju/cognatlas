'use strict';
/** Electron 主进程：窗口 + IPC。所有知识库操作都走 core/kb-core.js（渲染进程不直接碰文件）。 */
const { app, BrowserWindow, ipcMain, shell, dialog, session, webContents, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { KB, run } = require('../core/kb-core');
const links = require('../lib/links-store');
const identityMod = require('../core/identity');
const plugins = require('../core/plugins');
const { execFileSync } = require('node:child_process');

let kb = null;
let win = null;
let AUTH = { identity: 'human:user', name: 'desktop', token: null };
process.on('uncaughtException', (e) => console.error('[uncaught]', e && (e.stack || e.message || e)));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.stack || e.message || e)));

const APP_NAME = 'cognatlas';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.cognatlas.app');

/** 旧版 kb-client 的 userData 迁移：只复制配置/窗口/tag/快照/会话，不删除旧目录。 */
function migrateLegacyUserData() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'kb-client');
    const newDir = app.getPath('userData');
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    if (fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const name of ['config.json', 'window-state.json', 'entry-tags.json', 'links', 'Local Storage', 'Session Storage', 'Preferences', 'Network']) {
      const src = path.join(oldDir, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, name), { recursive: true });
    }
    console.log('[migrate] copied legacy user data from ' + oldDir + ' to ' + newDir);
  } catch (err) {
    console.log('[migrate] skipped: ' + String(err && err.message || err));
  }
}
migrateLegacyUserData();

// 单实例：第二次启动只把已有窗口拉到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

const WINDOW_STATE = path.join(app.getPath('userData'), 'window-state.json');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { /* ignore */ }
  return cfg;
}
/** 首启自动签发 human:user 令牌并复用；身份可在 config.json 的 identity 改。 */
function ensureAuth() {
  const cfg = loadConfig();
  const want = cfg.identity || 'human:user';
  const r = identityMod.ensureClientToken(want);
  if (!r.ok) {
    console.log('[auth] ensure token failed: ' + (r.error || '') + ' ' + (r.detail || ''));
    return AUTH;
  }
  AUTH = { identity: want, name: (r.record && r.record.name) || 'desktop', token: r.token };
  if (cfg.identity !== want) saveConfig({ identity: want });
  return AUTH;
}

/** 读取 <kb_root>/.okf/plugins/<name>/plugin.json：只做清单校验，不执行插件代码。 */
function pluginClientEnabled() {
  if (process.env.KB_NO_PLUGIN_CLIENT === '1') return false;
  const cfg = loadConfig();
  return !(cfg.plugins && cfg.plugins.client_enabled === false);
}

function loadPluginManifests() {
  if (!kb) return [];
  const dir = path.join(kb.root, '.okf', 'plugins');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const fences = new Set(), names = new Set();
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'plugin.json');
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('[plugins] skip ' + ent.name + ': ' + e.message); continue; }
    const v = plugins.validateManifest(raw, ent.name);
    if (!v.ok) { if (!v.disabled) console.log('[plugins] skip ' + ent.name + ': ' + v.error); continue; }
    if (fences.has(v.plugin.fence) || names.has(v.plugin.name)) { console.log('[plugins] skip duplicate ' + ent.name); continue; }
    fences.add(v.plugin.fence); names.add(v.plugin.name);
    out.push({ ...v.plugin, dir: path.join(dir, ent.name) });
  }
  return out;
}

function resolveKbRoot() {
  const env = process.env.KB_ROOT;
  if (env && fs.existsSync(env)) return env;
  const cfg = loadConfig();
  if (cfg.kb_root && fs.existsSync(cfg.kb_root)) return cfg.kb_root;
  const guess = path.join(os.homedir(), 'KnowledgeBase');
  if (!process.env.KB_NO_GUESS && fs.existsSync(guess)) return guess;
  return null;
}
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE, 'utf8')); } catch (e) { return null; }
}
function saveWindowState(w) {
  try { const b = w.getBounds(); fs.writeFileSync(WINDOW_STATE, JSON.stringify(b)); } catch (e) { /* ignore */ }
}

/** webview 只允许 http/https 与快照目录内的 page.html。 */
function isAllowedGuestUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') return true;
    if (u.protocol !== 'file:') return false;
    const p = fileURLToPath(u);
    const root = links.rootDir();
    return links.isInside(root, p) && path.basename(p) === 'page.html';
  } catch (e) { return false; }
}

function createWindow(initialDoc) {
  const saved = loadWindowState();
  const w = new BrowserWindow({
    width: saved && saved.width ? saved.width : 1280,
    height: saved && saved.height ? saved.height : 860,
    ...(saved && saved.x != null ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: '#1c1c1c',
    autoHideMenuBar: true,
    title: 'Cognatlas',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  w.setMenuBarVisibility(false);
  // webview 隔离：不继承 preload、不开 node、不弹新窗、不允许导航到任意本地文件
  w.webContents.on('will-attach-webview', (_e, wp) => {
    delete wp.preload;
    wp.nodeIntegration = false;
    wp.nodeIntegrationInSubFrames = false;
    wp.contextIsolation = true;
    wp.sandbox = true;
    wp.webSecurity = true;
    wp.allowRunningInsecureContent = false;
  });
  w.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (ev, url) => { if (!isAllowedGuestUrl(url)) ev.preventDefault(); };
    guest.on('will-navigate', guard);
    guest.on('will-redirect', guard);
  });
  // Chromium 会吞掉 Ctrl+P（打印）等组合键：在 before-input-event 里统一拦下并转给渲染进程
  w.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.control || input.meta)) return;
    const key = String(input.key || '').toLowerCase();
    if (!['p', 's', 'n', 'o', 'w', 'f', 'k'].includes(key)) return;
    if (key === 'f' && !input.shift) return;   // 裸 Ctrl+F 交给页面内查找（渲染进程 CodeMirror）
    if (key === 'k' && !input.shift) return;   // 裸 Ctrl+K 不占用；Ctrl+Shift+K = 检查当前文档
    event.preventDefault();
    w.webContents.send('kb:shortcut', (input.shift ? 'shift+' : '') + key);
  });
  w.__dirty = false;
  w.__forceClose = false;
  w.on('close', () => saveWindowState(w));
  // 关闭前确认未保存的修改
  w.on('close', async (e) => {
    if (!w.__dirty || w.__forceClose) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['保存并关闭', '不保存', '取消'],
      defaultId: 0, cancelId: 2,
      message: '有未保存的修改',
      detail: '关闭前要保存吗？',
    });
    if (response === 0) w.webContents.send('kb:save-and-close');
    else if (response === 1) { w.__dirty = false; w.__forceClose = true; w.close(); }
  });
  w.webContents.on('console-message', (_e, level, message) => console.log('[renderer]', message));
  w.webContents.on('render-process-gone', (_e, d) => console.log('[renderer-gone]', JSON.stringify(d)));
  w.loadFile(path.join(__dirname, 'index.html'), initialDoc ? { query: { doc: initialDoc } } : undefined);
  return w;
}

function registerIpc() {
  const NO_VAULT = { ok: false, error: 'NO-VAULT' };
  ipcMain.handle('kb:vaultState', () => ({ ok: !!kb, root: kb ? kb.root : null }));
  ipcMain.handle('kb:whoami', () => ({ ok: true, identity: AUTH.identity, name: AUTH.name }));
  ipcMain.handle('kb:lastCommit', (_e, rel) => ({ ok: true, commit: kb ? kb.lastCommit(rel) : null }));
  ipcMain.handle('kb:chooseVault', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择知识库文件夹' });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const root = r.filePaths[0];
    try {
      const kb2 = new KB(root);
      kb2.setEntryTagsPath(path.join(app.getPath('userData'), 'entry-tags.json'));
      kb2.setAuth(AUTH);
      await kb2.load();
      kb = kb2;
      saveConfig({ kb_root: root });
      return { ok: true, root, docs: kb.docs.length, dirs: kb.tree().dirs.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });
  ipcMain.handle('kb:tree', () => (kb ? kb.tree() : NO_VAULT));
  ipcMain.handle('kb:plugins', () => {
    if (!kb) return { ok: false, error: 'NO-VAULT', plugins: [] };
    return { ok: true, plugins: loadPluginManifests(), client_enabled: pluginClientEnabled() };
  });
  ipcMain.handle('kb:pluginCode', (_e, name) => {
    if (!kb) return NO_VAULT;
    if (!pluginClientEnabled()) return { ok: false, error: 'CLIENT-DISABLED' };
    const p = loadPluginManifests().find((x) => x.name === String(name || ''));
    if (!p || !p.client || p.trusted === false) return { ok: false, error: 'NO-CLIENT' };
    const fp = path.join(p.dir, p.client);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return { ok: false, error: 'CLIENT-MISSING' };
      if (st.size > 512 * 1024) return { ok: false, error: 'CLIENT-TOO-LARGE' };
      return { ok: true, name: p.name, code: fs.readFileSync(fp, 'utf8'), capabilities: p.capabilities, trusted: p.trusted };
    } catch (e) { return { ok: false, error: 'CLIENT-MISSING' }; }
  });
  ipcMain.handle('kb:assetUrl', (_e, data) => {
    if (!kb) return NO_VAULT;
    const target = String((data && data.target) || '').replace(/^kb:/i, '').trim();
    if (!target) return { ok: false, error: 'NO-TARGET' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { ok: false, error: 'REMOTE-NOT-LOCAL' };
    const fromRel = (data && data.fromRel) || '';
    const norm = target.startsWith('/')
      ? target.replace(/^\/+/, '')
      : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), target.replace(/\\/g, '/')));
    if (!links.isInside(path.resolve(kb.root), path.resolve(kb.root, norm))) return { ok: false, error: 'ASSET-OUTSIDE' };
    const r = kb.resolveAsset(target, fromRel);
    if (!r) return { ok: false, error: 'ASSET-NOT-FOUND' };
    if (r.kind !== 'file') return { ok: false, error: 'REMOTE-NOT-LOCAL' };
    try {
      const realRoot = fs.realpathSync(kb.root);
      const real = fs.realpathSync(r.abs);
      if (!links.isInside(realRoot, real)) return { ok: false, error: 'ASSET-OUTSIDE' };
      const st = fs.statSync(real);
      if (!st.isFile()) return { ok: false, error: 'ASSET-NOT-FOUND' };
      if (st.size > 2 * 1024 * 1024 * 1024) return { ok: false, error: 'ASSET-TOO-LARGE' };
      return { ok: true, url: pathToFileURL(real).href, rel: r.rel, bytes: st.size };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('kb:check', (_e, rel) => {
    if (!kb) return NO_VAULT;
    if (!kb.hasOkf()) return { ok: false, error: 'NO-OKF' };
    const env = { ...process.env };
    if (AUTH.token) env.KB_TOKEN = AUTH.token;
    const inv = kb.okfCommand(['check', '--json', String(rel || '')]);
    let out = '';
    try {
      out = execFileSync(inv.cmd, inv.args, { cwd: kb.root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, env });
    } catch (err) {
      out = String((err && err.stdout) || '');
      if (!out.trim()) return { ok: false, error: String((err && err.message) || err) };
    }
    const start = out.indexOf('{');
    if (start < 0) return { ok: false, error: 'BAD-CHECK-OUTPUT', raw: out.slice(-400) };
    try {
      const data = JSON.parse(out.slice(start));
      return { ok: true, gate: data.gate, counts: data.counts, findings: data.findings || [], checkers: data.checkers || [] };
    } catch (err) { return { ok: false, error: 'BAD-CHECK-JSON', raw: out.slice(-400) }; }
  });
  ipcMain.handle('kb:read', (_e, rel) => {
    const abs = path.join(kb.root, rel);
    const st = fs.statSync(abs);
    return { text: fs.readFileSync(abs, 'utf8'), mtime: st.mtimeMs };
  });
  ipcMain.handle('kb:save', (_e, { rel, text, mtime }) => kb.save(rel, text, { expectMtime: mtime }));
  ipcMain.handle('kb:complete', (_e, { kind, q }) => {
    if (kind === 'tag') return kb.completeTag(q || '');
    if (kind === 'field') return kb.completeField(q || '');
    if (kind === 'type') return kb.completeType(q || '');
    if (kind === 'link') return kb.completeLink(q || '');
    return [];
  });
  ipcMain.handle('kb:backlinks', (_e, rel) => kb.backlinks(rel));
  ipcMain.handle('kb:search', async (_e, { q, limit }) => kb.search(q, { limit: limit || 10 }));
  ipcMain.handle('kb:searchQuery', async (_e, { q, limit }) => {
    try { return await kb.searchQuery(q, { limit: limit || 20 }); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  ipcMain.handle('kb:image', (_e, { target, fromRel }) => {
    if (!kb) return { ok: false, error: 'NO-VAULT' };
    const r = kb.resolveAsset(target, fromRel);
    if (!r) return { ok: false, error: 'NOT-FOUND' };
    if (r.kind === 'remote') return { ok: true, url: r.url };
    try {
      const st = fs.statSync(r.abs);
      if (st.size > 12 * 1024 * 1024) return { ok: false, error: 'TOO-LARGE' };
      const ext = path.extname(r.abs).toLowerCase().replace('.', '');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext] || 'application/octet-stream';
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(r.abs).toString('base64'), rel: r.rel };
    } catch (err) {
      return { ok: false, error: String(err.message) };
    }
  });
  ipcMain.handle('kb:setTitle', (event, t) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.setTitle(t ? String(t) + ' — Cognatlas' : 'Cognatlas');
    return { ok: true };
  });
  ipcMain.on('kb:dirty', (event, d) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.__dirty = !!d;
  });
  ipcMain.handle('kb:forceClose', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) { w.__dirty = false; w.__forceClose = true; w.close(); }
    return { ok: true };
  });
  ipcMain.handle('kb:windowState', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return { dirty: !!(w && w.__dirty), windows: BrowserWindow.getAllWindows().length };
  });
  ipcMain.handle('kb:welcome', (_e, lang, id) => {
    try {
      const root = path.join(__dirname, 'welcome');
      const names = { 'zh-CN': '简体中文', 'en-US': 'English' };
      const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
      const langs = fs.readdirSync(root).filter((d) => isDir(path.join(root, d)));
      const pick = langs.includes(lang) ? lang : (langs.includes('zh-CN') ? 'zh-CN' : langs[0]);
      const dir = path.join(root, pick);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
      const titleOf = (f) => {
        try {
          const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m);
          return (m ? m[1] : f.slice(0, -3)).trim();
        } catch (e) { return f.slice(0, -3); }
      };
      const docs = files.map((f) => ({ id: f.slice(0, -3), title: titleOf(f) }));
      const want = docs.find((d) => d.id === id) || docs[0];
      const text = fs.readFileSync(path.join(dir, want.id + '.md'), 'utf8');
      return { ok: true, lang: pick, langs: langs.map((c) => ({ code: c, name: names[c] || c })), docs, id: want.id, title: want.title, text };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('kb:peek', (_e, { target, fromRel }) => kb.peek(target, fromRel));
  ipcMain.handle('kb:openWindow', (_e, rel) => { createWindow(rel); return { ok: true, windows: BrowserWindow.getAllWindows().length }; });
  ipcMain.handle('kb:windowCount', () => BrowserWindow.getAllWindows().length);
  ipcMain.handle('kb:openExternal', async (_e, url) => {
    const s = String(url == null ? '' : url).trim();
    let u = null;
    try { u = new URL(s); } catch (e) { return { ok: false, error: 'BAD-URL' }; }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return { ok: false, error: 'SCHEME-NOT-ALLOWED' };
    if (u.username || u.password) return { ok: false, error: 'CREDENTIALS-NOT-ALLOWED' };
    await shell.openExternal(u.toString());
    return { ok: true };
  });
  ipcMain.handle('kb:entryTags', (_e, { rel, field }) => kb.entryTags(rel, field));
  ipcMain.handle('kb:setEntryTags', (_e, { rel, field, tags }) => kb.setEntryTags(rel, field, tags));
  ipcMain.handle('kb:propHistory', (_e, { rel, field }) => kb.propHistory(rel, field));
  ipcMain.handle('kb:tagSearch', (_e, { tag }) => kb.tagSearch(tag));
  ipcMain.handle('kb:copy', (_e, text) => { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; });
  ipcMain.handle('kb:clipboard', () => clipboard.readText());
  // ---- 外链快照
  const withDir = (meta) => ({ ...meta, dir: path.dirname(links.snapshotPath(meta.id, 'meta.json')) });
  ipcMain.handle('kb:snapAuto', (_e, url) => ({ due: links.autoDue(String(url || '')) }));
  ipcMain.handle('kb:snapList', (_e, url) => links.list(url || null).map(withDir));
  ipcMain.handle('kb:snapGet', (_e, id) => { const g = links.get(id); return g ? withDir(g) : null; });
  ipcMain.handle('kb:snapUrl', (_e, id) => {
    const g = links.get(id);
    if (!g) return { ok: false, error: 'SNAP-NOT-FOUND' };
    const p = path.join(links.rootDir(), 'snapshots', String(id), 'page.html');
    if (!links.isInside(links.rootDir(), p) || !fs.existsSync(p)) return { ok: false, error: 'SNAP-NOT-FOUND' };
    return { ok: true, url: pathToFileURL(p).href, meta: withDir(g) };
  });
  ipcMain.handle('kb:snapSave', async (_e, data) => {
    try {
      let pngBase64 = data && data.pngBase64;
      if (!pngBase64 && data && data.webContentsId) {
        const wc = webContents.fromId(Number(data.webContentsId));
        if (wc) pngBase64 = (await wc.capturePage()).toPNG().toString('base64');
      }
      const meta = links.save({ ...data, pngBase64 });
      return { ok: true, meta: withDir(meta) };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('kb:webCookies', async (_e, url) => {
    try {
      const all = await session.fromPartition('persist:kb-web').cookies.get(url ? { url } : {});
      return { ok: true, cookies: all.map((c) => ({ name: c.name, value: c.value, domain: c.domain, session: c.session, persistent: c.persistent })) };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('kb:webClear', async () => {
    try { await session.fromPartition('persist:kb-web').clearStorageData(); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('kb:rename', (_e, { from, to }) => { const r = kb.rename(from, to); if (r.ok) kb.load(); return r; });
  ipcMain.handle('kb:commands', () => [
    { id: 'save', title: '保存并入库', hint: 'Ctrl+S' },
    { id: 'status', title: '全库状态', hint: 'okf status' },
    { id: 'search', title: '检索知识库', hint: 'Ctrl+Shift+F' },
    { id: 'new', title: '新建笔记', hint: 'kb new' },
    { id: 'commit', title: '提交当前文件', hint: 'kb commit' },
    { id: 'rename', title: '重命名当前文件（自动改链）', hint: 'kb rename' },
    { id: 'refresh', title: '重新索引', hint: '重新读取全库' },
    { id: 'reveal', title: '在文件管理器中显示', hint: '' },
    { id: 'welcome', title: '打开介绍文档', hint: '' },
    { id: 'lang', title: '切换介绍语言（中/英）', hint: '' },
    { id: 'checkdoc', title: '检查当前文档（插件检查器）', hint: 'Ctrl+Shift+K' },
    { id: 'openurl', title: '打开网址（内置浏览器）', hint: '' },
    { id: 'webclear', title: '清除内置浏览器数据（cookie/缓存）', hint: '' }
  ]);
  ipcMain.handle('kb:run', async (_e, { id, rel, text, to }) => {
    if (id === 'status') {
      const r = kb.runOkf(['status'], { cwd: kb.root });
      return { ok: r.code === 0, text: r.stdout + r.stderr };
    }
    if (id === 'refresh') { await kb.load(); return { ok: true, text: '已重新索引 ' + kb.docs.length + ' 篇' }; }
    if (id === 'save') return kb.save(rel, text);
    if (id === 'commit') return kb.commit(null, [rel]);
    if (id === 'rename') { const r = kb.rename(rel, to); if (r.ok) await kb.load(); return r; }
    if (id === 'reveal') { shell.showItemInFolder(path.join(kb.root, rel)); return { ok: true }; }
    return { ok: false, error: 'UNKNOWN-COMMAND' };
  });
}

app.whenReady().then(async () => {
  const webSession = session.fromPartition('persist:kb-web');
  webSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', (e) => { e.preventDefault(); });
  console.log('[boot] whenReady');
  const a = ensureAuth();
  console.log('[boot] auth', a.identity, a.name, a.token ? 'token-ok' : 'no-token');
  const root = resolveKbRoot();
  if (root) {
    kb = new KB(root);
    kb.setEntryTagsPath(path.join(app.getPath('userData'), 'entry-tags.json'));
    kb.setAuth(AUTH);
    try { await kb.load(); } catch (err) { console.log('[boot] kb load failed:', String(err && err.message || err)); kb = null; }
  } else {
    console.log('[boot] no vault configured');
  }
  saveConfig({ kb_root: kb ? kb.root : (loadConfig().kb_root || null) });
  registerIpc();
  if (process.env.KB_COOKIE_PROBE) {
    const ses = session.fromPartition('persist:kb-web');
    const list = await ses.cookies.get({ name: 'fixture' });
    console.log('COOKIE_PROBE ' + JSON.stringify(list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, persistent: c.persistent }))));
    app.exit(0);
    return;
  }
  win = createWindow();
  if (process.env.KB_EVAL) return evalScene(process.env.KB_EVAL);
  if (process.env.KB_SHOT) return shoot(process.env.KB_SHOT);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) win = createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { session.fromPartition('persist:kb-web').flushStorageData(); } catch (e) { /* ignore */ } });

// ---------------------------------------------------------------- 无头截图自检（A13）
async function shoot(outPath) {
  const w = win;
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, Number(process.env.KB_SHOT_WAIT || 2500)));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  const size = img.getSize();
  try { await session.fromPartition('persist:kb-web').flushStorageData(); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ shot: outPath, width: size.width, height: size.height }));
  app.exit(0);
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 3000).unref();
}

// ---------------------------------------------------------------- 无头脚本自检（UI 判据 A14/A16–A20）
async function evalScene(src) {
  setTimeout(() => { console.log('EVAL_RESULT ' + JSON.stringify({ ok: false, error: 'EVAL-TIMEOUT' })); app.exit(3); }, Number(process.env.KB_EVAL_TIMEOUT || 45000)).unref();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, Number(process.env.KB_EVAL_WAIT || 1800)));
  // 等渲染进程完成首屏（DOMContentLoaded 里会打开第一篇），避免与场景脚本抢文档
  for (let i = 0; i < 100; i++) {
    try { if (await win.webContents.executeJavaScript('window.__kbReady === true')) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  let out;
  try {
    out = await win.webContents.executeJavaScript('(async () => { ' + src + ' })()', true);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  if (process.env.KB_SHOT) {
    await new Promise((r) => setTimeout(r, 350));   // 等一帧合成，否则截到 eval 之前的画面
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.KB_SHOT, img.toPNG());
    out = { ...(typeof out === 'object' && out ? out : { value: out }), shot: process.env.KB_SHOT };
  }
  try { await session.fromPartition('persist:kb-web').flushStorageData(); } catch (e) { /* 分区未用过 */ }
  console.log('EVAL_RESULT ' + JSON.stringify(out));
  app.exit(0);
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 3000).unref();
}
