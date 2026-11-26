'use strict';
/**
 * 声明式渲染插件：清单校验 + 围栏块解析（纯函数，主进程与渲染进程共用）。
 * 契约见 docs/ARCHITECTURE.md。
 * v1 只允许白名单组件（video），不执行插件 JS —— 清单不能注入 HTML。
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const EXT_RE = /^[a-z0-9]{1,8}$/;
const COMPONENTS = new Set(['video', 'custom']);
const CAPABILITIES = new Set(['ui', 'webview', 'commands']);
const ALLOWED_SCHEMES = new Set(['http', 'https', 'kb']);
const MAX_BLOCK_BYTES = 2048;
const MAX_BLOCK_LINES = 20;

function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

function validateManifest(raw, dirName) {
  const o = asObject(raw);
  if (!o) return { ok: false, error: '清单不是 JSON 对象' };
  const name = String(o.name || dirName || '');
  if (!NAME_RE.test(name)) return { ok: false, error: 'name 不合法（小写字母/数字/-/_，2–32 位）' };
  if (dirName && name !== dirName) return { ok: false, error: 'name 必须与目录名一致' };
  if (o.enabled === false) return { ok: false, disabled: true, error: '插件已禁用' };
  const fence = String(o.fence || '');
  if (!NAME_RE.test(fence)) return { ok: false, error: 'fence 不合法' };
  const component = String(o.component || '');
  if (!COMPONENTS.has(component)) return { ok: false, error: 'component 不在白名单：' + component + '（v1 只支持 video）' };
  const propsIn = asObject(o.props) || {};
  const props = {};
  for (const [key, specRaw] of Object.entries(propsIn)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key)) return { ok: false, error: '属性名不合法：' + key };
    const spec = asObject(specRaw);
    if (!spec) return { ok: false, error: '属性 ' + key + ' 的声明不是对象' };
    const out = { required: !!spec.required, type: 'string' };
    if (spec.type != null) {
      if (!['string', 'bool'].includes(spec.type)) return { ok: false, error: '属性 ' + key + ' 的 type 只允许 string/bool' };
      out.type = spec.type;
    }
    if (spec.schemes != null) {
      if (!Array.isArray(spec.schemes)) return { ok: false, error: '属性 ' + key + ' 的 schemes 必须是数组' };
      out.schemes = [];
      for (const s of spec.schemes) {
        const v = String(s).toLowerCase().replace(/:$/, '');
        if (!ALLOWED_SCHEMES.has(v)) return { ok: false, error: '属性 ' + key + ' 含不支持的 scheme：' + s };
        out.schemes.push(v);
      }
    }
    if (spec.extensions != null) {
      if (!Array.isArray(spec.extensions)) return { ok: false, error: '属性 ' + key + ' 的 extensions 必须是数组' };
      out.extensions = spec.extensions.map((x) => String(x).toLowerCase().replace(/^\./, ''));
      for (const e of out.extensions) if (!EXT_RE.test(e)) return { ok: false, error: '属性 ' + key + ' 的扩展名不合法：' + e };
    }
    if (spec.default != null) {
      if (out.type === 'bool' && typeof spec.default !== 'boolean') return { ok: false, error: '属性 ' + key + ' 的默认值必须是布尔' };
      if (out.type === 'string' && typeof spec.default !== 'string') return { ok: false, error: '属性 ' + key + ' 的默认值必须是字符串' };
      out.default = spec.default;
    }
    props[key] = out;
  }
  if (component === 'video' && (!props.src || props.src.required !== true)) return { ok: false, error: 'video 组件必须声明必填属性 src' };
  const trusted = o.trusted !== false;
  let client = null;
  if (o.client != null) {
    client = String(o.client);
    if (!/^[A-Za-z0-9_-]{1,64}\.js$/.test(client) || client.includes('/')) return { ok: false, error: 'client 只能是同目录 .js 文件名' };
  }
  let capabilities = ['ui', 'webview', 'commands'];
  if (o.capabilities != null) {
    if (!Array.isArray(o.capabilities)) return { ok: false, error: 'capabilities 必须是数组' };
    capabilities = o.capabilities.map((x) => String(x));
    for (const c of capabilities) if (!CAPABILITIES.has(c)) return { ok: false, error: 'capability 不支持：' + c };
  }
  let checker = null;
  if (o.checker != null) {
    checker = String(o.checker);
    if (!/^[a-z0-9_.-]{1,64}\.py$/.test(checker) || checker.includes('/')) return { ok: false, error: 'checker 只能是同目录 .py 文件名' };
  }
  return {
    ok: true,
    plugin: {
      name, fence, component,
      title: String(o.title || name).slice(0, 80),
      props, checker, trusted, client, capabilities,
      version: Number(o.version) || 1,
    },
  };
}

function stripValue(v) {
  let s = String(v == null ? '' : v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

function extensionOf(target) {
  const clean = String(target || '').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,8})$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 解析围栏块正文。返回 {ok, values, errors, local:{key:bool}}。
 * 只做静态校验；本地文件是否存在由调用方（主进程/检查器）检查。
 */
