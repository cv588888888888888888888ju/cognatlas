import { EditorState, StateField, Compartment } from '@codemirror/state';
import pluginCore from '../core/plugins.js';
import { EditorView, keymap, Decoration, ViewPlugin, drawSelection, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion, CompletionContext, completionStatus } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { search, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { svgIcon, mountIcons } from './icons.js';

const api = window.kb;
let MY_IDENTITY = 'human:user';
let MY_NAME = '';
const readOnlyComp = new Compartment();
const WELCOME_REL = '__welcome__';
const WELCOME_TITLES = { 'zh-CN': '介绍', 'en-US': 'Welcome' };
let WELCOME_DOCS = [];
let WELCOME_DOC_TITLES = {};
function isWelcomeRel(rel) { return rel === WELCOME_REL || String(rel || '').startsWith('__welcome__:'); }
function welcomeIdFromRel(rel) {
  const s = String(rel || '');
  return s.startsWith('__welcome__:') ? s.slice('__welcome__:'.length) : null;
}
function welcomeRelForId(id) { return (!id || id === '00-intro') ? WELCOME_REL : '__welcome__:' + id; }
function welcomeTitle(rel) { return WELCOME_DOC_TITLES[rel] || (WELCOME_TITLES[current && current.lang] || '介绍'); }
function pickWelcomeLang() {
  const saved = localStorage.getItem('kb:lang');
  if (saved) return saved;
  return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
window.addEventListener('error', (e) => {
  const el = document.getElementById('status-left');
  if (el) el.textContent = 'JS ERROR: ' + (e.message || e.error);
  console.error(e.error || e.message);
});
let view = null;
let current = null;            // { rel, mtime, text }
let dirty = false;
let linkHits = [];   // 视口内的链接命中区间，供悬浮/点击用

const kbHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: '#c792ea' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#f78c6c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7394', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#82aaff' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: '#ffcb6b' },
  { tag: [t.typeName, t.className, t.tagName], color: '#ffcb6b' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#89ddff' },
  { tag: t.heading, color: '#dadada', fontWeight: '600' },
  { tag: t.link, color: 'hsl(258,88%,72%)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: [t.variableName, t.name], color: '#dadada' },
  { tag: t.meta, color: '#6b7394' },
]);

// ---------------------------------------------------------------- Live Preview
const HIDE = Decoration.replace({});

class ImageWidget extends WidgetType {
  constructor(target, alt) { super(); this.target = target; this.alt = alt || ''; }
  eq(o) { return o.target === this.target && o.alt === this.alt; }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-img-widget';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.style.display = 'none';
    const ph = document.createElement('span');
    ph.className = 'cm-img-ph';
    ph.textContent = '🖼 ' + (this.alt || this.target);
    wrap.append(img, ph);
    const key = this.target + '@' + (current ? current.rel : '');
    const cached = IMG_CACHE.get(key);
    const apply = (res) => {
      if (res && res.ok && (res.dataUrl || res.url)) {
        img.onload = () => { img.style.display = ''; ph.remove(); };
        img.src = res.dataUrl || res.url;
      } else {
        ph.textContent = '🖼 ' + (this.alt || this.target) + (res && res.error === 'TOO-LARGE' ? '（文件过大）' : '（未找到）');
      }
    };
    if (cached) apply(cached);
    else if (api.image) api.image(this.target, current ? current.rel : '').then((res) => { IMG_CACHE.set(key, res); apply(res); }).catch(() => {});
    return wrap;
  }
  ignoreEvent() { return true; }
}

const IMG_CACHE = new Map();

class GlyphWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls || 'cm-bullet'; }
  eq(o) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
}

/** frontmatter 结束位置（含收尾 --- 与换行）；没有头部返回 0 */
function fmEndOf(doc) {
  const head = doc.sliceString(0, Math.min(doc.length, 4000));
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(head);
  return m ? m[0].length : 0;
}

function lineDecos(doc, i, decos, skipInline) {
  const line = doc.line(i);
  const text = line.text;
  const h = /^(#{1,6})\s+/.exec(text);
  if (h) {
    decos.push(Decoration.line({ class: 'tok-h' + Math.min(3, h[1].length) }).range(line.from));
    decos.push(HIDE.range(line.from, line.from + h[0].length));
  }
  const q = /^>\s?/.exec(text);
  if (q) {
    decos.push(Decoration.line({ class: 'cm-quote' }).range(line.from));
    decos.push(HIDE.range(line.from, line.from + q[0].length));
  }
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+/.exec(text);
  if (task) {
    const from = line.from + task[1].length;
    decos.push(Decoration.replace({ widget: new GlyphWidget(task[2].toLowerCase() === 'x' ? '☑' : '☐') }).range(from, line.from + task[0].length));
  } else {
    const bullet = /^(\s*)[-*+]\s+/.exec(text);
    if (bullet) {
      const from = line.from + bullet[1].length;
      decos.push(Decoration.replace({ widget: new GlyphWidget('•') }).range(from, line.from + bullet[0].length));
    }
  }
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) decos.push(Decoration.line({ class: 'cm-hr' }).range(line.from));
  if (/^\s*\|/.test(text)) {
    const sep = /^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/.test(text);
    decos.push(Decoration.line({ class: sep ? 'cm-table-sep' : 'cm-table' }).range(line.from));
  }
  if (skipInline) return;
  const push = (from, to, cls) => decos.push(Decoration.mark({ class: cls }).range(from, to));
  const hide = (from, to) => decos.push(HIDE.range(from, to));
  for (const m of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const s0 = line.from + m.index;
    decos.push(Decoration.replace({ widget: new ImageWidget(m[1], m[1].split('/').pop()) }).range(s0, s0 + m[0].length));
  }
  for (const m of text.matchAll(/!\[([^\]]*)\]\((<[^>]+>|(?:[^()]|\([^()]*\))+)\)/g)) {
    const s0 = line.from + m.index;
    decos.push(Decoration.replace({ widget: new ImageWidget(cleanLinkTarget(m[2]), m[1]) }).range(s0, s0 + m[0].length));
  }
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) {
    const s0 = line.from + m.index;
    hide(s0, s0 + 2); push(s0 + 2, s0 + m[0].length - 2, 'tok-strong'); hide(s0 + m[0].length - 2, s0 + m[0].length);
  }
  for (const m of text.matchAll(/~~([^~]+)~~/g)) {
    const s0 = line.from + m.index;
    hide(s0, s0 + 2); push(s0 + 2, s0 + m[0].length - 2, 'tok-del'); hide(s0 + m[0].length - 2, s0 + m[0].length);
  }
  for (const m of text.matchAll(/==([^=]+)==/g)) {
    const s0 = line.from + m.index;
    hide(s0, s0 + 2); push(s0 + 2, s0 + m[0].length - 2, 'tok-mark'); hide(s0 + m[0].length - 2, s0 + m[0].length);
  }
  for (const m of text.matchAll(/(?<!\*)\*([^*\n]+)\*(?!\*)/g)) {
    const s0 = line.from + m.index;
    hide(s0, s0 + 1); push(s0 + 1, s0 + m[0].length - 1, 'tok-em'); hide(s0 + m[0].length - 1, s0 + m[0].length);
  }
  for (const m of text.matchAll(/(?<!\x60)\x60([^\x60]+)\x60(?!\x60)/g)) {
    const s0 = line.from + m.index;
    hide(s0, s0 + 1); push(s0 + 1, s0 + m[0].length - 1, 'tok-code'); hide(s0 + m[0].length - 1, s0 + m[0].length);
  }
  for (const m of text.matchAll(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g)) {
    const s0 = line.from + m.index;
    linkHits.push({ from: s0, to: s0 + m[0].length, target: m[1], syntax: 'wiki' });
    hide(s0, s0 + 2); push(s0 + 2, s0 + 2 + m[1].length, 'tok-link'); hide(s0 + 2 + m[1].length, s0 + m[0].length);
  }
  for (const m of text.matchAll(/\[([^\]]+)\]\((<[^>]+>|(?:[^()]|\([^()]*\))+)\)/g)) {
    const s0 = line.from + m.index;
    if (s0 > line.from && text[m.index - 1] === '!') continue;
    linkHits.push({ from: s0, to: s0 + m[0].length, target: cleanLinkTarget(m[2]), syntax: 'md' });
    hide(s0, s0 + 1); push(s0 + 1, s0 + 1 + m[1].length, 'tok-link'); hide(s0 + 1 + m[1].length, s0 + m[0].length);
  }
}

function cleanLinkTarget(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  s = s.replace(/\s+["'][^"']*["']\s*$/, '').trim();
  return s;
}

function parseTableRow(text) {
  return text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\*\*/g, '').replace(/\x60/g, ''));
}

