'use strict';
/** 自定义健康标准与检查器参数验收（T6–T9）。沙箱写盘；真库只读。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const APP = path.resolve(__dirname, '..');
const REAL = require('./_root');
let fail = 0;
function check(name, cond, detail) { console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : '')); if (!cond) fail++; }
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function run(cwd, args) {
  try { return { rc: 0, out: execFileSync('python3', [path.join(cwd, '.okf', 'okf_commit.py'), ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }; }
  catch (e) { return { rc: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}
function health(cwd, extra) { const r = run(cwd, ['health', '--json', ...(extra || [])]); const m = /\{[\s\S]*\}/.exec(r.out); return { rc: r.rc, j: m ? JSON.parse(m[0]) : null, raw: r.out }; }
function checkJson(cwd, extra) { const r = run(cwd, ['check', '--json', ...(extra || [])]); const m = /\{[\s\S]*\}/.exec(r.out); return { rc: r.rc, j: m ? JSON.parse(m[0]) : null, raw: r.out }; }

const FM = (n) => ['---', 'type: Note', 'title: 文档' + n, 'status: stable', 'generated:', '  by: process:test', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', 'verified:', '  - by: process:test', '    at: "2026-01-01T00:00:00+08:00"', '---', '', '# 文档' + n, ''].join('\n');
function HEALTH(th, params, ext) {
  const lines = ['version: 1', 'thresholds:', '  errors_max: 0', '  ghost_max: ' + (th && th.ghost != null ? th.ghost : 0), '  unreadable_max: 0', '  no_frontmatter_ratio_max: ' + (th && th.nofm != null ? th.nofm : 0.1), '  machine_confirmed_ratio_min: ' + (th && th.machine != null ? th.machine : 0.7), '  stale_ratio_max: ' + (th && th.stale != null ? th.stale : 0.25), '  checker_errors_max: 0', 'checkers:'];
  if (params && Object.keys(params).length) {
    lines.push('  params:', '    broken-links:', '      ignore: ' + JSON.stringify(params.ignore || []));
    if (params.grace != null) lines.push('    stale-docs:', '      grace_days: ' + params.grace);
  } else { lines.push('  params: {}'); }
  lines.push('external: ' + ((ext && JSON.stringify(ext)) || '{}'));
  return lines.join('\n') + '\n';
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-health-'));
  const vault = path.join(tmp, 'vault'); fs.mkdirSync(path.join(vault, '00-收件箱'), { recursive: true });
  fs.cpSync(path.join(REAL, '.okf'), path.join(vault, '.okf'), { recursive: true });
  fs.chmodSync(path.join(vault, '.okf', 'okf'), 0o755);
  git(['init', '-q'], vault); git(['config', 'core.quotepath', 'false'], vault); git(['config', 'user.name', 'test'], vault); git(['config', 'user.email', 't@local'], vault);
  for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(vault, '00-收件箱', 'd' + i + '.md'), FM(i));
  const healthYaml = path.join(vault, '.okf', 'health.yaml');
  fs.writeFileSync(healthYaml, HEALTH());
  git(['add', '-A'], vault); git(['commit', '-qm', 'base'], vault);

  let h = health(vault);
  check('T7 默认阈值下健康库 ok=true', !!h.j && h.j.ok === true && h.j.violations.length === 0 && h.j.metrics.total === 8 && h.j.metrics.machine_confirmed_ratio === 1, h.j ? 'total=' + h.j.metrics.total + ' ok=' + h.j.ok : h.raw.slice(0, 120));

  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(vault, '00-收件箱', 'raw' + i + '.md'), '# 无头' + i + '\n');
  h = health(vault);
  const nofm = h.j ? h.j.violations.find((v) => v.metric === 'no_frontmatter_ratio') : null;
  check('T6 改阈值前缺头比例触发 violation', !!h.j && h.j.metrics.no_frontmatter === 3 && !!nofm, h.j ? 'ratio=' + h.j.metrics.no_frontmatter_ratio : '');
  fs.writeFileSync(healthYaml, HEALTH({ nofm: 0.5 }));
  h = health(vault);
  check('T6 放宽 no_frontmatter_ratio_max 后 violation 消失', !!h.j && !h.j.violations.some((v) => v.metric === 'no_frontmatter_ratio') && h.j.ok === true, h.j ? 'violations=' + h.j.violations.length : '');

  fs.unlinkSync(path.join(vault, '00-收件箱', 'd8.md'));
  h = health(vault);
  check('T7 默认阈值下 ghost 使 ok=false', !!h.j && h.j.metrics.ghost === 1 && h.j.ok === false && h.j.violations.some((v) => v.metric === 'ghost' && v.level === 'error'), h.j ? 'ok=' + h.j.ok + ' ghost=' + h.j.metrics.ghost : '');
  fs.writeFileSync(healthYaml, HEALTH({ nofm: 0.5, ghost: 1 }));
  h = health(vault);
  check('T6 放宽 ghost_max 后恢复 ok=true', !!h.j && h.j.metrics.ghost === 1 && h.j.ok === true, h.j ? 'ok=' + h.j.ok + ' ghost=' + h.j.metrics.ghost : '');

  fs.writeFileSync(healthYaml, HEALTH());
  fs.writeFileSync(path.join(vault, '00-收件箱', 'badlink.md'), ['---', 'type: Note', 'title: 坏链', 'status: draft', 'generated:', '  by: process:test', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', '---', '', '# 坏链', '', '[甲](不存在-A.md)', '[[坏链-B]]', ''].join('\n'));
  let c = checkJson(vault, ['00-收件箱/badlink.md']);
  check('T8 baseline 命中两条 LINK-MISSING', !!c.j && c.j.counts.errors + c.j.counts.warns === 2 && c.j.findings.every((f) => f.code === 'LINK-MISSING'), c.j ? JSON.stringify(c.j.counts) : c.raw.slice(0, 100));

  const cfgYaml = path.join(vault, '.okf', 'config.yaml');
  const cfgBase = fs.readFileSync(cfgYaml, 'utf8');
  function setCfgIgnore(list) {
    let t = cfgBase;
    t = t.replace(/checkers:\n(?:.*\n)*?\s*params:\n(?:.*\n)*?(?=\S|$)/, '');
    t += '\ncheckers:\n  params:\n    broken-links:\n      ignore: ' + JSON.stringify(list) + '\n';
    fs.writeFileSync(cfgYaml, t);
  }
  setCfgIgnore(['不存在-A']);
  c = checkJson(vault, ['00-收件箱/badlink.md']);
  check('T8 config checkers.params.ignore 生效', !!c.j && c.j.findings.length === 1 && c.j.findings[0].code === 'LINK-MISSING', c.j ? 'findings=' + c.j.findings.length : c.raw.slice(0, 100));

  setCfgIgnore([]);
  fs.writeFileSync(healthYaml, HEALTH({}, { ignore: ['不存在-A', '坏链-B'] }));
  c = checkJson(vault, ['00-收件箱/badlink.md']);
  check('T8 health.checkers.params 覆盖 config', !!c.j && c.j.findings.length === 0, c.j ? 'findings=' + c.j.findings.length : '');

  setCfgIgnore(['不存在-A', '坏链-B']);
  fs.writeFileSync(healthYaml, HEALTH({}, { ignore: [] }));
  c = checkJson(vault, ['00-收件箱/badlink.md']);
  check('T8 health 层空数组覆盖 config（不是合并）', !!c.j && c.j.findings.length === 2, c.j ? 'findings=' + c.j.findings.length : '');

  setCfgIgnore([]);
  fs.writeFileSync(healthYaml, HEALTH());
  c = checkJson(vault, ['--param', 'broken-links.ignore=["不存在-A"]', '00-收件箱/badlink.md']);
  check('T8 --param 覆盖前两层', !!c.j && c.j.findings.length === 1, c.j ? 'findings=' + c.j.findings.length : c.raw.slice(0, 100));

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(vault, '00-收件箱', 'old.md'), ['---', 'type: Note', 'title: 过期', 'status: stable', 'stale_after: ' + yesterday, 'generated:', '  by: process:test', '  at: "2026-01-01T00:00:00+08:00"', 'source_checked: false', '---', '', '# 过期', ''].join('\n'));
  c = checkJson(vault, ['--plugin', 'stale-docs', '00-收件箱/old.md']);
  const stale0 = c.j ? c.j.findings.length : -1;
  c = checkJson(vault, ['--param', 'stale-docs.grace_days=5', '--plugin', 'stale-docs', '00-收件箱/old.md']);
  check('T8 stale-docs grace_days 参数生效', stale0 === 1 && !!c.j && c.j.findings.length === 0, 'grace0=' + stale0 + ' grace5=' + (c.j ? c.j.findings.length : '?'));

  // T8c：用户自写检查器 + 参数
  const myDir = path.join(vault, '.okf', 'checkers', 'my-check');
  fs.mkdirSync(myDir, { recursive: true });
  fs.writeFileSync(path.join(myDir, 'checker.py'), ['NAME = "my-check"', 'SCOPE = "doc"', 'DEFAULT_LEVEL = "warn"', '', 'def check(ctx):', '    p = ctx.get("params") or {}', '    return [{"level": "warn", "code": "MY-RULE", "message": "need=" + str(p.get("need"))}]', ''].join('\n'));
  c = checkJson(vault, ['--plugin', 'my-check', '--param', 'my-check.need=42', '00-收件箱/badlink.md']);
  check('T8c 自写检查器读到 --param', !!c.j && c.j.findings.some((f) => f.code === 'MY-RULE' && /need=42/.test(f.message)), c.j ? JSON.stringify(c.j.findings.map((f) => f.message)) : c.raw.slice(0, 100));

  // T8d：外部检查器拿到完整参数链（config + health + --param）
  const ext = path.join(vault, 'ext.py');
  fs.writeFileSync(ext, ['import json, sys', 'd = json.load(sys.stdin)', 'print(json.dumps({"findings": [{"level": "warn", "message": "EXT " + json.dumps(d.get("params"), ensure_ascii=False)}]}))', ''].join('\n'));
  fs.chmodSync(ext, 0o755);
  fs.writeFileSync(healthYaml, HEALTH({}, { ignore: ['from-health'] }, { command: 'python3', args: [ext] }));
  let eh = health(vault, ['--param', 'stale-docs.grace_days=7']);
  const extMsg = eh.j ? ((eh.j.violations.find((v) => v.metric === 'external') || {}).message || '') : '';
  check('T8d 外部检查器收到合并参数', /from-health/.test(extMsg) && /grace_days/.test(extMsg) && /7/.test(extMsg), extMsg.slice(0, 160));

  // T8e：外部检查器失败只记 warning，不中断
  fs.writeFileSync(healthYaml, HEALTH({}, {}, { command: 'false' }));
  eh = health(vault);
  const failMsg = eh.j ? ((eh.j.violations.find((v) => v.metric === 'external') || {}).message || '') : '';
  check('T8e 外部检查器失败降级为 warning', /外部检查器失败/.test(failMsg) && eh.j && typeof eh.j.ok === 'boolean', failMsg.slice(0, 120));

  const healthDocZh = fs.readFileSync(path.join(APP, 'app', 'welcome', 'zh-CN', '03-health.md'), 'utf8');
  const healthDocEn = fs.readFileSync(path.join(APP, 'app', 'welcome', 'en-US', '03-health.md'), 'utf8');
  check('T9 介绍文档有自定义健康标准章节', /自定义健康标准/.test(healthDocZh) && /Custom health standards/i.test(healthDocEn), 'zh=' + /自定义健康标准/.test(healthDocZh) + ' en=' + /Custom health standards/i.test(healthDocEn));

  const tokenFile = path.join(os.homedir(), '.config', 'kb', 'token');
  let token = ''; try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) {}
  const body = await new Promise((resolve) => {
    if (!token) return resolve(null);
    const req = http.get({ host: '127.0.0.1', port: 18812, path: '/health', headers: { authorization: 'Bearer ' + token } }, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { resolve({ code: res.statusCode, j: null }); } }); });
    req.on('error', () => resolve(null)); req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
  const hh = body && body.j && body.j.kb && body.j.kb.health;
  check('T9 /health 含 health.ok/thresholds/violations', !!body && body.code === 200 && !!hh && typeof hh.ok === 'boolean' && !!hh.thresholds && Array.isArray(hh.violations), body ? 'code=' + body.code + ' ok=' + (hh && hh.ok) : 'service unreachable（先 systemctl --user start kb-serve）');

  console.log('\nRESULT ' + (fail ? 'FAIL(' + fail + ')' : 'PASS'));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });