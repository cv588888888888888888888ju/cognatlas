'use strict';
/**
 * identity —— 令牌定位与身份解析（CLI 与 Electron 共用）。
 * 顺序：KB_TOKEN > KB_TOKEN_FILE > ~/.config/kb/token > 客户端 token > AUTH-NEEDED。
 * 客户端 token 现在在 ~/.config/cognatlas/token；旧 ~/.config/kb-client/token 会自动复制过来。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./token-store');

function configHome() { return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'); }
function cliTokenPath() { return path.join(configHome(), 'kb', 'token'); }
function clientTokenPath() { return path.join(configHome(), 'cognatlas', 'token'); }
function legacyClientTokenPath() { return path.join(configHome(), 'kb-client', 'token'); }

function readFileToken(p) {
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    return t || null;
  } catch (e) { return null; }
}

function saveTokenFile(p, token) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(token).trim() + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (e) { /* ignore */ }
}

/** 读新路径；不存在时把旧 kb-client token 复制到新路径（不删除旧文件）。 */
function readClientToken() {
  const p = clientTokenPath();
  const fresh = readFileToken(p);
  if (fresh) return fresh;
  const legacy = readFileToken(legacyClientTokenPath());
  if (legacy) {
    try { saveTokenFile(p, legacy); } catch (e) { /* ignore */ }
    return legacy;
  }
  return null;
}

function resolve() {
  if (process.env.KB_TOKEN) {
    const r = store.resolveToken(process.env.KB_TOKEN);
    return r.ok ? { ...r, source: 'env' } : { ...r, source: 'env' };
  }
  if (process.env.KB_TOKEN_FILE) {
    const t = readFileToken(process.env.KB_TOKEN_FILE);
    if (t) {
      const r = store.resolveToken(t);
      return r.ok ? { ...r, source: 'env-file', token: t } : { ...r, source: 'env-file' };
    }
  }
  let invalid = null;
  const cliTok = readFileToken(cliTokenPath());
  if (cliTok) {
    const r = store.resolveToken(cliTok);
    if (r.ok) return { ...r, source: 'cli-file', token: cliTok };
    invalid = { ...r, source: 'cli-file' };
  }
  const clientTok = readClientToken();
  if (clientTok) {
    const r = store.resolveToken(clientTok);
    if (r.ok) return { ...r, source: 'client-file', token: clientTok };
    invalid = invalid || { ...r, source: 'client-file' };
  }
  if (invalid) return invalid;
  return { ok: false, error: 'AUTH-NEEDED', detail: '未找到 token：运行 kb token new --name me --save，或先启动一次客户端（会自动签发 human:user）' };
}

/** 客户端首启：已有有效且身份一致的 token 就复用，否则签发一个新的 desktop token。 */
function ensureClientToken(identity = 'human:user', name = 'desktop') {
  const tok = readClientToken();
  if (tok) {
    const r = store.resolveToken(tok);
    if (r.ok && r.identity === identity) return { ok: true, token: tok, identity, reused: true };
  }
  let c = store.createToken({ name, identity });
  if (!c.ok && c.error === 'TOKEN-NAME-TAKEN') {
    c = store.createToken({ name: name + '-' + Math.random().toString(16).slice(2, 6), identity });
  }
  if (!c.ok) return { ok: false, error: c.error, detail: c.detail };
  saveTokenFile(clientTokenPath(), c.token);
  return { ok: true, token: c.token, identity, created: true, record: c.record };
}

module.exports = { resolve, ensureClientToken, cliTokenPath, clientTokenPath, legacyClientTokenPath, readFileToken, saveTokenFile, configHome };