class TableWidget extends WidgetType {
  constructor(rows, from) { super(); this.rows = rows; this.from = from; }
  eq(o) { return o.from === this.from && JSON.stringify(o.rows) === JSON.stringify(this.rows); }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table-widget';
    const table = document.createElement('table');
    const head = this.rows[0] || [];
    const body = this.rows.slice(1);
    if (head.length) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      for (const c of head) { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); }
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    if (body.length) {
      const tbody = document.createElement('tbody');
      for (const r of body) {
        const tr = document.createElement('tr');
        for (const c of r) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    wrap.appendChild(table);
    wrap.onclick = () => view.dispatch({ selection: { anchor: this.from } });
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** 表格整块替换（block 装饰只能来自 StateField，不能来自 ViewPlugin） */
function tableDecos(state) {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const out = [];
  const stop = Math.min(doc.lines, 4000);
  for (let i = 1; i <= stop; i++) {
    const line = doc.line(i);
    if (!/^\s*\|/.test(line.text)) continue;
    let j = i;
    while (j <= stop && /^\s*\|/.test(doc.line(j).text)) j++;
    const last = j - 1;
    let hasSep = false;
    for (let k = i; k <= last; k++) {
      if (/^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/.test(doc.line(k).text)) hasSep = true;
    }
    const from = doc.line(i).from;
    const to = Math.min(doc.line(last).to + 1, doc.length);
    const touched = ranges.some((r) => r.from <= to && r.to >= from);
    if (hasSep && !touched && last > i) {
      const rows = [];
      for (let k = i; k <= last; k++) {
        const t = doc.line(k).text;
        if (/^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/.test(t)) continue;
        rows.push(parseTableRow(t));
      }
      out.push(Decoration.replace({ block: true, widget: new TableWidget(rows, from) }).range(from, to));
    }
    i = last;
  }
  return Decoration.set(out, true);
}

const tableField = StateField.define({
  create: (state) => tableDecos(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? tableDecos(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------- 声明式插件块（v1: video）
let PLUGINS = [];
let PLUGIN_BY_FENCE = new Map();
async function loadPluginDefs() {
  try {
    const r = await api.plugins();
    PLUGINS = (r && r.plugins) || [];
  } catch (e) { PLUGINS = []; }
  PLUGIN_BY_FENCE = new Map(PLUGINS.map((p) => [p.fence, p]));
  if (view) view.dispatch({ selection: { anchor: view.state.selection.main.anchor } });
}


// ---------------------------------------------------------------- 受信插件运行时（client.js）
const PLUGIN_CLIENTS = new Map();
const PLUGIN_COMMANDS = [];

function pluginPrelude(name) {
  return [
    '(function(){',
    'var P=' + JSON.stringify(name) + ';',
    'var seq=0, waits={};',
    'function send(type,payload){ parent.postMessage({__kbPlugin:1,plugin:P,type:type,payload:payload},"*"); }',
    'function call(type,payload){ return new Promise(function(res){ var id=++seq; waits[id]=res; parent.postMessage({__kbPlugin:1,plugin:P,id:id,type:type,payload:payload},"*"); }); }',
    'window.addEventListener("message",function(e){ var m=e.data||{}; if(m.__kbPluginResult && waits[m.id]){ var f=waits[m.id]; delete waits[m.id]; var p=m.payload; f(p && p.ok===true && Object.prototype.hasOwnProperty.call(p,"value") ? p.value : p); } if(m.__kbPluginEvent){ try{ window.dispatchEvent(new CustomEvent("kbplugin",{detail:m.payload})); }catch(_){} } });',
    'window.kbPlugin={version:1,',
    '  ui:{html:function(h){send("ui.html",{html:String(h)})},css:function(c){send("ui.css",{css:String(c)})},toast:function(t){send("ui.toast",{text:String(t)})}},',
    '  webview:{eval:function(c){return call("webview.eval",{code:String(c)})},css:function(c){return call("webview.css",{css:String(c)})},navigate:function(u){return call("webview.navigate",{url:String(u)})},getUrl:function(){return call("webview.getUrl",{})}},',
    '  commands:{register:function(c){send("commands.register",c)}},',
    '  on:function(fn){window.addEventListener("kbplugin",function(e){fn(e.detail)})}',
    '};',
    'send("ready",{api:typeof window.kbPlugin,node:typeof process,ipc:typeof window.kb});',
    '})();'
  ].join('\n');
}

function pluginReply(client, id, payload) {
  if (!client || !client.frame || !client.frame.contentWindow || id == null) return;
  client.frame.contentWindow.postMessage({ __kbPluginResult: 1, id, payload }, '*');
}

function pluginCaps(client) { return new Set((client && client.plugin && client.plugin.capabilities) || ['ui', 'webview', 'commands']); }

async function startPluginClients() {
  const host = document.getElementById('plugin-hosts');
  if (!host) return;
  for (const p of PLUGINS) {
    if (p.trusted === false || !p.client) continue;
    let r = null;
    try { r = await api.pluginCode(p.name); } catch (e) { r = null; }
    if (!r || !r.ok) { console.log('[plugin] ' + p.name + ' client 未加载：' + ((r && r.error) || 'NO-CODE')); continue; }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.dataset.plugin = p.name;
    frame.style.display = 'none';
    frame.title = 'plugin:' + p.name;
    host.appendChild(frame);
    const client = { plugin: p, frame };
    PLUGIN_CLIENTS.set(p.name, client);
    frame.srcdoc = '<!doctype html><meta charset="utf-8"><body><script>' + pluginPrelude(p.name) + '\n' + String(r.code) + '<\/script></body>';
  }
}

function pluginUiBox(name) {
  const root = document.getElementById('plugin-ui');
  let box = root.querySelector('[data-plugin-ui="' + name + '"]');
  if (!box) { box = document.createElement('div'); box.dataset.pluginUi = name; box.className = 'plugin-ui-box'; root.appendChild(box); }
  return box;
}

function pluginHandleMessage(ev) {
  const d = ev.data || {};
  if (!d || d.__kbPlugin !== 1) return;
  const client = PLUGIN_CLIENTS.get(String(d.plugin || ''));
  if (!client || client.frame.contentWindow !== ev.source) return;
  const caps = pluginCaps(client);
  const type = String(d.type || '');
  const p = d.payload || {};
  if (type === 'ready') { client.ready = p; return; }
  if (type === 'ui.html' && caps.has('ui')) { pluginUiBox(client.plugin.name).innerHTML = String(p.html || ''); return; }
  if (type === 'ui.css' && caps.has('ui')) {
    let st = document.getElementById('plugin-css-' + client.plugin.name);
    if (!st) { st = document.createElement('style'); st.id = 'plugin-css-' + client.plugin.name; document.head.appendChild(st); }
    st.textContent += String(p.css || ''); return;
  }
  if (type === 'ui.toast' && caps.has('ui')) { setStatus(String(p.text || ''), ''); return; }
  if (type === 'commands.register' && caps.has('commands')) {
    const c = p || {};
    const id = String(c.id || '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (!id) return;
    const full = 'plugin:' + client.plugin.name + ':' + id;
    if (!PLUGIN_COMMANDS.some((x) => x.id === full)) PLUGIN_COMMANDS.push({ id: full, title: String(c.title || id), hint: '插件 ' + client.plugin.name });
    return;
  }
  if (type === 'webview.eval' && caps.has('webview')) {
    if (!webVisible()) { pluginReply(client, d.id, { ok: false, error: 'WEBVIEW-CLOSED' }); return; }
    wv.executeJavaScript(String(p.code || '')).then((v) => pluginReply(client, d.id, { ok: true, value: v })).catch((e) => pluginReply(client, d.id, { ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (type === 'webview.css' && caps.has('webview')) {
    if (!webVisible()) { pluginReply(client, d.id, { ok: false, error: 'WEBVIEW-CLOSED' }); return; }
    wv.insertCSS(String(p.css || '')).then((k) => pluginReply(client, d.id, { ok: true, key: k })).catch((e) => pluginReply(client, d.id, { ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (type === 'webview.navigate' && caps.has('webview')) {
    const ok = openWeb(String(p.url || ''));
    pluginReply(client, d.id, { ok, url: ok ? normalizeWebUrl(p.url) : null });
    return;
  }
  if (type === 'webview.getUrl' && caps.has('webview')) {
    let url = ''; try { url = wv.getURL(); } catch (e) {}
    pluginReply(client, d.id, { ok: true, url });
  }
}
window.addEventListener('message', pluginHandleMessage);

function pluginFenceOf(text) {
  const m = /^\s*\x60\x60\x60\s*([A-Za-z0-9_-]+)\s*$/.exec(text);
  return m && PLUGIN_BY_FENCE.has(m[1]) ? m[1] : null;
}

function pluginDecos(state) {
  if (!PLUGIN_BY_FENCE.size) return Decoration.none;
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const out = [];
  const stop = Math.min(doc.lines, 4000);
  for (let i = 1; i <= stop; i++) {
    const fence = pluginFenceOf(doc.line(i).text);
    if (!fence) continue;
    let j = i + 1;
    while (j <= stop && !/^\s*\x60\x60\x60\s*$/.test(doc.line(j).text)) j++;
    if (j > stop) { i = stop; break; }
    const from = doc.line(i).from;
    const to = Math.min(doc.line(j).to + 1, doc.length);
    const touched = ranges.some((r) => r.from <= to && r.to >= from);
    if (!touched) {
      const body = [];
      for (let k = i + 1; k < j; k++) body.push(doc.line(k).text);
      out.push(Decoration.replace({ block: true, widget: new PluginWidget(PLUGIN_BY_FENCE.get(fence), body.join('\n'), current ? current.rel : '') }).range(from, to));
    }
    i = j;
  }
  return Decoration.set(out, true);
}

class PluginWidget extends WidgetType {
  constructor(plugin, body, fromRel) { super(); this.plugin = plugin; this.body = body; this.fromRel = fromRel; }
  eq(o) { return !!o && o.plugin.name === this.plugin.name && o.body === this.body && o.fromRel === this.fromRel; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'kb-plugin';
    const head = document.createElement('div');
    head.className = 'kb-plugin-head';
    head.textContent = this.plugin.title || this.plugin.name;
    wrap.appendChild(head);
    const parsed = pluginCore.parseBlock(this.body, this.plugin);
    if (!parsed.ok) {
      const err = document.createElement('div');
      err.className = 'kb-plugin-error';
      err.textContent = '插件块无效：' + parsed.errors.map((e) => (e.line ? '第' + e.line + '行 ' : '') + e.message).join('；');
      wrap.appendChild(err);
      return wrap;
    }
    if (this.plugin.component === 'video') this.buildVideo(wrap, parsed.values);
    return wrap;
  }
  buildVideo(wrap, vals) {
    const box = document.createElement('div');
    box.className = 'kb-plugin-body';
    const video = document.createElement('video');
    video.className = 'kb-video';
    video.controls = vals.controls !== false;
    video.loop = !!vals.loop;
    video.muted = !!vals.muted;
    video.autoplay = !!vals.autoplay;
    if (video.autoplay && !video.muted) video.muted = true;   // Chromium 自动播放策略
    video.preload = 'metadata';
    if (vals.title) video.title = vals.title;
    box.appendChild(video);
    wrap.appendChild(box);
    const warn = (msg) => {
      const el = document.createElement('div');
      el.className = 'kb-plugin-warn';
      el.textContent = msg;
      wrap.appendChild(el);
    };
    const fail = (msg) => {
      const el = document.createElement('div');
      el.className = 'kb-plugin-error';
      el.textContent = msg;
      wrap.appendChild(el);
    };
    const apply = async (target, fallbackMode) => {
      if (/^https?:/i.test(target)) { video.src = target; return true; }
      const r = await api.assetUrl(target, this.fromRel);
      if (r && r.ok) { video.src = r.url; return true; }
      const why = (r && r.error) || 'ASSET-NOT-FOUND';
      if (!fallbackMode) fail('本地视频不可用：' + why + '（' + target + '）');
      return false;
    };
    if (vals.poster) {
      if (/^https?:/i.test(vals.poster)) video.poster = vals.poster;
      else api.assetUrl(vals.poster, this.fromRel).then((r) => { if (r && r.ok) video.poster = r.url; });
    }
    let triedFallback = false;
    video.addEventListener('error', async () => {
      if (triedFallback) return;
      triedFallback = true;
      if (vals.fallback) {
        const ok = await apply(vals.fallback, true);
        if (ok) { warn('在线视频加载失败，已回退到本地快照'); return; }
      }
      warn('视频加载失败：在线源不可用' + (vals.fallback ? '，本地回退也不可用' : '（没有配置本地回退）'));
    });
    apply(vals.src, false);
  }
}

const pluginField = StateField.define({
  create: (state) => pluginDecos(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? pluginDecos(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const livePreview = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = this.build(v); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
  build(v) {
    const doc = v.state.doc;
    const cursorLines = new Set();
    for (const r of v.state.selection.ranges) {
      cursorLines.add(doc.lineAt(r.from).number);
      if (!r.empty) cursorLines.add(doc.lineAt(r.to).number);
    }
    const decos = [];
    linkHits = [];
    const fmEnd = fmEndOf(doc);
    const touched = fmEnd > 0 && v.state.selection.ranges.some((r) => (r.empty ? r.from > 0 && r.from < fmEnd : r.from < fmEnd && r.to > 0));
    if (fmEnd > 0 && !touched) {
      let pos = 0;
      while (pos < fmEnd) {
        const line = doc.lineAt(pos);
        decos.push(Decoration.line({ class: 'cm-fm-hidden' }).range(line.from));
        if (line.to >= fmEnd) break;
        pos = line.to + 1;
      }
    }
    const stop = Math.min(doc.lines, 4000);
    const startLine = fmEnd > 0 ? doc.lineAt(Math.min(fmEnd, doc.length)).number : 1;
    let inFence = false;
    for (let i = startLine; i <= stop; i++) {
      const line = doc.line(i);
      if (!inFence && /^\s*\|/.test(line.text)) {
        let j = i;
        while (j <= stop && /^\s*\|/.test(doc.line(j).text)) j++;
        i = j - 1;
        continue;
      }
      if (pluginFenceOf(line.text)) {
        let j = i + 1;
        while (j <= stop && !/^\s*\x60\x60\x60\s*$/.test(doc.line(j).text)) j++;
        i = j;
        continue;
      }
      if (/^\s*\x60\x60\x60/.test(line.text)) {
        const cls = cursorLines.has(i) ? 'cm-fence' : 'cm-fence-hidden';
        decos.push(Decoration.line({ class: cls }).range(line.from));
        inFence = !inFence;
        continue;
      }
      if (inFence) { decos.push(Decoration.line({ class: 'cm-codeblock' }).range(line.from)); continue; }
      lineDecos(doc, i, decos, cursorLines.has(i));
    }
    decos.sort((x, y) => x.from - y.from || x.value.startSide - y.value.startSide);
    return Decoration.set(decos, true);
  }
}, { decorations: (v) => v.decorations });

// ---------------------------------------------------------------- 补全
async function linkSource(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 80), ctx.pos);
  const m = /\[\[([^\]\n]*)$/.exec(before);
  if (!m) return null;
  const list = await api.complete('link', m[1]);
  return { from: ctx.pos - m[1].length, options: list.map((x) => ({ label: x.path, detail: x.title })), validFor: /^[^\]\n]*$/ };
}

async function tagSource(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 60), ctx.pos);
  const m = /(?:^|\s)#([\p{L}\p{N}_\/-]*)$/u.exec(before);
  if (!m) return null;
  const list = await api.complete('tag', m[1]);
  return { from: ctx.pos - m[1].length, options: list.map((t) => ({ label: t })), validFor: /^[\p{L}\p{N}_\/-]*$/u };
}

// ---------------------------------------------------------------- 链接：悬浮预览 / 左键跳转 / 中键新窗口
let peekTimer = null;
let peekKey = null;

function hidePeek() {
  const el = document.getElementById('peek');
  if (el) el.classList.add('hidden');
  peekKey = null;
}

function hitAt(v, x, y) {
  if (!linkHits.length) return null;
  let pos = null;
  try { pos = v.posAtCoords({ x, y }); } catch (e) { return null; }
  if (pos == null) return null;
  return linkHits.find((h) => pos >= h.from && pos <= h.to) || null;
}

function peekHtml(r, fallback) {
  if (r.kind === 'blocked') {
    return '<div class="peek-title">链接已拒绝</div><div class="peek-path">' + esc(r.target || fallback)
      + '</div><div class="peek-meta">' + esc(r.excerpt || r.reason || '') + '</div>';
  }
  if (r.kind === 'external') {
    const hint = r.scheme === 'mail'
      ? '左键用邮件客户端打开（不进内置浏览器）'
      : '左键内置浏览器打开 · Ctrl/中键用系统浏览器';
    return '<div class="peek-title">外部链接</div><div class="peek-path">' + esc(r.url)
      + '</div><div class="peek-meta">' + esc(hint) + '</div>';
  }
  if (r.kind === 'missing') {
    return '<div class="peek-title">未找到目标</div><div class="peek-missing">' + esc(r.target || fallback)
      + '</div><div class="peek-meta">库内没有匹配的文档</div>';
  }
  const meta = [r.type, r.status].filter(Boolean).join(' · ');
  return '<div class="peek-title">' + esc(r.title) + '</div>'
    + '<div class="peek-path">' + esc(r.path) + '</div>'
    + (r.excerpt ? '<div class="peek-excerpt">' + esc(r.excerpt) + '</div>' : '')
    + '<div class="peek-meta">' + esc(meta) + (meta ? ' · ' : '') + '反链 ' + r.backlinks + ' · 左键跳转 / 中键新窗口</div>';
}

async function showPeek(hit, x, y) {
  if (String(hit.target || '').startsWith('welcome:')) {
    const id = hit.target.slice('welcome:'.length);
    const d = WELCOME_DOCS.find((x) => x.id === id);
    const el = document.getElementById('peek');
    el.innerHTML = '<div class="peek-title">' + esc((d && d.title) || id) + '</div>'
      + '<div class="peek-meta">内置文档 · 左键打开</div>';
    el.classList.remove('hidden');
    const rect = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x + 16, window.innerWidth - rect.width - 14)) + 'px';
    el.style.top = (y + 18 + rect.height > window.innerHeight ? Math.max(8, y - rect.height - 14) : y + 18) + 'px';
    return;
  }
  const rel = current ? current.rel : null;
  const r = await api.peek(hit.target, rel);
  if (!r || !r.ok) return;
  const el = document.getElementById('peek');
  el.innerHTML = peekHtml(r, hit.target);
  el.classList.remove('hidden');
  const rect = el.getBoundingClientRect();
  const left = Math.min(x + 16, window.innerWidth - rect.width - 14);
  const top = (y + 18 + rect.height > window.innerHeight) ? Math.max(8, y - rect.height - 14) : y + 18;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = top + 'px';
}

async function openLinkTarget(hit, newWindow) {
  if (!hit) return { ok: false, error: 'NO-HIT' };
  if (String(hit.target || '').startsWith('welcome:')) {
    const id = hit.target.slice('welcome:'.length);
    await openWelcome(current && current.lang, id);
    return { ok: true, kind: 'welcome', id };
  }
  const rel = current ? current.rel : null;
  const r = await api.peek(hit.target, rel);
  if (!r || !r.ok) { setStatus('无法解析链接：' + hit.target, ''); return { ok: false, error: 'PEEK-FAILED' }; }
  if (r.kind === 'blocked') {
    setStatus('链接已拒绝：' + (r.excerpt || r.reason || hit.target), '');
    return { ok: false, kind: 'blocked', reason: r.reason };
  }
  if (r.kind === 'external') {
    if (newWindow || r.scheme === 'mail') {
      const res = await api.openExternal(r.url);
      if (!res || !res.ok) {
        setStatus('无法打开外部链接：' + ((res && res.error) || '未知错误'), '');
        return { ok: false, kind: 'external', error: (res && res.error) || 'OPEN-FAILED' };
      }
      return { ok: true, kind: 'external', url: r.url, mode: 'system' };
    }
    openWeb(r.url);
    return { ok: true, kind: 'external', url: r.url, mode: 'internal' };
  }
  if (r.kind === 'missing') { setStatus('链接目标不存在：' + hit.target, ''); return { ok: false, kind: 'missing' }; }
  if (newWindow) {
    const w = await api.openWindow(r.path);
    return { ok: true, kind: 'window', path: r.path, windows: w && w.windows };
  }
  await openDoc(r.path);
  return { ok: true, kind: 'internal', path: r.path };
}

function linkMouseMove(e, v) {
  const hit = hitAt(v, e.clientX, e.clientY);
  if (!hit) {
    if (peekKey) hidePeek();
    clearTimeout(peekTimer);
    v.dom.style.cursor = '';
    return;
  }
  v.dom.style.cursor = 'pointer';
  const key = hit.target + '@' + hit.from;
  if (key === peekKey) return;
  peekKey = key;
  clearTimeout(peekTimer);
  const x = e.clientX, y = e.clientY;
  peekTimer = setTimeout(() => { showPeek(hit, x, y); }, 260);
}

function linkMouseDown(e, v) {
  const hit = hitAt(v, e.clientX, e.clientY);
  if (!hit) return false;
  if (e.button === 1) { e.preventDefault(); openLinkTarget(hit, true); return true; }
  if (e.button === 0) { e.preventDefault(); openLinkTarget(hit, e.ctrlKey || e.metaKey); return true; }
  return false;
}

// ---------------------------------------------------------------- 编辑器
function setStatus(left, right) {
  document.getElementById('status-left').textContent = left || '';
  if (right != null) document.getElementById('status-right').textContent = right;
}

async function updateCommitter(rel) {
  const el = document.getElementById('status-mid');
  if (!el) return;
  if (!rel) { el.textContent = ''; return; }
  try {
    const r = await api.lastCommit(rel);
    const c = r && r.commit;
    el.textContent = c ? '最后提交：' + c.author + ' · ' + String(c.date || '').slice(0, 10) : '';
    el.title = c ? (c.sha + ' ' + c.author + ' ' + c.date) : '';
  } catch (e) { el.textContent = ''; }
}

function showBanner(msg) {
  const b = document.getElementById('banner');
  b.textContent = msg;
  b.classList.remove('hidden');
}
function hideBanner() {
  const b = document.getElementById('banner');
  if (b) b.classList.add('hidden');
}

let dirtySent = false;
function syncDirty(v) {
  dirty = !!v;
  if (dirtySent !== dirty) { dirtySent = dirty; try { api.setDirty(dirty); } catch (e) { /* 主进程不在也无妨 */ } }
}

let autoTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { if (dirty && current) saveCurrent(); }, 1200);
}

function docChars(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\s/g, '').length;
}
function statsRight(blCount) {
  const n = view ? docChars(view.state.doc.toString()) : 0;
  return n + ' 字' + (blCount != null ? ' · 反链 ' + blCount + ' 条' : '');
}

/** 应用内输入对话框（Electron 不支持 window.prompt） */
function askText(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const box = document.getElementById('dialog');
    const title = box.querySelector('.dlg-title');
    const input = document.getElementById('dialog-input');
    const okBtn = document.getElementById('dialog-ok');
    const cancelBtn = document.getElementById('dialog-cancel');
    title.textContent = o.title || '输入';
    input.value = o.value || '';
    input.placeholder = o.placeholder || '';
    box.classList.remove('hidden');
    input.focus();
    input.select();
    const done = (v) => {
      box.classList.add('hidden');
      okBtn.onclick = null; cancelBtn.onclick = null; input.onkeydown = null;
      resolve(v);
    };
    okBtn.onclick = () => done(input.value.trim());
    cancelBtn.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
  });
}

function buildEditor(parent) {
  const state = EditorState.create({
    doc: '',
    extensions: [
      history(), readOnlyComp.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
      markdown({ codeLanguages: languages }), drawSelection(), EditorView.lineWrapping,
      syntaxHighlighting(kbHighlight),
      tableField,
      pluginField,
      livePreview,
      autocompletion({ override: [linkSource, tagSource], activateOnTyping: true }),
      search({ top: true }), highlightSelectionMatches(),
      EditorView.domEventHandlers({
        mousedown: linkMouseDown,
        mousemove: linkMouseMove,
        mouseleave: () => { hidePeek(); return false; },
      }),
      // 全局快捷键统一由 document keydown 处理（见 registerEvents），这里只留编辑器内建键位
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) saveSession();
        if (u.docChanged) { syncDirty(true); setStatus('未保存…', statsRight()); scheduleAutoSave(); saveSession(); }
      }),
      EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-content': { caretColor: '#fff' } }),
    ],
  });
  view = new EditorView({ state, parent });
  view.scrollDOM.addEventListener('scroll', () => hidePeek());
  return view;
}

// ---------------------------------------------------------------- 文件树
function renderTree(node, container, depth) {
  for (const d of node.dirs) {
    const det = document.createElement('details');
    det.className = 'dir'; det.open = depth < 1;
    const sum = document.createElement('summary');
    sum.textContent = d.name;
    det.appendChild(sum);
    const inner = document.createElement('div');
    renderTree(d, inner, depth + 1);
    det.appendChild(inner);
    container.appendChild(det);
  }
  for (const f of node.files) {
    const el = document.createElement('div');
    el.className = 'file'; el.dataset.path = f.path;
    el.textContent = f.title || f.path.split('/').pop();
    if (!f.type) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '无头'; el.appendChild(b); }
    el.onclick = () => openDoc(f.path);
    container.appendChild(el);
  }
}

async function refreshTree() {
  const tree = await api.tree();
  const box = document.getElementById('tree');
  box.innerHTML = '';
  renderTree(tree, box, 0);
}

// ---------------------------------------------------------------- 文档打开 / 属性
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: null, body: text };
  return { fm: m[1], body: text.slice(m[0].length) };
}