function parseBlock(body, plugin) {
  const errors = [];
  const values = {};
  const raw = String(body == null ? '' : body);
  const byteLen = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(raw).length : raw.length;
  if (byteLen > MAX_BLOCK_BYTES) {
    errors.push({ code: 'TOO-LONG', message: '块超过 ' + MAX_BLOCK_BYTES + ' 字节' });
    return { ok: false, values, errors, local: {} };
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length > MAX_BLOCK_LINES) errors.push({ code: 'TOO-MANY-LINES', message: '块超过 ' + MAX_BLOCK_LINES + ' 行' });
  let n = 0;
  for (const lineRaw of lines.slice(0, MAX_BLOCK_LINES)) {
    n++;
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) { errors.push({ code: 'BAD-LINE', line: n, message: '第 ' + n + ' 行不是 key: value' }); continue; }
    const key = line.slice(0, idx).trim();
    const spec = plugin.props[key];
    if (!spec) { errors.push({ code: 'UNKNOWN-KEY', line: n, message: '未知属性：' + key }); continue; }
    let val = stripValue(line.slice(idx + 1));
    if (spec.type === 'bool') {
      if (val !== 'true' && val !== 'false') { errors.push({ code: 'BAD-BOOL', line: n, message: key + ' 只能是 true/false' }); continue; }
      values[key] = val === 'true';
      continue;
    }
    if (val.length > 2000) { errors.push({ code: 'TOO-LONG', line: n, message: key + ' 值过长' }); continue; }
    values[key] = val;
  }
  for (const [key, spec] of Object.entries(plugin.props)) {
    if (spec.required && (values[key] == null || values[key] === '')) {
      errors.push({ code: 'MISSING-' + key.toUpperCase(), message: '缺少必填属性：' + key });
    }
  }
  const local = {};
  for (const key of Object.keys(plugin.props)) {
    const val = values[key];
    const spec = plugin.props[key];
    if (typeof val !== 'string' || !val) continue;
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(val);
    if (m) {
      const scheme = m[1].toLowerCase();
      if (scheme === 'kb') { local[key] = true; continue; }
      if (spec.schemes && !spec.schemes.includes(scheme)) {
        errors.push({ code: 'BAD-SCHEME', message: key + ' 不允许 ' + scheme + ' 协议' });
        continue;
      }
    } else {
      local[key] = true;
    }
    if (spec.extensions && spec.extensions.length) {
      const ext = extensionOf(local[key] ? val.replace(/^kb:/i, '') : val);
      if (!ext || !spec.extensions.includes(ext)) {
        errors.push({ code: 'BAD-EXT', message: key + ' 扩展名不允许：' + (ext || '无') });
      }
    }
  }
  return { ok: errors.length === 0, values, errors, local };
}

module.exports = { validateManifest, parseBlock, COMPONENTS, NAME_RE, MAX_BLOCK_BYTES, MAX_BLOCK_LINES };
