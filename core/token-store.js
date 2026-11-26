'use strict';
/**
 * token-store —— 身份令牌的唯一存储（CLI、Electron 客户端、kb-serve 共用）。
 * 契约见 docs/ARCHITECTURE.md。
 * 只存 sha256(token)，不存明文；文件权限 0600。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const IDENT_RE = /^(human:[A-Za-z0-9._-]+|agent:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+|process:[A-Za-z0-9._-]+)$/;

function dataDir() {
  return process.env.KB_TOKEN_DIR
    || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'kb-service');
}
function storePath() {
  return process.env.KB_TOKEN_STORE || path.join(dataDir(), 'tokens.json');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function nowIso() { return new Date().toISOString(); }

function read() {
  const p = storePath();
  try {
    const db = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!db || !Array.isArray(db.tokens)) return { version: 1, tokens: [] };
    return db;
  } catch (e) {
    return { version: 1, tokens: [] };
  }
}

function write(db) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (e) { /* ignore */ }
}

function validateIdentity(identity) { return IDENT_RE.test(String(identity || '')); }

function createToken({ name, runtime = null, session = null, identity = null } = {}) {
  const label = String(name || '').trim();
  if (!label) return { ok: false, error: 'TOKEN-NAME-REQUIRED' };
  const id = crypto.randomBytes(8).toString('hex');
  let ident = identity;
  if (!ident) {
    ident = runtime
      ? 'agent:' + runtime + ':' + (session || 's-' + id.slice(0, 8))
      : 'human:user';
  }
  if (!validateIdentity(ident)) return { ok: false, error: 'IDENTITY-INVALID', detail: ident };
  const db = read();
  if (db.tokens.some((t) => t.name === label && !t.revoked_at)) {
    return { ok: false, error: 'TOKEN-NAME-TAKEN', detail: label };
  }
  const token = 'kbt_' + crypto.randomBytes(16).toString('hex');
  const rec = {
    id, name: label, identity: ident,
    runtime: runtime || null, session: session || null,
    sha256: sha256(token), created_at: nowIso(), last_used_at: null, revoked_at: null,
  };
  db.tokens.push(rec);
  write(db);
  return { ok: true, token, record: { ...rec, sha256: undefined } };
}

function listTokens() {
  return read().tokens.map((t) => ({
    id: t.id, name: t.name, identity: t.identity, runtime: t.runtime || null,
    created_at: t.created_at, last_used_at: t.last_used_at || null,
    revoked: !!t.revoked_at, revoked_at: t.revoked_at || null,
  }));
}

function resolveToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, error: 'AUTH-NEEDED' };
  const h = sha256(raw);
  const db = read();
  const rec = db.tokens.find((t) => t.sha256 === h);
  if (!rec || rec.revoked_at) return { ok: false, error: 'AUTH-INVALID' };
  // last_used 最多每分钟落盘一次，避免每条命令都写盘
  const last = rec.last_used_at ? Date.parse(rec.last_used_at) : 0;
  if (!last || Date.now() - last > 60000) {
    rec.last_used_at = nowIso();
    try { write(db); } catch (e) { /* 只影响审计时间，不阻断 */ }
  }
  return { ok: true, identity: rec.identity, name: rec.name, id: rec.id, identityValid: validateIdentity(rec.identity) };
}

function revokeToken(nameOrId) {
  const key = String(nameOrId || '').trim();
  if (!key) return { ok: false, error: 'ARG-REQUIRED' };
  const db = read();
  let n = 0;
  for (const t of db.tokens) {
    if ((t.id === key || t.name === key) && !t.revoked_at) { t.revoked_at = nowIso(); n++; }
  }
  if (n) write(db);
  return { ok: n > 0, revoked: n };
}

module.exports = {
  IDENT_RE, dataDir, storePath, sha256, read, write,
  createToken, listTokens, resolveToken, revokeToken, validateIdentity,
};