const EDITABLE = new Set(['type', 'title', 'description', 'tags', 'status', 'aliases', 'stale_after', 'owner', 'source_checked']);

function setFmField(text, name, value) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return '---\n' + name + ': ' + value + '\n---\n' + text;
  const lines = m[1].split('\n');
  const hit = lines.findIndex((l) => l.startsWith(name + ':'));
  if (hit >= 0) lines[hit] = name + ': ' + value; else lines.push(name + ': ' + value);
  return '---\n' + lines.join('\n') + '\n---\n' + text.slice(m[0].length);
}

function tagsToPills(value, cell) {
  const items = value.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  for (const t of items) {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = t;
    cell.appendChild(pill);
  }
}

function propRow(name, value, missing) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.dataset.field = name;
  const k = document.createElement('div');
  k.className = 'prop-key';
  k.textContent = name;
  const v = document.createElement('div');
  v.className = 'prop-value';
  const structured = !EDITABLE.has(name);
  if (structured) v.classList.add('static');
  if (!value) v.classList.add('empty');
  if (name === 'tags' && value) tagsToPills(value, v);
  else v.textContent = structured ? (value || '（结构化字段）') : (value || '空');
  if (!structured) v.onclick = () => editPropInline(name, value, v);
  row.append(k, v);
  const tools = document.createElement('div');
  tools.className = 'prop-tools';
  const mk = (icon, label, fn) => {
    const b = document.createElement('button');
    b.className = 'prop-tool';
    b.innerHTML = svgIcon(icon);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  tools.append(
    mk('copy', '复制条目', () => copyEntry(name, value)),
    mk('history', '历史版本', () => openEntryPanel(name)),
    mk('tag', '条目标签', () => openEntryPanel(name, true)),
  );
  row.appendChild(tools);
  row.onclick = (e) => {
    if (e.target.closest('.prop-value') || e.target.closest('.prop-tools')) return;
    openEntryPanel(name);
  };
  k.title = '查看历史版本';
  k.onclick = (e) => { e.stopPropagation(); openEntryPanel(name); };
  return row;
}

