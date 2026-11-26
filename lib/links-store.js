'use strict';
/**
 * 外链快照存储。
 * 契约见 docs/ARCHITECTURE.md。
 * 目录：KB_LINKS_DIR（缺省 <userData>/links）
 *   index.json                       { version, entries: {id: meta}, autoAt: {url: ts} }
 *   snapshots/<id>/page.html         页面 outerHTML
 *   snapshots/<id>/page.png          截图（可选）
 *   snapshots/<id>/text.txt          innerText
 *   snapshots/<id>/meta.json         meta（不含 html/text）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTO_DEDUPE_MS = 6 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOTS = 500;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const SNAP_CSP = "default-src 'none'; img-src * data: file:; media-src * data: file:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const ID_RE = /^[0-9]{10,}-[0-9a-f]{8}$/;

function dirOf(base) {
  return base || process.env.KB_LINKS_DIR || path.join(require('electron').app.getPath('userData'), 'links');
}

function ensure(dir) {
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
}

function indexPath(dir) { return path.join(dir, 'index.json'); }

function readIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries) return { version: 1, entries: raw.entries, autoAt: raw.autoAt || {} };
  } catch (e) { /* 首次运行或损坏都重建 */ }
  return { version: 1, entries: {}, autoAt: {} };
}

function writeIndex(dir, idx) {
  const tmp = indexPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath(dir));
}

/** 快照 HTML 是不可信内容：CSP 禁脚本 + 去 script/内联事件，双保险。 */
function sanitizeSnapshotHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1="#"');
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + SNAP_CSP + '">';
  const m = /<head[^>]*>/i.exec(s);
  if (m) return s.slice(0, m.index + m[0].length) + meta + s.slice(m.index + m[0].length);
  return '<!doctype html><html><head>' + meta + '</head><body>' + s + '</body></html>';
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function newId(url, ts) {
  return ts + '-' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
}

function save(input, opts) {
  const dir = dirOf(opts && opts.dir);
  ensure(dir);
  const url = String(input.url || '');
  if (!url) throw new Error('URL 为空');
  const ts = input.ts || Date.now();
  const id = newId(url, ts);
  const snapDir = path.join(dir, 'snapshots', id);
  fs.mkdirSync(snapDir, { recursive: true });

  const idx0 = readIndex(dir);
  const existing = Object.values(idx0.entries);
  if (existing.length >= MAX_SNAPSHOTS) throw new Error('SNAP-QUOTA 快照数量已达上限 ' + MAX_SNAPSHOTS);
  const totalBytes = existing.reduce((n, m) => n + ((m.bytes && (m.bytes.html + m.bytes.text + m.bytes.png)) || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('SNAP-QUOTA 快照总容量已达上限 500 MB');

  let html = sanitizeSnapshotHtml(input.html);
  let truncated = false;
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
    html = html.slice(0, MAX_HTML_BYTES) + '\n<!--TRUNCATED-->';
    truncated = true;
  }
  const text = String(input.text || '');
  fs.writeFileSync(path.join(snapDir, 'page.html'), html);
  fs.writeFileSync(path.join(snapDir, 'text.txt'), text);

  let pngBytes = 0;
  if (input.pngBase64) {
    const buf = Buffer.from(String(input.pngBase64).replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(snapDir, 'page.png'), buf);
    pngBytes = buf.length;
  }

  const meta = {
    id, url,
    title: String(input.title || '').slice(0, 500),
    ts,
    status: input.status || 'ok',
    hash: crypto.createHash('sha256').update(text || html).digest('hex').slice(0, 16),
    bytes: { html: Buffer.byteLength(html), text: Buffer.byteLength(text), png: pngBytes, truncated },
    files: { html: 'page.html', png: pngBytes ? 'page.png' : null, text: 'text.txt' },
  };
  fs.writeFileSync(path.join(snapDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const idx = idx0;
  idx.entries[id] = meta;
  if (input.auto) idx.autoAt[url] = ts;
  writeIndex(dir, idx);
  return meta;
}

function list(url, opts) {
  const dir = dirOf(opts && opts.dir);
  const idx = readIndex(dir);
  return Object.values(idx.entries)
    .filter((m) => !url || m.url === url)
    .sort((a, b) => b.ts - a.ts);
}

function recent(n, opts) {
  return list(null, opts).slice(0, n || 20);
}

function get(id, opts) {
  if (!ID_RE.test(String(id || ''))) return null;
  const dir = dirOf(opts && opts.dir);
  const idx = readIndex(dir);
  const meta = idx.entries[id];
  if (!meta) return null;
  const snapDir = path.join(dir, 'snapshots', id);
  const out = { ...meta, dir: snapDir };
  try { out.html = fs.readFileSync(path.join(snapDir, 'page.html'), 'utf8'); } catch (e) { out.html = ''; }
  try { out.text = fs.readFileSync(path.join(snapDir, 'text.txt'), 'utf8'); } catch (e) { out.text = ''; }
  return out;
}

function autoDue(url, opts) {
  const dir = dirOf(opts && opts.dir);
  const idx = readIndex(dir);
  const last = idx.autoAt[url] || 0;
  return Date.now() - last > AUTO_DEDUPE_MS;
}

function snapshotPath(id, file, opts) {
  if (!ID_RE.test(String(id || ''))) return null;
  const dir = dirOf(opts && opts.dir);
  return path.join(dir, 'snapshots', id, file);
}

function rootDir(opts) { return dirOf(opts && opts.dir); }

module.exports = { save, list, recent, get, autoDue, snapshotPath, dirOf, rootDir, isInside, sanitizeSnapshotHtml, AUTO_DEDUPE_MS, MAX_SNAPSHOTS };