// ---------------------------------------------------------------- 条目侧栏（历史 / 标签）
let entryField = null;
async function copyEntry(name, value) {
  await api.copy(name + ': ' + (value || ''));
  setStatus('已复制条目 ' + name, 'ok');
  return true;
}
function closeEntryPanel() {
  entryField = null;
  const p = document.getElementById('entrypanel');
  const m = document.getElementById('main');
  if (m) m.classList.remove('entry-open');
  if (p) { p.classList.add('hidden'); p.classList.remove('open'); }
}
async function openEntryPanel(field, focusTag) {
  if (!current) return { ok: false, error: 'NO-DOC' };
  entryField = field;
  const panel = document.getElementById('entrypanel');
  panel.classList.remove('hidden');
  document.getElementById('main').classList.add('entry-open');
  requestAnimationFrame(() => panel.classList.add('open'));
  document.getElementById('ep-title').textContent = '条目 · ' + field;
  document.getElementById('ep-path').textContent = current.rel;
  await refreshEntryPanel();
  if (focusTag) {
    const inp = document.getElementById('ep-tag-input');
    if (inp) inp.focus();
  }
  return { ok: true };
}
async function refreshEntryPanel() {
  if (!current || !entryField) return;
  const tags = await api.entryTags(current.rel, entryField);
  renderEntryTags(tags);
  const hist = await api.propHistory(current.rel, entryField);
  renderEntryHistory(hist);
}
function renderEntryTags(t) {
  const box = document.getElementById('ep-tags');
  box.innerHTML = '';
  const line = (label, list, own) => {
    const row = document.createElement('div');
    row.className = 'ep-tag-row';
    const k = document.createElement('span');
    k.className = 'ep-tag-label';
    k.textContent = label;
    row.appendChild(k);
    for (const tag of (list || [])) {
      const pill = document.createElement('span');
      pill.className = 'ep-tag ' + (own ? 'own' : 'inherit');
      pill.textContent = tag;
      if (own) {
        pill.title = '点击移除专属标签';
        pill.onclick = async () => {
          const next = (t.own || []).filter((x) => x !== tag);
          await api.setEntryTags(current.rel, entryField, next);
          await refreshEntryPanel();
        };
      } else {
        pill.title = '继承自文件 tags';
      }
      row.appendChild(pill);
    }
    if (!(list || []).length) {
      const none = document.createElement('span');
      none.className = 'ep-tag-none';
      none.textContent = '无';
      row.appendChild(none);
    }
    box.appendChild(row);
  };
  line('继承', t.inherited, false);
  line('专属', t.own, true);
  const add = document.createElement('div');
  add.className = 'ep-tag-add';
  const inp = document.createElement('input');
  inp.id = 'ep-tag-input';
  inp.placeholder = '添加专属标签，回车';
  inp.spellcheck = false;
  inp.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    const v = inp.value.trim();
    if (!v) return;
    const next = [...new Set([...(t.own || []), v])];
    await api.setEntryTags(current.rel, entryField, next);
    await refreshEntryPanel();
    const ni = document.getElementById('ep-tag-input');
    if (ni) ni.focus();
  };
  add.appendChild(inp);
  box.appendChild(add);
}
function renderEntryHistory(h) {
  const box = document.getElementById('ep-history');
  box.innerHTML = '';
  document.getElementById('ep-count').textContent = h && h.ok ? String(h.count) : '';
  if (!h || !h.ok) { box.innerHTML = '<div class="ep-empty">读取历史失败</div>'; return; }
  if (!h.items.length) { box.innerHTML = '<div class="ep-empty">没有历史版本</div>'; return; }
  for (const it of h.items) {
    const el = document.createElement('div');
    el.className = 'ep-item';
    const meta = document.createElement('div');
    meta.className = 'ep-meta';
    meta.textContent = it.sha7 + ' · ' + String(it.date || '').slice(0, 10) + ' · ' + (it.author || '');
    const val = document.createElement('div');
    val.className = 'ep-val';
    const cur = it.value == null || it.value === '' ? '（空）' : it.value;
    if (it.prev == null) {
      val.textContent = cur;
    } else {
      const old = it.prev === '' ? '（空）' : it.prev;
      val.textContent = old + ' → ' + cur;
    }
    el.append(meta, val);
    box.appendChild(el);
  }
}

function renderProps(text) {
  const { fm } = parseFrontmatter(text);
  const box = document.getElementById('props');
  box.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'props-block';
  const head = document.createElement('div');
  head.className = 'props-head';
  head.textContent = '属性';
  if (localStorage.getItem('kb:propsCollapsed') !== '0') block.classList.add('collapsed');
  head.onclick = () => {
    block.classList.toggle('collapsed');
    localStorage.setItem('kb:propsCollapsed', block.classList.contains('collapsed') ? '1' : '0');
  };
  block.appendChild(head);
  const propList = document.createElement('div');
  propList.className = 'props-list';
  block.appendChild(propList);
  const rows = [];
  if (fm) {
    for (const raw of fm.split('\n')) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
      if (m) rows.push({ name: m[1], value: m[2].trim() });
    }
  }
  const present = new Set(rows.map((r) => r.name));
  const REQ = ['type', 'generated', 'source_checked'];
  for (const r of rows) {
    if (!REQ.includes(r.name) && !r.value) continue;   // 空的可选属性不占行
    propList.appendChild(propRow(r.name, r.value, false));
  }
  for (const req of REQ) {
    if (!present.has(req)) propList.appendChild(propRow(req, '', true));
  }
  const add = document.createElement('div');
  add.className = 'prop-add';
  add.innerHTML = svgIcon('add') + '<span>添加属性</span>';
  add.onclick = () => addProperty(propList);
  propList.appendChild(add);
  box.appendChild(block);
}

async function editPropInline(name, value, cell) {
  if (cell.querySelector('input')) return;
  const kind = name === 'tags' ? 'tag' : name === 'type' ? 'type' : null;
  const list = kind ? await api.complete(kind, '') : (name === 'status' ? ['draft', 'stable', 'deprecated', 'archived'] : []);
  const input = document.createElement('input');
  input.value = name === 'tags' ? value.replace(/[\[\]"]/g, '').replace(/\s*,\s*/g, ', ') : value;
  if (list.length) {
    const dl = document.createElement('datalist');
    dl.id = 'dl-prop-' + name;
    for (const t of list) { const o = document.createElement('option'); o.value = t; dl.appendChild(o); }
    document.body.appendChild(dl);
    input.setAttribute('list', dl.id);
  }
  cell.textContent = '';
  cell.classList.remove('empty');
  cell.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const raw = input.value.trim();
    let v = raw;
    if (name === 'tags') v = '[' + raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean).join(', ') + ']';
    const next = setFmField(view.state.doc.toString(), name, v);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    renderProps(next);
    saveCurrent();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') renderProps(view.state.doc.toString());
  };
  input.onblur = () => { if (input.isConnected) renderProps(view.state.doc.toString()); };
}

async function addProperty(block) {
  const fields = await api.complete('field', '');
  const row = document.createElement('div');
  row.className = 'prop-row';
  const k = document.createElement('div');
  k.className = 'prop-key';
  const nameInput = document.createElement('input');
  nameInput.placeholder = '属性名';
  nameInput.style.minWidth = '110px';
  if (fields.length) {
    const dl = document.createElement('datalist');
    dl.id = 'dl-add-field';
    for (const f of fields) { const o = document.createElement('option'); o.value = f; dl.appendChild(o); }
    document.body.appendChild(dl);
    nameInput.setAttribute('list', dl.id);
  }
  const v = document.createElement('div');
  v.className = 'prop-value';
  const valInput = document.createElement('input');
  valInput.placeholder = '值';
  k.appendChild(nameInput);
  v.appendChild(valInput);
  row.append(k, v);
  block.insertBefore(row, block.querySelector('.prop-add'));
  nameInput.focus();
  const commit = () => {
    const n = nameInput.value.trim();
    const val = valInput.value.trim();
    if (!/^[A-Za-z_][\w-]*$/.test(n) || !val) return;
    const next = setFmField(view.state.doc.toString(), n, n === 'tags' ? '[' + val + ']' : val);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    renderProps(next);
    saveCurrent();
  };
  for (const el of [nameInput, valInput]) {
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') renderProps(view.state.doc.toString());
    };
  }
}

// ---------------------------------------------------------------- 会话持久化
const SESSION_KEY = 'kb:session';

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      docs: openDocs.filter((x) => !isWelcomeRel(x)),
      active: current && !isWelcomeRel(current.rel) ? current.rel : null,
      cursor: view ? view.state.selection.main.head : 0,
      scroll: view ? view.scrollDOM.scrollTop : 0,
    }));
  } catch (e) { /* 存储不可用就算了 */ }
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}

// ---------------------------------------------------------------- 标签页
let openDocs = [];

function renderTabs() {
  const bar = document.getElementById('tabs');
  if (!bar) return;
  bar.innerHTML = '';
  for (const rel of openDocs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (current && current.rel === rel ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = isWelcomeRel(rel) ? welcomeTitle(rel) : rel.split('/').pop().replace(/\.md$/, '');
    name.title = rel;
    const x = document.createElement('span');
    x.className = 'tab-close';
    x.innerHTML = svgIcon('close');
    x.title = '关闭标签';
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', '关闭标签 ' + name.textContent);
    x.onclick = (e) => { e.stopPropagation(); closeTab(rel); };
    tab.append(name, x);
    tab.onclick = () => openDoc(rel);
    bar.appendChild(tab);
  }
}

async function closeTab(rel) {
  if (current && current.rel === rel && dirty) await saveCurrent();
  openDocs = openDocs.filter((r) => r !== rel);
  if (current && current.rel === rel) {
    const next = openDocs[openDocs.length - 1];
    if (next) { openDoc(next); return; }
    current = null;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
    document.getElementById('props').innerHTML = '';
    document.getElementById('crumb').textContent = '';
  }
  renderTabs();
  saveSession();
}

async function renderBacklinks(rel) {
  const listEl = document.getElementById('backlinks');
  if (!rel) { if (listEl) listEl.innerHTML = '<div class="bl" style="color:var(--dim)">（无入链）</div>'; const c0 = document.getElementById('bl-count'); if (c0) c0.textContent = '0'; return []; }
  const cnt = document.getElementById('bl-count');
  if (!listEl) return [];
  const bl = await api.backlinks(rel);
  listEl.innerHTML = '';
  if (cnt) cnt.textContent = String(bl.length);
  for (const b of bl) {
    const el = document.createElement('div');
    el.className = 'bl';
    el.dataset.path = b.path;
    el.textContent = b.title + '  ·' + b.count;
    el.title = b.path;
    el.onclick = () => openDoc(b.path);
    listEl.appendChild(el);
  }
  if (!bl.length) {
    const d = document.createElement('div');
    d.className = 'bl'; d.textContent = '（无入链）'; d.style.color = 'var(--dim)';
    listEl.appendChild(d);
  }
  return bl;
}

async function openWelcome(lang, id) {
  if (dirty && current && !current.welcome) await saveCurrent();
  const want = lang || pickWelcomeLang();
  const docId = id || (current && current.welcome && current.id) || '00-intro';
  const res = await api.welcome(want, docId);
  if (!res || !res.ok) { setStatus('介绍文档读取失败：' + ((res && res.error) || ''), ''); return null; }
  localStorage.setItem('kb:lang', res.lang);
  localStorage.setItem('kb:welcomeSeen', '1');
  WELCOME_DOCS = res.docs || [];
  WELCOME_DOC_TITLES = {};
  for (const d of WELCOME_DOCS) WELCOME_DOC_TITLES[welcomeRelForId(d.id)] = d.title;
  const rel = welcomeRelForId(res.id);
  const title = res.title || WELCOME_TITLES[res.lang] || '介绍';
  current = { rel, mtime: 0, text: res.text, welcome: true, lang: res.lang, id: res.id, title };
  dirty = false;
  document.querySelectorAll('.file').forEach((e) => e.classList.remove('active'));
  document.getElementById('crumb').textContent = title;
  document.getElementById('props').innerHTML = '';
  if (!openDocs.includes(rel)) openDocs.push(rel);
  renderTabs();
  renderWelcomeBar(res.langs, res.lang, res.id);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: res.text },
    effects: readOnlyComp.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
  });
  view.dispatch({ selection: { anchor: 0 } });
  view.scrollDOM.scrollTop = 0;
  renderBacklinks(null);
  syncDirty(false);
  hideBanner();
  updateCommitter(null);
  if (api.setTitle) api.setTitle(title);
  setStatus('内置文档：' + title + '（只读 · Read-only）', '');
  saveSession();
  return res;
}

function renderWelcomeBar(langs, lang, id) {
  const bar = document.getElementById('welcomebar');
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  for (const l of langs || []) {
    const b = document.createElement('button');
    b.className = 'lang-btn' + (l.code === lang ? ' active' : '');
    b.textContent = l.name;
    b.onclick = () => openWelcome(l.code, id);
    bar.appendChild(b);
  }
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '只读 · Read-only';
  bar.appendChild(hint);
}

async function openDoc(rel) {
  closeEntryPanel();
  if (isWelcomeRel(rel)) return openWelcome(null, welcomeIdFromRel(rel));
  if (dirty && current) await saveCurrent();
  const { text, mtime } = await api.read(rel);
  current = { rel, mtime, text };
  dirty = false;
  document.querySelectorAll('.file').forEach((e) => e.classList.toggle('active', e.dataset.path === rel));
  document.getElementById('crumb').textContent = rel;
  if (!openDocs.includes(rel)) openDocs.push(rel);
  renderTabs();
  renderProps(text);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: readOnlyComp.reconfigure([EditorState.readOnly.of(false), EditorView.editable.of(true)]) });
  document.getElementById('welcomebar').classList.add('hidden');
  const bodyStart = Math.min(fmEndOf(view.state.doc), view.state.doc.length);
  if (bodyStart > 0) view.dispatch({ selection: { anchor: bodyStart } });
  const bl = await renderBacklinks(rel);
  syncDirty(false);
  hideBanner();
  if (api.setTitle) api.setTitle(rel.split('/').pop().replace(/\.md$/, ''));
  setStatus('已打开 ' + rel, statsRight(bl.length));
  updateCommitter(rel);
  saveSession();
}

async function saveCurrent() {
  if (!current) return { ok: false, error: 'NO-DOC' };
  if (current.welcome) return { ok: false, error: 'READONLY' };
  const text = view.state.doc.toString();
  const res = await api.save(current.rel, text, current.mtime);
  if (res && res.ok) {
    current.mtime = res.mtime;
    current.text = res.text || text;
    syncDirty(false);
    hideBanner();
    renderProps(current.text);
    const bl = await renderBacklinks(current.rel);
    const t = new Date();
    setStatus('已保存 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), statsRight(bl.length));
    updateCommitter(current.rel);
    refreshTree();
  } else {
    syncDirty(true);
    const why = (res && (res.error || res.reason)) || '未知原因';
    showBanner('保存被拒：' + why + ' —— 修改仍在编辑器里，按 Ctrl+S 重试；关窗口前会被拦下');
    setStatus('保存被拒：' + why, '');
  }
  return res;
}

async function checkCurrentDoc() {
  if (!current || isWelcomeRel(current.rel)) { setStatus('先打开一篇知识库文档再检查', ''); return null; }
  const r = await api.check(current.rel);
  const panel = document.getElementById('checkpanel');
  const summary = document.getElementById('check-summary');
  const list = document.getElementById('check-list');
  list.innerHTML = '';
  if (!r || !r.ok) {
    summary.textContent = '检查失败：' + ((r && (r.error || r.raw)) || '未知错误');
    panel.classList.remove('hidden');
    return r;
  }
  const counts = r.counts || { errors: 0, warns: 0 };
  summary.textContent = (r.checkers || []).join('、') + ' · ' + counts.errors + ' 个错误 / ' + counts.warns + ' 个警告（gate=' + r.gate + '）';
  if (!r.findings || !r.findings.length) {
    const el = document.createElement('div');
    el.className = 'check-empty';
    el.textContent = '检查通过，没有发现问题。';
    list.appendChild(el);
  } else {
    for (const f of r.findings) {
      const row = document.createElement('div');
      row.className = 'check-row ' + (f.level === 'error' ? 'error' : 'warn');
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = f.code || f.level;
      row.appendChild(code);
      row.appendChild(document.createTextNode((f.line ? '第 ' + f.line + ' 行 · ' : '') + (f.message || '')));
      list.appendChild(row);
    }
  }
  panel.classList.remove('hidden');
  return r;
}

function runShortcut(k) {
  const acts = {
    p: () => { if (paletteOpen()) closePalette(); else openPalette(); },
    s: () => saveCurrent(),
    n: () => newNote(),
    o: () => openSwitcher(),
    w: () => { if (current) closeTab(current.rel); },
    f: () => { if (view) openSearchPanel(view); },
    'shift+f': () => focusSearch(),
    'shift+k': () => checkCurrentDoc(),
  };
  if (!acts[k]) return false;
  acts[k]();
  return true;
}

// ---------------------------------------------------------------- 命令面板
let paletteItems = [];
let paletteLeaveTimer = null;
function paletteOpen() { return !document.getElementById('palette').classList.contains('hidden'); }
function closePalette() {
  clearTimeout(paletteLeaveTimer);
  document.getElementById('palette').classList.add('hidden');
  if (view) view.focus();
}
async function openPalette() {
  const box = document.getElementById('palette');
  box.classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = ''; input.focus();
  paletteItems = [...(await api.commands()), ...PLUGIN_COMMANDS];
  renderPalette('');
}
function renderPalette(q) {
  const list = document.getElementById('palette-list');
  list.innerHTML = '';
  const lower = q.toLowerCase();
  const shown = paletteItems.filter((c) => c.title.toLowerCase().includes(lower) || c.id.includes(lower));
  shown.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'item' + (i === 0 ? ' sel' : '');
    el.innerHTML = '<span>' + c.title + '</span><span class=\'hint\'>' + (c.hint || '') + '</span>';
    el.onclick = () => runCommand(c.id);
    list.appendChild(el);
  });
}
async function runCommand(id) {
  document.getElementById('palette').classList.add('hidden');
  if (String(id).startsWith('plugin:')) {
    const parts = String(id).split(':');
    const c = PLUGIN_CLIENTS.get(parts[1]);
    if (c && c.frame.contentWindow) c.frame.contentWindow.postMessage({ __kbPluginEvent: 1, payload: { type: 'command', id: parts.slice(2).join(':') } }, '*');
    return;
  }
  if (id === 'save') return saveCurrent();
  if (id === 'search') return openSearch();
  if (id === 'new') return newNote();
  if (id === 'rename') return renameCurrent();
  if (id === 'welcome') return openWelcome();
  if (id === 'lang') return openWelcome((current && current.lang === 'zh-CN') ? 'en-US' : 'zh-CN');
  if (id === 'checkdoc') return checkCurrentDoc();
  if (id === 'openurl') { const u = await askText({ title: '打开网址', placeholder: 'https://…' }); if (u) openWeb(u); return; }
  if (id === 'webclear') { const res = await api.webClear(); setStatus(res && res.ok ? '已清除内置浏览器数据' : '清除失败：' + (res && res.error), ''); return; }
  const res = await api.run({ id, rel: current && current.rel, text: view.state.doc.toString() });
  setStatus(res && res.ok ? '命令完成：' + id : '命令失败：' + id, (res && (res.text || res.error)) ? String(res.text || res.error).slice(0, 120) : '');
}
async function allDocsFlat() {
  const tree = await api.tree();
  const out = [];
  (function walk(n) {
    for (const d of (n.dirs || [])) walk(d);
    for (const f of (n.files || [])) out.push(f);
  })(tree);
  return out;
}

async function newNote() {
  const title = await askText({ title: '新建笔记', placeholder: '笔记标题' });
  if (!title) return;
  const flat = await allDocsFlat();
  let rel = '00-收件箱/' + title + '.md';
  let i = 2;
  while (flat.some((f) => f.path === rel)) { rel = '00-收件箱/' + title + ' ' + i + '.md'; i++; }
  const text = '---\ntype: Note\ntitle: ' + title + '\nstatus: draft\ngenerated:\n  by: ' + MY_IDENTITY + '\n  at: "' + new Date().toISOString() + '"\nsource_checked: false\n---\n\n# ' + title + '\n\n';
  const res = await api.save(rel, text);
  if (res && res.ok) { await refreshTree(); await openDoc(rel); setStatus('已新建 ' + rel, ''); }
  else { showBanner('新建失败：' + ((res && (res.error || res.reason)) || '未知原因')); }
}

async function renameCurrent() {
  if (!current) return;
  const to = await askText({ title: '重命名 / 移动', value: current.rel, placeholder: '相对库根的路径，例如 00-收件箱/新名字.md' });
  if (!to || to === current.rel) return;
  const res = await api.rename(current.rel, to);
  if (res && res.ok) {
    await refreshTree();
    openDocs = openDocs.map((r) => (r === current.rel ? to : r));
    await openDoc(to);
    setStatus('已改名并改链 ' + res.relinked + ' 篇', '');
  } else {
    showBanner('改名失败：' + JSON.stringify(res));
  }
}

// ---------------------------------------------------------------- 快速切换
let switchDocs = [];

async function openSwitcher() {
  const box = document.getElementById('switcher');
  box.classList.remove('hidden');
  const input = document.getElementById('switcher-input');
  input.value = '';
  input.focus();
  switchDocs = await allDocsFlat();
  renderSwitcher('');
}

function renderSwitcher(q) {
  const list = document.getElementById('switcher-list');
  if (!list) return;
  list.innerHTML = '';
  const ql = String(q || '').toLowerCase();
  const items = switchDocs.filter((d) => !ql || d.path.toLowerCase().includes(ql) || String(d.title || '').toLowerCase().includes(ql)).slice(0, 40);
  items.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'item' + (i === 0 ? ' sel' : '');
    const name = document.createElement('span');
    name.textContent = d.title || d.path.split('/').pop();
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = d.path;
    el.append(name, sub);
    el.onclick = () => { document.getElementById('switcher').classList.add('hidden'); openDoc(d.path); };
    list.appendChild(el);
  });
  if (!items.length) list.innerHTML = '<div class="item"><span class="sub">没有匹配的文档</span></div>';
}

// ---------------------------------------------------------------- 顶部检索栏（浏览器式 + 查询语法）
const searchInput = document.getElementById('search-input');
const searchList = document.getElementById('search-list');
const SEARCH_HISTORY_KEY = 'kb:searchHistory';
const SEARCH_HISTORY_MAX = 10;
let searchTimer = null;
let searchSeq = 0;
let searchMode = 'help';
let searchHits = [];
let searchActive = -1;
let lastPointerMove = 0;
document.addEventListener('mousemove', () => { lastPointerMove = Date.now(); }, true);
function hoverAllowed() { return Date.now() - lastPointerMove < 400; }

function searchListOpen() { return !searchList.classList.contains('hidden'); }
function setSearchExpanded(on) {
  searchInput.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (!on) searchInput.removeAttribute('aria-activedescendant');
}
function hideSearch() {
  searchList.classList.add('hidden');
  searchList.innerHTML = '';
  searchMode = 'help';
  searchHits = [];
  searchActive = -1;
  setSearchExpanded(false);
}
function searchHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch (e) { return []; }
}
function saveSearchHistory(list) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, SEARCH_HISTORY_MAX))); } catch (e) { /* ignore */ }
}
function pushSearchHistory(q) {
  const s = String(q || '').trim();
  if (!s) return;
  saveSearchHistory([s].concat(searchHistory().filter((x) => x !== s)));
}
function removeSearchHistory(q) { saveSearchHistory(searchHistory().filter((x) => x !== q)); }
function clearSearchHistory() { try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch (e) { /* ignore */ } }
function searchFoot() {
  return '<div class="sl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>'
    + '<span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 收起</span></div>';
}
function setSearchActive(i) {
  const nodes = [...searchList.querySelectorAll('.result')];
  if (!nodes.length) { searchActive = -1; setSearchExpanded(false); return; }
  let idx = i;
  if (idx < 0) idx = nodes.length - 1;
  if (idx >= nodes.length) idx = 0;
  nodes.forEach((n, j) => {
    const on = j === idx;
    n.classList.toggle('active', on);
    n.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  searchActive = idx;
  const el = nodes[idx];
  if (el.id) searchInput.setAttribute('aria-activedescendant', el.id);
  el.scrollIntoView({ block: 'nearest' });
  setSearchExpanded(true);
}
function moveSearchActive(delta) {
  if (!searchListOpen()) showSearchHelp();
  const nodes = [...searchList.querySelectorAll('.result')];
  if (!nodes.length) return;
  if (searchActive < 0) { setSearchActive(delta > 0 ? 0 : nodes.length - 1); return; }
  setSearchActive((searchActive + delta + nodes.length) % nodes.length);
}
function activateSearchItem() {
  const nodes = [...searchList.querySelectorAll('.result')];
  const node = nodes[searchActive] || nodes[0];
  if (!node) return false;
  node.click();
  return true;
}
function openSearchHit(h) {
  pushSearchHistory(searchInput.value);
  hideSearch();
  openDoc(h.path);
}
function showSearchHelp() {
  searchMode = 'help';
  searchHits = [];
  searchActive = -1;
  const hist = searchHistory();
  let html = '<div class="searchempty">'
    + '全文检索：直接输入关键词。<br>'
    + '<code>tag:Agent工程</code> 标签过滤（逗号并列 = 任一命中；多写几个 = 同时满足）<br>'
    + '<code>-tag:草稿</code> 排除该标签；<code>path:70-元知识</code> · <code>type:Note</code> · <code>status:active</code> 过滤<br>'
    + '空格并列；引号包住的是短语；只写 tag 时按最近修改时间列出文档。'
    + '</div>';
  if (hist.length) {
    html += '<div class="sl-title">最近搜索<span class="sl-clear" role="button" tabindex="0" aria-label="清空最近搜索">清空</span></div>';
    hist.forEach((q, i) => {
      html += '<div class="result hist" role="option" aria-selected="false" id="search-opt-h' + i + '">'
        + '<span class="t">' + esc(q) + '</span>'
        + '<button class="hist-del" aria-label="删除搜索记录 ' + esc(q) + '" title="删除这条记录">' + svgIcon('close') + '</button>'
        + '</div>';
    });
  }
  html += searchFoot();
  searchList.innerHTML = html;
  const histNodes = [...searchList.querySelectorAll('.result.hist')];
  histNodes.forEach((el, i) => {
    el.onclick = (e) => { if (e.target.closest('.hist-del')) return; searchInput.value = hist[i]; runSearch(true); searchInput.focus(); };
    el.onmouseenter = () => { if (hoverAllowed()) setSearchActive(i); };
  });
  searchList.querySelectorAll('.hist-del').forEach((btn, i) => {
    btn.onclick = (e) => { e.stopPropagation(); removeSearchHistory(hist[i]); showSearchHelp(); searchInput.focus(); };
  });
  const clr = searchList.querySelector('.sl-clear');
  if (clr) clr.onclick = () => { clearSearchHistory(); showSearchHelp(); searchInput.focus(); };
  searchList.classList.remove('hidden');
  setSearchExpanded(false);
}
function focusSearch() {
  searchInput.focus();
  searchInput.select();
  if (searchInput.value.trim()) runSearch(true); else showSearchHelp();
}
function openSearch() { return focusSearch(); }
function renderResults(hits) {
  searchMode = 'results';
  searchHits = hits || [];
  searchList.innerHTML = '';
  searchHits.forEach((h, i) => {
    const el = document.createElement('div');
    el.className = 'result' + ((h.warnings && h.warnings.length) ? ' expired' : '');
    el.id = 'search-opt-' + i;
    el.dataset.i = String(i);
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    const meta = [h.type, h.status].filter(Boolean).join(' · ');
    const tags = (h.tags || []).map((x) => '#' + x).join(' ');
    const tm = (h.tagMatches || []).length
      ? '<div class="w">标签命中：' + h.tagMatches.map((m) => esc(m.tag) + (m.where === 'entry' ? '（条目 ' + esc(m.field) + '）' : '（文件）')).join('、') + '</div>' : '';
    el.innerHTML = '<div class="t">' + esc(h.title || h.path) + '</div>'
      + '<div class="p">' + esc(h.path) + (meta ? '  ' + esc(meta) : '') + (tags ? '  ' + esc(tags) : '') + '</div>'
      + (h.snippet ? '<div class="s">' + esc(h.snippet) + '</div>' : '')
      + ((h.warnings && h.warnings.length) ? '<div class="w">' + svgIcon('warning') + ' ' + esc(h.warnings.join('；')) + '</div>' : '') + tm;
    el.onclick = () => openSearchHit(h);
    el.onmouseenter = () => { if (hoverAllowed()) setSearchActive(i); };
    searchList.appendChild(el);
  });
  if (!searchHits.length) searchList.innerHTML = '<div class="result empty"><div class="s">没有命中</div></div>';
  searchList.insertAdjacentHTML('beforeend', searchFoot());
  searchList.classList.remove('hidden');
  setSearchExpanded(true);
  setSearchActive(searchHits.length ? 0 : -1);
  return searchHits;
}
function esc(t) { return String(t == null ? '' : t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
async function doSearch(q) {
  const str = String(q || '').trim();
  if (!str) { showSearchHelp(); return []; }
  const seq = ++searchSeq;
  const r = await api.searchQuery(str, 20);
  if (seq !== searchSeq) return [];
  if (!r || r.ok === false) {
    searchList.innerHTML = '<div class="result"><div class="s">检索失败：' + esc((r && r.error) || '未知错误') + '</div></div>';
    searchList.classList.remove('hidden');
    return [];
  }
  return renderResults(r.hits || []);
}
function runSearch(immediate) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { doSearch(searchInput.value); }, immediate ? 0 : 180);
}
// ---------------------------------------------------------------- 无头自检钩子（KB_EVAL 用）

// ---------------------------------------------------------------- 内置浏览器 + 外链快照
const webPanel = document.getElementById('webpanel');
const wv = document.getElementById('wv');
const wbAddr = document.getElementById('wb-addr');
const webFallback = document.getElementById('webfallback');
let webSnaps = [];
let webOnlineUrl = '';
let webMode = 'online';   // online | snapshot：did-finish-load 只能用模式判断，不能用 getURL 抢跑

function webVisible() { return !!webPanel && !webPanel.classList.contains('hidden'); }
function normalizeWebUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (e) { /* fallthrough */ }
  return null;
}
function showWebFallback(html) {
  if (!webFallback) return;
  webFallback.innerHTML = html;
  webFallback.classList.remove('hidden');
}
function hideWebFallback() { if (webFallback) { webFallback.classList.add('hidden'); webFallback.innerHTML = ''; } }
let webLoadTimer = null;
/** 在线打开：只接受 http/https；快照回退走 openSnapshotUrl。 */
function openWeb(url) {
  const u = normalizeWebUrl(url);
  if (!u) { setStatus('只支持 http/https 链接；不会打开本地文件或脚本协议', ''); return false; }
  webPanel.classList.remove('hidden');
  hideWebFallback();
  webMode = 'online';
  webOnlineUrl = u;
  wbAddr.value = u;
  wv.src = u;
  clearTimeout(webLoadTimer);
  webLoadTimer = setTimeout(() => setStatus('页面 15s 未加载完，可稍后手动快照', ''), 15000);
  return true;
}
function openSnapshotUrl(url, meta) {
  if (!url) return false;
  webPanel.classList.remove('hidden');
  webMode = 'snapshot';
  wbAddr.value = (meta && meta.url) || 'snapshot';
  webOnlineUrl = (meta && meta.url) || '';
  wv.src = url;
  const when = meta && meta.ts ? new Date(meta.ts).toLocaleString('zh-CN') : '';
  showWebFallback('<span>离线快照 · 抓取于 ' + esc(when) + '</span><button id="wb-retry">重试在线</button>');
  const retry = document.getElementById('wb-retry');
  if (retry) retry.onclick = () => { if (webOnlineUrl) openWeb(webOnlineUrl); };
  return true;
}
function closeWeb() { webPanel.classList.add('hidden'); }

async function doSnapshot(auto) {
  const url = wv.getURL();
  if (!url || url === 'about:blank') return { ok: false, error: 'NO-URL' };
  if (!/^https?:/i.test(url)) { setStatus('快照只对在线页面可用', ''); return { ok: false, error: 'NOT-ONLINE' }; }
  const title = wv.getTitle();
  let html = '';
  let text = '';
  try { html = await wv.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""'); } catch (e) { /* 跨域页面拿不到就算了 */ }
  try { text = await wv.executeJavaScript('document.body ? document.body.innerText : ""'); } catch (e) { /* 同上 */ }
  let webContentsId = null;
  try { webContentsId = wv.getWebContentsId(); } catch (e) { /* 未挂载 */ }
  const res = await api.snapSave({ url, title, html, text, auto: !!auto, webContentsId });
  setStatus((res && res.ok) ? (auto ? '已自动快照 ' : '已快照 ') + url : '快照失败：' + ((res && res.error) || '未知错误'), statsRight());
  return res;
}

async function autoSnapshotIfDue() {
  const url = wv.getURL();
  if (!url || url === 'about:blank' || !/^https?:/i.test(url)) return;
  let due = false;
  try { due = (await api.snapAuto(url)).due; } catch (e) { due = false; }
  if (due) setTimeout(() => doSnapshot(true), 1500);
}

async function renderWebHistory() {
  const box = document.getElementById('webhist');
  const url = wv.getURL();
  webSnaps = await api.snapList(url && url !== 'about:blank' ? url : null);
  const rows = webSnaps.map((s, i) => '<div class="snap" data-i="' + i + '"><div class="t">' + esc(s.title || s.url) + '</div><div class="m">' + new Date(s.ts).toLocaleString('zh-CN') + ' · ' + Math.round(((s.bytes && s.bytes.html) || 0) / 1024) + ' KB · ' + s.id + '</div></div>');
  box.innerHTML = '<div class="hist-title">快照历史（' + webSnaps.length + '）</div>' + (rows.length ? rows.join('') : '<div class="hist-empty">还没有快照。打开页面后按「快照」。</div>');
  box.classList.remove('hidden');
}

function bindWeb() {
  if (!wv) return;
  document.getElementById('wb-close').onclick = closeWeb;
  document.getElementById('wb-back').onclick = () => { try { if (wv.canGoBack()) wv.goBack(); } catch (e) {} };
  document.getElementById('wb-fwd').onclick = () => { try { if (wv.canGoForward()) wv.goForward(); } catch (e) {} };
  document.getElementById('wb-reload').onclick = () => { try { wv.reload(); } catch (e) {} };
  document.getElementById('wb-snap').onclick = () => doSnapshot(false);
  document.getElementById('wb-hist').onclick = () => renderWebHistory();
  document.getElementById('webhist').addEventListener('click', async (e) => {
    const el = e.target.closest && e.target.closest('.snap');
    if (!el) return;
    const s = webSnaps[Number(el.dataset.i)];
    if (!s) return;
    const r = await api.snapUrl(s.id);
    if (r && r.ok) openSnapshotUrl(r.url, r.meta);
    else setStatus('快照文件不存在：' + (s.id || ''), '');
  });
  wbAddr.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = wbAddr.value.trim();
    if (!v) return;
    if (!openWeb(v)) wbAddr.value = webOnlineUrl || '';
  });
  wv.addEventListener('did-finish-load', () => {
    clearTimeout(webLoadTimer);
    let url = '';
    try { url = wv.getURL(); wbAddr.value = url; } catch (e) {}
    if (webMode === 'online' && /^https?:/i.test(url)) { hideWebFallback(); autoSnapshotIfDue(); }
  });
  wv.addEventListener('did-navigate', () => { try { wbAddr.value = wv.getURL(); } catch (e) {} });
  wv.addEventListener('did-fail-load', async (e) => {
    if (e && e.isMainFrame === false) return;
    if (e && e.errorCode === -3) return;   // ERR_ABORTED：用户主动中断，不算失败
    const failed = (e && e.validatedURL) || webOnlineUrl;
    if (!failed || !/^https?:/i.test(failed)) return;
    let snaps = [];
    try { snaps = await api.snapList(failed); } catch (e2) { snaps = []; }
    if (snaps && snaps.length) {
      const r = await api.snapUrl(snaps[0].id);
      if (r && r.ok) {
        openSnapshotUrl(r.url, r.meta);
        setStatus('在线加载失败，已自动回退到快照', '');
        return;
      }
    }
    showWebFallback('<span>在线加载失败，且没有可用快照：' + esc((e && e.errorDescription) || '网络错误') + '</span>');
    setStatus('页面打不开，也没有可用快照', '');
  });
}
bindWeb();

async function chooseVault() {
  const res = await api.chooseVault();
  if (!res || res.canceled) return res;
  if (!res.ok) {
    document.getElementById('vb-err').textContent = '无法打开：' + (res.error || '未知错误');
    return res;
  }
  localStorage.removeItem('kb:session');
  location.reload();
  return res;
}

window.__kbTest = {
  openDoc,
  currentRel: () => (current ? current.rel : null),
  dirty: () => dirty,
  doc: () => view.state.doc.toString(),
  setDoc: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
  insert: (t) => { view.focus(); view.dispatch(view.state.replaceSelection(t), { userEvent: 'input.type' }); },
  typeText: (t) => { view.focus(); const pos = view.state.selection.main.head; view.dispatch({ changes: { from: pos, insert: t }, selection: { anchor: pos + t.length }, userEvent: 'input.type' }); },
  cursorTo: (n) => view.dispatch({ selection: { anchor: n } }),
  cursor: () => view.state.selection.main.head,
  save: saveCurrent,
  props: () => [...document.querySelectorAll('#props .prop-row')].map((e) => ({
    name: e.dataset.field,
    value: e.querySelector('.prop-value') ? e.querySelector('.prop-value').textContent.trim() : '',
    missing: e.querySelector('.prop-value') ? e.querySelector('.prop-value').classList.contains('empty') : false,
  })),
  clickProp: (name) => { const c = document.querySelector('#props .prop-row[data-field="' + name + '"] .prop-value'); if (!c) return false; c.click(); return true; },
  propInput: () => document.querySelector('#props .prop-row input'),
  suggestions: () => { const inp = document.querySelector('#props .prop-row input'); if (!inp) return []; const id = inp.getAttribute('list'); const d = id ? document.getElementById(id) : null; return d ? [...d.options].map((o) => o.value) : []; },
  backlinks: () => [...document.querySelectorAll('#backlinks .bl')].map((e) => e.dataset.path || null),
  clickBacklink: (i) => { const els = [...document.querySelectorAll('#backlinks .bl')]; if (!els[i]) return false; els[i].click(); return true; },
  openPalette, paletteOpen,
  closePalette,
  paletteFilter: (t) => { const i = document.getElementById('palette-input'); i.value = t; renderPalette(t); return true; },
  paletteItems: () => [...document.querySelectorAll('#palette-list .item')].map((e) => e.textContent),
  paletteType: (t) => { const i = document.getElementById('palette-input'); i.value = t; renderPalette(t); return i; },
  runCommand,
  openSearch, searchOpen: searchListOpen, focusSearch,
  doSearch,
  renderResults,
  searchActiveIndex: () => searchActive,
  searchHistory: () => searchHistory(),
  searchClearHistory: clearSearchHistory,
  searchPushHistory: pushSearchHistory,
  searchItems: () => [...document.querySelectorAll('#search-list .result')].map((e, i) => ({
    index: i,
    active: e.classList.contains('active'),
    selected: e.getAttribute('aria-selected'),
    text: e.textContent.trim().slice(0, 80),
  })),
  searchResults: () => [...document.querySelectorAll('#search-list .result')].map((e) => ({
    title: e.querySelector('.t') ? e.querySelector('.t').textContent : '',
    path: e.querySelector('.p') ? e.querySelector('.p').textContent : '',
    warn: e.querySelector('.w') ? e.querySelector('.w').textContent : '',
  })),
  complete: (kind, q) => api.complete(kind, q || ''),
  links: () => linkHits.map((h) => ({ target: h.target, syntax: h.syntax })),
  openEntry: (field) => openEntryPanel(field),
  hoverPropRow: (field, on = true) => { const r = document.querySelector('#props .prop-row[data-field="' + field + '"]'); if (!r) return false; r.classList.toggle('kb-hover', !!on); return true; },
  entryTags: (rel, field) => api.entryTags(rel, field),
  setEntryTag: (field, tags) => api.setEntryTags(current.rel, field, tags),
  entryPanel: () => {
    const p = document.getElementById('entrypanel');
    return {
      open: !p.classList.contains('hidden') && p.classList.contains('open'),
      title: document.getElementById('ep-title').textContent,
      path: document.getElementById('ep-path').textContent,
      own: [...document.querySelectorAll('#ep-tags .ep-tag.own')].map((e) => e.textContent),
      inherited: [...document.querySelectorAll('#ep-tags .ep-tag.inherit')].map((e) => e.textContent),
      histCount: document.querySelectorAll('#ep-history .ep-item').length,
      histFirst: (document.querySelector('#ep-history .ep-item .ep-val') || {}).textContent || '',
    };
  },
  copyEntry: (field) => { const row = document.querySelector('#props .prop-row[data-field="' + field + '"]'); if (!row) return false; const t = row.querySelector('.prop-tools .prop-tool'); t.click(); return true; },
  hoverProps: (on = true) => { const b = document.querySelector('.props-block'); if (!b) return false; b.classList.toggle('kb-hover', !!on); return true; },
  hoverLink: (i) => { const h = linkHits[i]; if (!h) return false; const c = view.coordsAtPos(h.from + 1); showPeek(h, c.left, c.bottom - 6); return true; },
  hidePeek,
  peekVisible: () => !document.getElementById('peek').classList.contains('hidden'),
  peekText: () => document.getElementById('peek').textContent,
  openLink: (i, newWindow) => openLinkTarget(linkHits[i], !!newWindow),
  windowCount: () => api.windowCount(),
  status: () => document.getElementById('status-left').textContent,
  statusRight: () => document.getElementById('status-right').textContent,
  committer: () => document.getElementById('status-mid').textContent,
  identity: () => MY_IDENTITY,
  tabs: () => openDocs.slice(),
  saveSession,
  openWeb, closeWeb, webUrl: () => { try { return wv.getURL(); } catch (e) { return null; } }, webVisible, snapshotNow: doSnapshot, snapList: (u) => api.snapList(u || null),
  scrollTop: () => (view ? view.scrollDOM.scrollTop : 0),
  compStatus: () => completionStatus(view.state),
  newNote,
  renameCurrent,
  askText,
  dialogOpen: () => !document.getElementById('dialog').classList.contains('hidden'),
  dialogSet: (v) => { document.getElementById('dialog-input').value = v; },
  dialogOk: () => document.getElementById('dialog-ok').click(),
  dialogCancel: () => document.getElementById('dialog-cancel').click(),
  openSwitcher,
  switcherOpen: () => !document.getElementById('switcher').classList.contains('hidden'),
  switcherType: (q) => { document.getElementById('switcher-input').value = q; renderSwitcher(q); },
  switcherItems: () => [...document.querySelectorAll('#switcher-list .item')].map((e) => e.textContent),
  windowState: () => api.windowState(),
  openWelcome,
  chooseVault,
  vaultState: () => api.vaultState(),
  vaultBarVisible: () => !document.getElementById('vaultbar').classList.contains('hidden'),
  welcomeLang: () => (current && current.lang) || null,
  welcomeDocs: () => WELCOME_DOCS.slice(),
  welcomeOpen: (lang, id) => openWelcome(lang, id),
  currentTitle: () => (current ? (current.title || String(current.rel || '').split('/').pop().replace(/\.md$/, '')) : null),
  welcomeBarVisible: () => !document.getElementById('welcomebar').classList.contains('hidden'),
  readOnly: () => !!view.state.readOnly,
  clearWelcomeSeen: () => localStorage.removeItem('kb:welcomeSeen'),
  hideBanner,
  bannerVisible: () => !document.getElementById('banner').classList.contains('hidden'),
  checkCurrentDoc,
  runCommand: (id) => runCommand(id),
  checkPanel: () => ({
    open: !document.getElementById('checkpanel').classList.contains('hidden'),
    summary: document.getElementById('check-summary').textContent,
    rows: [...document.querySelectorAll('#check-list .check-row')].map((e) => e.textContent),
  }),
  plugins: () => PLUGINS.map((p) => ({ name: p.name, fence: p.fence, component: p.component, client: p.client, trusted: p.trusted, capabilities: p.capabilities })),
  pluginRuntime: () => ({
    clients: [...PLUGIN_CLIENTS.entries()].map(([name, c]) => ({ name, ready: c.ready || null, hasFrame: !!c.frame })),
    commands: PLUGIN_COMMANDS.map((c) => ({ id: c.id, title: c.title })),
    ui: [...document.querySelectorAll('#plugin-ui [data-plugin-ui]')].map((e) => ({ name: e.dataset.pluginUi, html: e.innerHTML })),
    css: [...document.querySelectorAll('style[id^="plugin-css-"]')].map((e) => e.id),
  }),
  normalizeWebUrl,
  webState: () => ({
    visible: webVisible(),
    url: (() => { try { return wv.getURL(); } catch (e) { return ''; } })(),
    fallback: webFallback && !webFallback.classList.contains('hidden') ? webFallback.textContent : '',
  }),
  openWeb: (u) => openWeb(u),
  webTitle: () => { try { return wv.getTitle(); } catch (e) { return ''; } },
  webEval: (code) => wv.executeJavaScript(String(code)),
  openSnapshot: async (id) => { const r = await api.snapUrl(id); return r && r.ok ? openSnapshotUrl(r.url, r.meta) : false; },
};

// ---------------------------------------------------------------- 启动
window.addEventListener('DOMContentLoaded', async () => {
  mountIcons();
  try {
    const me = await api.whoami();
    if (me && me.ok) { MY_IDENTITY = me.identity || MY_IDENTITY; MY_NAME = me.name || ''; }
  } catch (e) { /* 旧版 preload 没有 whoami 时保持默认 */ }
  buildEditor(document.getElementById('editor'));
  await loadPluginDefs();
  await startPluginClients();
  let tree = null;
  try { await refreshTree(); tree = await api.tree(); } catch (e) { tree = null; }
  document.getElementById('filter').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.file').forEach((el) => {
      el.style.display = el.dataset.path.toLowerCase().includes(q) ? '' : 'none';
    });
  };
  if (api.onShortcut) api.onShortcut((k) => runShortcut(k));
  document.getElementById('ep-close').onclick = closeEntryPanel;
  const checkClose = document.getElementById('check-close');
  if (checkClose) checkClose.onclick = () => document.getElementById('checkpanel').classList.add('hidden');
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey) {
      if (runShortcut(String(e.key || '').toLowerCase())) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape' && paletteOpen()) { closePalette(); return; }
    if (e.key === 'Escape' && entryField) closeEntryPanel();
  });
  // 鼠标移开面板自动关（150ms 缓冲），移回来取消
  const pal = document.getElementById('palette');
  pal.addEventListener('mouseenter', () => clearTimeout(paletteLeaveTimer));
  pal.addEventListener('mouseleave', () => {
    paletteLeaveTimer = setTimeout(() => { if (paletteOpen()) closePalette(); }, 150);
  });
  // 点面板外也关
  document.addEventListener('mousedown', (e) => {
    if (paletteOpen() && !e.target.closest('#palette')) closePalette();
  });
  document.getElementById('rib-search').onclick = () => openSearch();
  document.getElementById('rib-command').onclick = () => openPalette();
  document.getElementById('rib-backlinks').onclick = () => { const b = document.getElementById('backlinks-box'); b.scrollIntoView({ block: 'nearest' }); };
  document.getElementById('palette-input').oninput = (e) => renderPalette(e.target.value);
  document.getElementById('palette-input').onkeydown = (e) => {
    if (e.key === 'Enter') { const first = document.querySelector('#palette-list .item'); if (first) first.click(); }
    if (e.key === 'Escape') closePalette();
  };
  searchInput.oninput = () => runSearch(false);
  searchInput.onfocus = () => { if (!searchInput.value.trim()) showSearchHelp(); };
  searchInput.onkeydown = async (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchActive(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchActive(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchListOpen() && activateSearchItem()) return;
      await doSearch(searchInput.value);
      activateSearchItem();
      return;
    }
    if (e.key === 'Escape') { hideSearch(); if (view) view.focus(); }
  };
  document.addEventListener('mousedown', (e) => {
    if (searchListOpen() && !e.target.closest('#topbar')) hideSearch();
  });
  document.getElementById('switcher-input').oninput = (e) => renderSwitcher(e.target.value);
  document.getElementById('switcher-input').onkeydown = (e) => {
    if (e.key === 'Enter') { const first = document.querySelector('#switcher-list .item'); if (first) first.click(); }
    if (e.key === 'Escape') document.getElementById('switcher').classList.add('hidden');
  };
  document.getElementById('vb-choose').onclick = chooseVault;
  if (!tree || !tree.dirs) {
    document.getElementById('vaultbar').classList.remove('hidden');
    await openWelcome();
    saveSession();
    window.__kbReady = true;
    return;
  }
  if (api.onSaveAndClose) {
    api.onSaveAndClose(async () => {
      const res = await saveCurrent();
      if (res && res.ok) { if (api.forceClose) api.forceClose(); }
    });
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  // 启动时打开第一篇，便于截图与自检
  const wanted = new URLSearchParams(location.search).get('doc');
  const flat = [];
  (function walk(n) { for (const d of (n.dirs || [])) walk(d); for (const f of (n.files || [])) flat.push(f.path); })(tree);
  const first = flat[0];
  const sess = loadSession();
  const seenWelcome = localStorage.getItem('kb:welcomeSeen');
  if (wanted) {
    await openDoc(wanted);
  } else if (!seenWelcome) {
    await openWelcome();
  } else if (sess && sess.docs && sess.docs.length) {
    openDocs = sess.docs.filter((d) => flat.includes(d));
    if (!openDocs.length) openDocs = [];
    const target = openDocs.includes(sess.active) ? sess.active : openDocs[0];
    try {
      if (target) {
        await openDoc(target);
        if (sess.active === target) {
          const pos = Math.min(sess.cursor || 0, view.state.doc.length);
          view.dispatch({ selection: { anchor: pos } });
          view.scrollDOM.scrollTop = sess.scroll || 0;
        }
        renderTabs();
      } else if (first) await openDoc(first);
    } catch (e) {
      openDocs = [];
      if (first) await openDoc(first);
    }
  } else if (first) await openDoc(first);
  if (!current && !flat.length) { await openWelcome(); setStatus('空文件夹已初始化 Git 仓库 · 按 Ctrl+N 新建第一篇', ''); }
  saveSession();
  window.__kbReady = true;
});
