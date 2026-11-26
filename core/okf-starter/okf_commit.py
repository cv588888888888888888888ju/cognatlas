#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
okf_commit.py — OKF 知识库统一提交工具（对标 Rust cargo 机制）

三道关（模仿 Rust）：
  fmt     -> 像 cargo fmt / rustfmt：把每个 md 的 YAML frontmatter 归一化为
             标准布局（字段顺序 / 时间格式 / generated-verified 写法统一），body 不动。
  lint    -> 像 cargo clippy / check：硬门禁。type、更新者(generated.by)、
             最后更新时间(generated.at)、是否源检查(source_checked) 缺一即不过。
  commit  -> fmt + lint 全过 -> 自动留痕(generated/verified/log.md) -> git add+commit。
             git 历史即回滚点。

用法：
  python okf_commit.py fmt    [paths...]            只做格式转换并写回
  python okf_commit.py lint   [paths...]            只检查，不改文件
  python okf_commit.py commit [paths...] --by agent:<runtime>:<sessionId> --source-checked [-m "msg"]
  python okf_commit.py commit [paths...] --by process:night-kb-commit --no-source-checked
  python okf_commit.py status                        全仓库合规概览

设计：stdlib + PyYAML。只重写 frontmatter，正文(body)逐字节保留。
"""
from __future__ import annotations
import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import subprocess
import sys
sys.dont_write_bytecode = True      # 检查器插件不往知识库写 __pycache__
from pathlib import Path
import yaml

# Windows 控制台是 GBK 时，✗/✓ 等符号会让 print 抛 UnicodeEncodeError；异常路径的退出码
# 会变成 1，把真实的 return 2 吃掉（实测：直调 python 不带 PYTHONIOENCODING 时复现）。
# 统一降级为 replace，保证退出码语义不被编码问题污染。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

# ---------------------------------------------------------------------------
# 路径与配置
# ---------------------------------------------------------------------------

TOOL_DIR = Path(__file__).resolve().parent          # .okf/
REPO_ROOT = TOOL_DIR.parent                          # vault root
CONFIG_PATH = TOOL_DIR / "config.yaml"

DEFAULT_CONFIG = {
    "timezone": "+08:00",
    # 注意：2026-09-15 起取消 default_actor —— commit 必须显式 --by（见 validate_actor）
    "canonical_order": [
        "type", "title", "description", "tags", "aliases", "status",
        "generated", "source_checked", "source_checked_at", "verified",
        "stale_after", "sources",
    ],
    "required": ["type", "generated.by", "generated.at", "source_checked"],
    "type_fallback": "Note",
    "type_infer": {"kind_map": {}},
    "status_map": {},
    "status_fallback": "stable",
    "status_legal": ["draft", "stable", "deprecated"],
    "verified": {
        "append_lint_actor": "process:okf-commit",
        "lint_method": "pre-commit-fmt-lint",
        "source_check_method": "source-check",
    },
    "stale_after_days": {"default": 365},
    "reserved_filenames": ["index.md", "log.md"],
    "log": {"enabled": True, "path": "log.md",
            "verbs": {"created": "Creation", "updated": "Update",
                      "deprecated": "Deprecation"}},
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        loaded = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
        cfg.update(loaded)
    return cfg


# ---------------------------------------------------------------------------
# 时间工具
# ---------------------------------------------------------------------------

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?"
    r"(Z|[+-]\d{2}:?\d{2})?$"
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def now_iso(tz_offset: str) -> str:
    """当前本地时间，输出 2026-08-31T20:00:00+08:00。"""
    sign = 1 if tz_offset.startswith("+") else -1
    hh, mm = int(tz_offset[1:3]), int(tz_offset[4:6])
    tz = dt.timezone(sign * dt.timedelta(hours=hh, minutes=mm))
    return dt.datetime.now(tz).replace(microsecond=0).isoformat()


def normalize_time(value, tz_offset: str):
    """把任意合法时间/日期归一化为 ISO8601 带偏移；非法返回 (None, 原值)。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if _DATE_RE.match(s):                       # 纯日期补成当天 00:00
        return f"{s}T00:00:00{tz_offset}"
    m = _ISO_RE.match(s)
    if not m:
        return None
    y, mo, d, hh, mm, ss, frac, tzs = m.groups()
    tzstr = tzs or tz_offset
    if tzs == "Z":
        tzstr = "+00:00"
    if len(tzstr) == 5 and tzstr[3] != ":":     # +0800 -> +08:00
        tzstr = tzstr[:3] + ":" + tzstr[3:]
    return f"{y}-{mo}-{d}T{hh}:{mm}:{ss}{tzstr}"


# ---------------------------------------------------------------------------
# YAML 标量 / 块渲染（自定义，保证风格统一）
# ---------------------------------------------------------------------------

_QUOTE_TRIGGER = set(":#&*!|>%@`[]{}\n\r\t,")
_LOOKS_SPECIAL = {"yes", "no", "on", "off", "null", "true", "false", "~", ""}
_DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_NUM_LIKE = re.compile(r"^-?\d+(\.\d+)?$")


def yscalar(v) -> str:
    """渲染一个 YAML 标量（flow 风格内使用）。"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    need = (
        s == ""
        or s.lower() in _LOOKS_SPECIAL
        or bool(_DATE_LIKE.match(s))
        or bool(_NUM_LIKE.match(s))
        or any(c in s for c in _QUOTE_TRIGGER)
        or s[0] in "-? "
        or s != s.strip()
    )
    if need:
        esc = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        return f'"{esc}"'
    return s


def yflow(obj) -> str:
    """inline flow：dict -> { k: v, k: v }；list -> [a, b]。"""
    if isinstance(obj, dict):
        return "{ " + ", ".join(f"{k}: {yscalar(v)}" for k, v in obj.items()) + " }"
    if isinstance(obj, (list, tuple)):
        return "[" + ", ".join(yscalar(v) for v in obj) + "]"
    return yscalar(obj)


def render_value_block(key, value, indent=0):
    """把一个顶层字段渲染为 block 行列表（处理 verified/sources 等特殊风格）。"""
    pad = " " * indent
    out = []
    if value is None:
        return [f"{pad}{key}: null"]
    if key == "verified" and isinstance(value, list):
        if not value:
            return [f"{pad}verified: []"]
        out.append(f"{pad}verified:")
        for ev in value:
            out.append(f"{pad}  - {yflow(ev)}")
        return out
    if key == "sources" and isinstance(value, list):
        if not value:
            return [f"{pad}sources: []"]
        out.append(f"{pad}sources:")
        for i, ev in enumerate(value):
            if isinstance(ev, dict):
                first = True
                for sk, sv in ev.items():
                    if first:
                        out.append(f"{pad}  - {sk}: {yscalar(sv)}")
                        first = False
                    else:
                        out.append(f"{pad}    {sk}: {yscalar(sv)}")
            else:
                out.append(f"{pad}  - {yscalar(ev)}")
        return out
    if isinstance(value, dict):
        # generated 等小 dict 用 flow；大 dict 兜底 block
        if key == "generated" or len(value) <= 3:
            return [f"{pad}{key}: {yflow(value)}"]
        out.append(f"{pad}{key}:")
        for sk, sv in value.items():
            out.append(f"{pad}  {sk}: {yscalar(sv)}")
        return out
    if isinstance(value, list):
        return [f"{pad}{key}: {yflow(value)}"]
    return [f"{pad}{key}: {yscalar(value)}"]


# ---------------------------------------------------------------------------
# frontmatter 切分 / 解析 / 归一化
# ---------------------------------------------------------------------------

class Issue:
    __slots__ = ("level", "code", "msg")
    def __init__(self, level, code, msg):
        self.level, self.code, self.msg = level, code, msg
    def __str__(self):
        return f"[{self.level}/{self.code}] {self.msg}"


def split_frontmatter(text: str):
    """返回 (data, fm_raw, body)。无 frontmatter 时 data=None。"""
    text = text.lstrip("\ufeff")          # 容忍并剥离 UTF-8 BOM（写回时统一无 BOM）
    if not text.startswith("---"):
        return None, None, text
    # 支持 --- 后紧跟 \n 或 \r\n
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.DOTALL)
    if not m:
        return None, None, text
    fm_raw = m.group(1)
    body = text[m.end():]
    try:
        data = yaml.safe_load(fm_raw) or {}
    except yaml.YAMLError as e:
        return {"__yaml_error__": str(e)}, fm_raw, body
    if not isinstance(data, dict):
        return {"__yaml_error__": "frontmatter 不是键值映射"}, fm_raw, body
    return data, fm_raw, body


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]  # OKF 允许 bare mapping


def normalize_document(text: str, cfg: dict, *, actor: str | None,
                       source_checked: bool | None, is_commit: bool,
                       tz_offset: str, doc_dir: Path | None = None):
    """
    纯函数：输入原文本，输出 (new_text, issues, meta)。
    fmt/lint/commit 共用，保证三者口径一致。
    """
    issues: list[Issue] = []
    data, fm_raw, body = split_frontmatter(text)

    if data is None:
        # 无 frontmatter：按 rustfmt 精神自动创建标准头部，正文整体保留为 body。
        data = {}
        fm_raw = None
        body = text.lstrip("﻿")
        issues.append(Issue("WARN", "FM-AUTOCREATE", "无 frontmatter，已自动创建标准头部"))
    if "__yaml_error__" in data:
        issues.append(Issue("ERROR", "FMT-YAML", f"YAML 解析失败：{data['__yaml_error__']}"))
        return text, issues, {}

    original_keys = list(data.keys())

    # ---- 1. type（缺失则按 kind 推断 / fallback）----
    if not str(data.get("type", "")).strip():
        kind = str(data.get("kind", "")).strip().lower()
        kind_map = cfg.get("type_infer", {}).get("kind_map", {})
        inferred = kind_map.get(kind) or cfg.get("type_fallback", "Note")
        data["type"] = inferred
        issues.append(Issue("WARN", "TYPE-AUTO", f"缺 type，已自动补为 {inferred}"))

    # ---- 2. status 归一化（中文 -> draft/stable/deprecated）----
    if "status" in data and data["status"] is not None:
        raw_status = str(data["status"]).strip()
        legal = cfg["status_legal"]
        smap = cfg.get("status_map", {})
        if raw_status in legal:
            data["status"] = raw_status
        elif raw_status in smap:
            data["status"] = smap[raw_status]
            issues.append(Issue("WARN", "STATUS-MAP",
                                f"status '{raw_status}' 归一化为 {data['status']}"))
        else:
            data["status"] = cfg.get("status_fallback", "stable")
            issues.append(Issue("WARN", "STATUS-UNKNOWN",
                                f"未识别 status '{raw_status}'，回退 {data['status']}"))

    # ---- 3. 时间字段标准化（stale_after 等）----
    for tk in ("stale_after",):
        if data.get(tk):
            norm = normalize_time(data[tk], tz_offset)
            if norm is None:
                issues.append(Issue("ERROR", "TIME-BAD", f"{tk} 不是合法时间：{data[tk]!r}"))
            else:
                data[tk] = norm

    # ---- 4. generated（更新者 + 最后更新时间）----
    gen = data.get("generated")
    gen = dict(gen) if isinstance(gen, dict) else {}
    if is_commit:
        gen["by"] = actor or gen.get("by") or cfg.get("default_actor") or ""
        gen["at"] = now_iso(tz_offset)
    else:
        # fmt/lint：只做形态标准化，不刷新时间
        if gen.get("at"):
            norm = normalize_time(gen["at"], tz_offset)
            if norm is None:
                issues.append(Issue("ERROR", "TIME-BAD",
                                    f"generated.at 不是合法时间：{gen['at']!r}"))
            else:
                gen["at"] = norm
    data["generated"] = gen

    # ---- 5. verified 列表规整 ----
    verified = as_list(data.get("verified"))
    clean_events = []
    for ev in verified:
        if isinstance(ev, dict) and ev.get("by"):
            at = ev.get("at")
            if at:
                nat = normalize_time(at, tz_offset)
                ev["at"] = nat if nat else at
            clean_events.append(dict(ev))
        # 丢弃无 by 的非法条目
    vcfg = cfg["verified"]
    lint_method = vcfg["lint_method"]
    sc_method = vcfg["source_check_method"]

    if is_commit:
        # 移除旧的工具自管理记录（按 method 去重，保留最新）
        clean_events = [e for e in clean_events if e.get("method") not in
                        (lint_method, sc_method)]
        stamp = data["generated"]["at"]
        # 5a. 格式门禁通过记录
        clean_events.append({"by": vcfg["append_lint_actor"], "at": stamp,
                             "method": lint_method})
        # 5b. 源检查记录
        if source_checked is True:
            clean_events.append({"by": data["generated"]["by"], "at": stamp,
                                 "method": sc_method})
            data["source_checked"] = True
            data["source_checked_at"] = stamp
        elif source_checked is False:
            data["source_checked"] = False
            # 本次声明未做源检查 → 不保留历史 source-check，避免误导
    data["verified"] = clean_events

    # ---- 6. source_checked（是否进行源检查，必填布尔）----
    sc = data.get("source_checked", None)
    if is_commit and source_checked is None:
        issues.append(Issue("ERROR", "SRC-REQUIRED",
                            "必须显式声明是否进行源检查：--source-checked / --no-source-checked"))
    elif (not is_commit) and sc is not None and not isinstance(sc, bool):
        issues.append(Issue("ERROR", "SRC-TYPE",
                            f"source_checked 必须是布尔 true/false，当前 {sc!r}"))

    # ---- 7. 必填门禁 ----
    # generated.by/at、source_checked 属于"提交期字段"：commit 时由工具(actor/时间)
    # 或用户(--source-checked 声明)补全。commit 模式是硬门禁；fmt/lint 模式仅 WARN
    # （表示尚未提交留痕），不阻断格式归一化。type 等格式字段缺失应已在第1步自动补。
    commit_only_fields = {
        "generated.by": "提交时由 --by 写入",
        "generated.at": "提交时自动刷新为当前时间",
        "source_checked": "提交时用 --source-checked/--no-source-checked 显式声明",
    }
    required = cfg.get("required", [])
    for field in required:
        if "." in field:
            head, sub = field.split(".", 1)
            obj = data.get(head) or {}
            ok = isinstance(obj, dict) and str(obj.get(sub, "")).strip()
        else:
            v = data.get(field)
            ok = (v is not None and str(v).strip() != "") if not isinstance(v, bool) else True
        if ok:
            continue
        if (not is_commit) and field in commit_only_fields:
            issues.append(Issue("WARN", "PENDING-COMMIT",
                                f"{field} 待提交补全（{commit_only_fields[field]}）"))
        else:
            issues.append(Issue("ERROR", "REQUIRED", f"必填字段缺失：{field}"))

    # ---- 8. status 合法性 ----
    if data.get("status") and data["status"] not in cfg["status_legal"]:
        issues.append(Issue("ERROR", "STATUS-BAD",
                            f"status 必须是 {cfg['status_legal']}，当前 {data['status']!r}"))

    # ---- 9. verified 每条必须 by+at ----
    for ev in data["verified"]:
        if not ev.get("by") or not ev.get("at"):
            issues.append(Issue("ERROR", "VERIFIED-BAD",
                                f"verified 条目必须同时含 by 和 at：{ev}"))

    # ---- 9.5 sources 路径校验（库外引用须软链接落地，见 70.3 §5）----
    if isinstance(data.get("sources"), list):
        kb_root = Path(__file__).resolve().parent.parent  # vault root
        kb_root_resolved = kb_root.resolve()
        # 相对路径以「文档所在目录」为基准（frontmatter 里 ../ 相对文档位置）
        base_dir = (doc_dir or kb_root).resolve()
        for idx, src in enumerate(data["sources"], start=1):
            if not isinstance(src, dict):
                continue
            p = str(src.get("path", "")).strip()
            if not p or p in ("...",):
                continue
            if p.startswith(("http://", "https://")):
                continue  # 外部 URL 不需要软链接
            # skill 名/占位符/记忆标记（无路径分隔符无扩展名的裸标识）→ 非文件引用，跳过
            if "/" not in p and "\\" not in p and "." not in p:
                continue
            # 库外绝对路径（Windows 盘符）→ 违规，须建软链接
            if re.match(r"^[A-Za-z]:[\\/]", p) or p.startswith("\\\\"):
                issues.append(Issue(
                    "ERROR", "SRC-OUTSIDE",
                    f"sources[{idx}].path 是库外绝对路径「{p}」：禁止。"
                    f"须在知识库内建软链接后改写为库内相对路径（见 70.3-资料策略 §5）"))
                continue
            # 库内相对路径：以文档目录为基准解析。
            # 词法判断是否在库内（junction/软链属于库内合法路径，不 resolve 展开），
            # 存在性用 resolve 后检查（junction 会展开到真实位置但 exists 为真）。
            try:
                lexical = (base_dir / p)  # 不 resolve，保留 junction 词法路径
                # 规范化（去 ..）后判断前缀
                norm = Path(os.path.normpath(str(lexical)))
                inside = norm == kb_root or kb_root in norm.parents
                abs_p = lexical.resolve()  # 存在性用展开后的真实路径
            except Exception:
                inside, abs_p = False, None
            if not inside:
                issues.append(Issue(
                    "ERROR", "SRC-OUTSIDE",
                    f"sources[{idx}].path「{p}」解析后落在知识库外（{norm}）："
                    f"须在库内建软链接指向该资源（见 70.3-资料策略 §5）"))
            elif (kb_root / "_raw") in norm.parents or norm == kb_root / "_raw" or str(norm).startswith(str(kb_root / "_raw") + os.sep):
                issues.append(Issue(
                    "ERROR", "SRC-RAW",
                    f"sources[{idx}].path「{p}」指向 _raw/ 目录（{norm}）："
                    f"禁止引用 raw 内容，须先提升移出 _raw 到正式位置（见 70.5 §1）"))
            elif not (abs_p and abs_p.exists()):
                issues.append(Issue(
                    "ERROR", "SRC-MISSING",
                    f"sources[{idx}].path「{p}」在知识库内不存在："
                    f"须建软链接或修正相对路径（见 70.3-资料策略 §5）"))

    # ---- 10. canonical 重排，未知字段按原顺序保留在后 ----
    canonical = cfg["canonical_order"]
    commit_only_keys = {"generated", "source_checked", "source_checked_at", "verified"}

    def _keep(k):
        if k not in data:
            return False
        v = data[k]
        empty = v is None or v == {} or v == [] or v == ""
        # fmt/lint 模式下，空的提交期字段不输出空壳，等 commit 时再写入
        if empty and (not is_commit) and k in commit_only_keys:
            return False
        return True

    ordered = [k for k in canonical if _keep(k)]
    ordered += [k for k in original_keys if _keep(k) and k not in canonical]
    # generated/source_* 若原文件没有但本次新建，也要纳入
    for k in ("generated", "source_checked", "source_checked_at", "verified"):
        if _keep(k) and k not in ordered:
            ordered.append(k)

    fm_lines = []
    for k in ordered:
        fm_lines += render_value_block(k, data[k])
    new_fm = "\n".join(fm_lines)
    head_sep = "" if body.startswith(("\n", "\r")) else "\n"
    new_text = f"---\n{new_fm}\n---\n{head_sep}{body}"
    if not body.endswith("\n"):
        new_text += "\n" if body else ""

    meta = {
        "type": data.get("type"),
        "status": data.get("status", "stable"),
        "tier": derive_tier(data["verified"]),
        "data": data,
    }
    return new_text, issues, meta


def derive_tier(verified: list[dict]) -> str:
    if not verified:
        return "unverified"
    if any(str(e.get("by", "")).startswith("human:") for e in verified):
        return "human-reviewed"
    return "machine-confirmed"


def extract_title(data: dict, full_text: str, rel: str) -> str:
    """标题优先级：frontmatter title > 正文第一个 H1 > 文件名（去扩展名）。"""
    t = str(data.get("title", "") or "").strip()
    if t:
        return t
    # 切掉 frontmatter 再找正文 H1，避免误匹配 YAML 的 # 注释
    body = full_text
    m0 = re.match(r"^---\r?\n.*?\r?\n---\r?\n?", full_text, re.DOTALL)
    if m0:
        body = full_text[m0.end():]
    m1 = re.search(r"^#\s+(.+?)\s*$", body, re.MULTILINE)
    if m1:
        return m1.group(1).strip()
    return Path(rel).stem


# ---------------------------------------------------------------------------
# git 封装
# ---------------------------------------------------------------------------

def git(args: list[str], cwd: Path, check=True):
    proc = subprocess.run(
        ["git"] + args, cwd=str(cwd), capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{proc.stderr.strip()}")
    return proc.stdout.strip()


def repo_root(start: Path) -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(start),
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise SystemExit("当前不在 git 仓库内。请先在知识库根目录 git init。")
    return Path(out.stdout.strip())


def is_tracked(path: Path, root: Path) -> bool:
    r = subprocess.run(["git", "ls-files", "--error-unmatch", str(path)],
                       cwd=str(root), capture_output=True, text=True)
    return r.returncode == 0


def porcelain_lines(root: Path):
    """git status --porcelain 原始行（不做全局 strip——行首空格是状态列，
    全局 strip 会吃掉第一个未暂存变更行的前导空格，导致 line[3:] 误删路径首字符）。"""
    proc = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=str(root), capture_output=True, text=True,
        encoding="utf-8", errors="replace")
    return proc.stdout.splitlines()


def _path_from_porcelain(line: str) -> str:
    """从一行 porcelain v1（'XY <path>'，前缀固定 3 列）取路径，处理 rename 与引号。"""
    p = line[3:].strip().strip('"')
    if " -> " in p:                        # rename: 'old -> new'
        p = p.split(" -> ", 1)[1].strip('"')
    return p.replace("\\", "/")


def changed_markdown(root: Path):
    """返回工作区有变更（含未跟踪）的 .md 文件列表（相对 root）。
    排除 _raw/ 目录（人源信息原始区，豁免 okf 格式归一，见 70.5 §1）。"""
    files = [_path_from_porcelain(line) for line in porcelain_lines(root)
             if line.strip()]
    files = [p for p in files if p.lower().endswith(".md")]
    files = [p for p in files if not p.startswith("_raw/")]
    # 去重保序
    seen, uniq = set(), []
    for f in files:
        if f not in seen:
            seen.add(f); uniq.append(f)
    return uniq


def changed_by_format(root: Path, cfg: dict):
    """工作区有变更（含未跟踪）的**受管目标**：`.md` 走 note；命中 `formats` 注册表的一律纳入。

    没有这一条，无参数的 `okf lint` 永远看不见 `.facts/`（`changed_markdown()` 只留 `.md`）
    ⇒ 事实源等于**没有门禁**。`_raw/` 的豁免与 `changed_markdown()` 保持一致。
    `format_for() == "unknown"` 的目标与改前一样被排除（库根下的 `.py` / `config.yaml` 等）。
    """
    files = [_path_from_porcelain(line) for line in porcelain_lines(root)
             if line.strip()]
    seen, uniq = set(), []
    for p in files:
        if p.startswith("_raw/"):
            continue
        if format_for(p, cfg) == "unknown":
            continue
        if p not in seen:
            seen.add(p); uniq.append(p)
    return uniq


# ---------------------------------------------------------------------------
# log.md 维护（OKF §9）
# ---------------------------------------------------------------------------

def update_log(root: Path, entries: list[tuple[str, str, str, bool]], cfg: dict):
    """entries: [(verb, rel_path, title, source_checked), ...]，最新在最上。"""
    if not cfg.get("log", {}).get("enabled", True):
        return None
    log_path = root / cfg["log"]["path"]
    today = dt.datetime.now().strftime("%Y-%m-%d")
    verbs = cfg["log"]["verbs"]
    lines = []
    for verb, rel, title, sc in entries:
        v = verbs.get(verb, "Update")
        name = title or rel
        sc_mark = "源检查✓" if sc else "未源检查"
        lines.append(f"* **{v}**: [{name}]({rel.replace(chr(92), '/')}) — {sc_mark}")
    block = "\n".join(lines)

    if not log_path.exists():
        text = f"# Knowledge Update Log\n\n## {today}\n{block}\n"
        log_path.write_text(text, encoding="utf-8", newline="\n")
        return log_path

    text = log_path.read_text(encoding="utf-8")
    sec_re = re.compile(rf"(## {re.escape(today)}\n)(.*?)(?=\n## |\Z)", re.DOTALL)
    m = sec_re.search(text)
    if m:
        existing = m.group(2).rstrip("\n")
        merged = m.group(1) + existing + "\n" + block + "\n"
        text = text[:m.start()] + merged + text[m.end():]
    else:
        # 在「头部块」之后插入今天的段（最新在上）。头部块 = 一级标题 +
        # 紧随的 HTML 注释 / 空行，确保说明注释始终停留在最前。
        insert_at = 0
        hm = re.match(r"^# .*?\n+", text)
        if hm:
            insert_at = hm.end()
            while True:
                mb = re.match(r"[ \t]*\n", text[insert_at:])
                mc = re.match(r"<!--.*?-->[ \t]*\n?", text[insert_at:], re.DOTALL)
                if mb:
                    insert_at += mb.end()
                elif mc:
                    insert_at += mc.end()
                else:
                    break
        text = text[:insert_at] + f"## {today}\n{block}\n\n" + text[insert_at:]
    log_path.write_text(text, encoding="utf-8", newline="\n")
    return log_path


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------

def collect_targets(paths, root: Path):
    # 相对路径一律相对「知识库根 root」解析，因此在任意工作目录调用都一致
    if paths:
        result = []
        for p in paths:
            pp = Path(p)
            ap = pp if pp.is_absolute() else (root / pp)
            try:
                rel = ap.resolve().relative_to(root).as_posix()
            except (OSError, ValueError):
                rel = p.replace("\\", "/")
            if rel.startswith("_raw/"):
                continue  # _raw 豁免 okf（见 70.5 §1）
            result.append(rel)
        return result
    return changed_markdown(root)


def changed_all(root: Path):
    """git 工作区全部变更（含未跟踪；gitignore 已过滤）的 rel 列表。"""
    files = [_path_from_porcelain(line) for line in porcelain_lines(root)
             if line.strip()]
    seen, uniq = set(), []
    for f in files:
        if f not in seen:
            seen.add(f); uniq.append(f)
    return uniq


def git_scoped_markdown(root: Path):
    """git 视野内全部 md：已跟踪 + 未跟踪但未被 .gitignore 忽略（尊重边界）。"""
    tracked = git(["ls-files", "*.md"], root)
    others = git(["ls-files", "--others", "--exclude-standard", "*.md"], root)
    rels = set()
    for blob in (tracked, others):
        for line in blob.splitlines():
            if line.strip():
                rels.add(line.strip().strip('"').replace("\\", "/"))
    return sorted(rels)


def _expand_one(path, root: Path):
    """显式路径 -> rel 列表；目录展开为其下未被 gitignore 忽略的文件。"""
    pp = Path(path)
    ap = pp if pp.is_absolute() else (root / pp)
    try:
        ap = ap.resolve()
        ap.relative_to(root)
    except (OSError, ValueError):
        return []
    if ap.is_file():
        return [ap.relative_to(root).as_posix()]
    if ap.is_dir():
        rels = []
        for f in ap.rglob("*"):
            if not f.is_file() or ".git" in f.parts:
                continue
            chk = subprocess.run(["git", "check-ignore", "-q", "--", f.as_posix()],
                                 cwd=str(root), capture_output=True)
            if chk.returncode != 0:          # 0=被忽略；非0=应纳入
                rels.append(f.relative_to(root).as_posix())
        return rels
    return []


def collect_commit_targets(paths, root: Path):
    """返回 `(md_targets, extra_files, missing)`。

    · `md_targets`  —— 走 frontmatter 治理的 `.md`（note 格式）
    · `extra_files` —— **原样入库、不做治理**的三类：
        ① 非 `.md` 文件；② `_raw/**`（70.5 §1：「进 git 全量追踪」＋「豁免 okf 格式归一」）；
        ③ **磁盘上已不存在**的目标（已删除/改名）—— 改不动，只把这次删除记进快照。
    · `missing`     —— **显式给出**、但既不在库里也不存在于 HEAD 的路径（拼错 / 库外）
        ⇒ 调用方**必须报错**，不许静默忽略（与 `okf lint` 的 `PATH-NOT-FOUND` 同一判据）。

    ★ 2026-10-04 修（沙箱复现）：改前这里把「git status 里的删除项」也当普通 md 目标，
      第 1 阶段 `read_text()` 直接抛 `FileNotFoundError` + traceback；
      且显式传一个不存在的路径会**静默返回"没有需要提交的变更"**（lint 却报 rc=1）。
    """
    raw = []
    missing = []
    if paths:
        for p in paths:
            pp = Path(p)
            ap = pp if pp.is_absolute() else (root / pp)
            try:
                ap = ap.resolve()
                rel = ap.relative_to(root).as_posix()
                inside = True
            except (OSError, ValueError):
                inside, rel = False, p.replace("\\", "/")
            if not inside or not ap.exists():
                # 不存在：库内且 HEAD 里有 ⇒ 这是**待提交的删除**，只 add（不治理）；
                # 否则 = 拼错 / 库外 ⇒ 交给 missing，由 cmd_commit 明确报错。
                if inside and is_tracked(root / rel, root):
                    raw.append(rel); continue
                missing.append(p); continue
            raw.extend(_expand_one(p, root))
    else:
        raw = changed_all(root)

    seen, md, extra = set(), [], []
    for f in raw:
        if f in seen:
            continue
        seen.add(f)
        if f.startswith("_raw/"):
            extra.append(f); continue          # 70.5 §1：_raw 进 git，但豁免 okf 归一
        if not (root / f).is_file():
            extra.append(f); continue          # 已删除/非常规文件：无法治理，只纳入提交
        if f.lower().endswith(".md"):
            md.append(f)
        else:
            extra.append(f)
    return md, extra, missing


def is_reserved(rel: str, cfg) -> bool:
    return Path(rel).name.lower() in [x.lower() for x in cfg["reserved_filenames"]]


def format_for(rel: str, cfg) -> str:
    """按 `config.yaml` 的 `formats:` 注册表（路径前缀 -> 格式名）分派目标格式。

    返回值只有三种：
      · 注册表命中的格式名 —— 今天只有 `"facts"`（`.facts/` 前缀）
      · `"note"`          —— **未命中且目标是 note 形态**（`.md`）= 默认格式
      · `"unknown"`       —— **未命中且不是 note 形态**（库根下的 x.yaml / 目录 / 失效路径）

    ⚠️ `"unknown"` 这一档是为「**零回归**」而留的，不是多余的：
    注册表落地前 `okf fmt x.yaml` 就是被拒绝改写的（S1 判据 = `.md` 后缀）。若把
    unknown 也算进默认 note，`okf fmt <库根下任意 yaml/json/py 路径>` 会重新变成
    「改写并写坏内容」—— 2026-09-27 实测：对一份裸 YAML 执行后 rc=0、文件头被插入
    `---\\ntype: Note\\n---\\n`、sha256 改变。那正是 S1 刚堵掉的缺陷，不能再放出来。

    ⚠️ **调用方必须先判 `is_reserved()`，再调本函数**，顺序固定为
    `is_reserved` -> `formats` -> 默认 note。顺序反了，`.facts/README.md`
    会被 `facts` 格式抢走，丢掉保留文件名豁免。

    为什么 `cmd_fmt` 必须靠这道闸：它走的 `collect_targets()` **不按扩展名过滤**
    （只有 `cmd_commit` 那条路才按 `.md` 二分），而 `normalize_document()` 在拿不到
    frontmatter 时会**自动补一个标准头**（`type` 走 `type_fallback` = `Note`）。
    对 YAML 这类数据文件，`---` 是 **YAML 的文档分隔符** ⇒ 文件变成**多文档流**，
    真数据退化成第二个文档，下游 `yaml.safe_load` 只能拿到 `{type: Note}` 或直接报错
    ⇒ **内容被破坏**。事实源是权威层（只有用户能写、逐字确认），
    任何工具能自动改写它 = 破坏权威链，所以注册表里非 note 的格式**硬拒**。
    """
    r = str(rel).replace("\\", "/")
    for prefix, name in (cfg.get("formats") or {}).items():
        p = str(prefix).replace("\\", "/")
        if p and r.startswith(p):
            return str(name)
    return "note" if r.lower().endswith(".md") else "unknown"


# ---------------------------------------------------------------------------
# facts 格式（`.facts/` 事实源）静态校验
#   —— 语义权威：FACTS_rule-gate.md §11.1 · §11.4（闭包体量 WARN）· §13 判据 6（至少被一个域可达）
#      · §2 原则 5 · §5.4 · §12.1 · §12.3
#   —— error code 映射表：`.okf/README.md` 第十二节
#   ★ 只做**结构事实**（可机械判定）；语义 / 重合 / 表述一律不在这里判（KB 30-Agent工程/30.12-能力设计与投放.md@2026-09-29 §闸门分界）。
# ---------------------------------------------------------------------------

def _facts_files(root: Path, prefix: str):
    """prefix 下的全部 YAML 文件（相对 KB 根的 posix 前缀，带结尾斜杠）。"""
    d = root / prefix
    if not d.is_dir():
        return []
    return sorted(p for p in d.rglob("*")
                  if p.is_file() and p.suffix.lower() in (".yaml", ".yml"))


def _cycle_key(cyc: list):
    """环路径的规范形（从最小节点转起），用于去掉 A→B→A 与 B→A→B 这类同环重复。"""
    body = cyc[:-1]
    if not body:
        return ()
    i = body.index(min(body))
    return tuple(body[i:] + body[:i])


def find_domain_cycles(adj: dict, nodes) -> list:
    """域引用图的环检测 —— ★ **当前路径栈**判环，**不用「已访问集合」**（FACTS §5.4）。

    两者不是等价的：`visited` 会把 `A→B→A` 误剪枝成合法，又会对菱形
    `A→B, A→C, B→D, C→D` 误判。这里只维护 `stack`（= 当前路径），
    所以"同一节点从两条路都能到"不会报环，"回到自己路径上的节点"才报环。
    返回去重后的环路径列表（每个环 = 节点序列，首尾同一节点）。
    """
    cycles, seen = [], set()

    def dfs(node, stack):
        for nxt in adj.get(node, []):
            if nxt in stack:
                cyc = stack[stack.index(nxt):] + [nxt]
                key = _cycle_key(cyc)
                if key not in seen:
                    seen.add(key)
                    cycles.append(cyc)
                continue
            dfs(nxt, stack + [nxt])

    for n in nodes:
        dfs(n, [n])
    return cycles


def domain_closure(doms: dict, key: str):
    """单域闭包：该域**直接持有**的 fact id ∪ 它**可达**的域所持有的 fact id（按 id 去重）。

    语义权威 `FACTS §5.4 resolve()` ＋ §11.4（★ S3c）：
    域**不设链深上限**（无环已保证终止），管的是「**闭包后的实际事实数**」。

    ⚠️ 这里用 `visited` 集合做**可达性**（并集与路径无关），**不承担判环**：
    环由 `find_domain_cycles()` 用**当前路径栈**单独报 `FACTS-CYCLE`
    （§5.4 的坑是"用 visited **判环**"，不是"用 visited **求并集**"）。
    悬空 ref 同理已单独报 `FACTS-REF-MISSING`，这里跳过 ⇒ 一定终止。
    """
    out, seen, stack = set(), set(), [key]
    while stack:
        k = stack.pop()
        if k in seen:
            continue
        seen.add(k)
        out.update(doms[k]["facts"])
        stack.extend(r for r in doms[k]["refs"] if r in doms)
    return out


def validate_facts(root: Path, cfg: dict):
    """`.facts/` 的结构校验（**十条 ERROR ＋ 一条 WARN**，跨文件 ⇒ 整棵树只跑一次），返回 `Issue` 列表。

    | # | 规则 | code |
    |---|---|---|
    | 1 | 环引用（路径栈判环，输出环路径） | `FACTS-CYCLE` |
    | 2 | refs 悬空 | `FACTS-REF-MISSING` |
    | 3 | fact id 悬空 | `FACTS-ID-MISSING` |
    | 4 | id 唯一（池内） | `FACTS-DUP-ID` |
    | 5 | schema（字段缺失 / 类型错） | `FACTS-SCHEMA` · `FACTS-YAML` · `FACTS-VTYPE` · `FACTS-TOLERANCE` · `FACTS-ENUM` · `FACTS-CHECKABLE` · `FACTS-TERMS` · `FACTS-SHAPE` |
    | 6 | 命名规范（subject / predicate） | `FACTS-NAME` |
    | 7 | `match` 撞名 | `FACTS-MATCH-AMBIG` |
    | 8 | `proposals` id 不撞池 | `FACTS-PROP-ID` |
    | 9 | 通用域 refs 必须为空 | `FACTS-GENERAL-REFS` |
    | 10 | **单域闭包体量 > 阈值（★ S3c）** —— **WARN，不拦截** | `FACTS-CLOSURE-LARGE` |
    | 11 | **孤儿事实：池里有、没有任何域的 `facts` 列出（★ S3d）** | `FACTS-ORPHAN` |

    ★ **除第 10 条外一律 ERROR（拦提交）；第 10 条是唯一一条 WARN**（`FACTS §11.4`：超限域
    **不参与拦截**）⇒ 它**不进** `cmd_lint` / `cmd_commit` 的 error 计数，**rc 不受影响**。

    ★ **S3b（2026-09-27）**：第 5 条补上 `FACTS §4.2`「新增的三个字段」——
    `checkable_by`（必填 · 数组 · 元素在枚举内）· `terms`（含 `structured` 时必填 · 非空字符串数组）
    · `shape`（含 `structured` 时必填 · 在枚举内）。**枚举与联动必填全部读 `config.yaml` 的
    `facts:` 段**（`checkable_by_values` / `structured_layer` / `structured_requires` / `shape_values`），
    代码里只留"读哪个字段"这一点结构。

    ★ **S3d（2026-09-27 · 用户指令「要求必须进行 okf 校验，这个逻辑进 okf 校验」）**：
    第 11 条 = **孤儿事实** —— **事实池里的每一条 id 必须被至少一个域的 `facts` 列表列出**；
    池里有、但**没有任何域列出它** ⇒ **ERROR**。它不是洁癖：域才是**加载单元**，孤儿事实
    **永远不会进加载集合**，而系统**看起来一切正常**（这类**静默失效**只能由静态校验兜住）。
    ★ **两条边界**（写下来免得下一次弄反）：
    ① **多域列出同一条是合法的**（KB .facts/README.md@2026-09-29「事实可以重复」）⇒ 只判"**有没有**域列出"，**不判次数**；
    ② 域之间 `refs` 的**可达性不改变本判据** —— 判的就是"有没有某个域的 `facts` **直接**列出它"。
    """
    fc = cfg.get("facts") or {}
    pool_pfx = fc.get("pool", ".facts/facts/")
    dom_pfx = fc.get("domains", ".facts/domains/")
    pro_pfx = fc.get("proposals", ".facts/proposals/")
    general = fc.get("general_domain", "general")
    ws_pfx = fc.get("workspaces_prefix", "workspaces/")
    tmp_pfx = fc.get("tmp_id_prefix", "tmp-")
    subj_re = re.compile(fc.get("subject_re") or r"^[a-z0-9]+([._][a-z0-9]+)*$")
    pred_re = re.compile(fc.get("predicate_re") or r"^[a-z0-9]+(-[a-z0-9]+)*$")
    scoped_subject = bool(fc.get("scoped_subject", True))
    required = list(fc.get("fact_required") or
                    ["id", "statement", "subject", "predicate", "value", "value_type"])
    vtypes = set(fc.get("value_types") or [])
    fstatus = set(fc.get("fact_status") or [])
    need_tol = bool(fc.get("require_tolerance_for_number", True))
    # ---- ★ S3b：FACTS §4.2「新增的三个字段」的枚举与联动必填（一律读 config，不写死）----
    ck_values = list(fc.get("checkable_by_values") or ["structured", "lexical", "semantic"])
    structured_layer = fc.get("structured_layer", "structured")
    structured_requires = list(fc.get("structured_requires") or ["terms", "shape"])
    shape_values = list(fc.get("shape_values") or ["version", "int", "path", "literal", "none"])

    issues: list[Issue] = []

    def err(code, msg):
        issues.append(Issue("ERROR", code, msg))

    def relof(fp: Path) -> str:
        return fp.relative_to(root).as_posix()

    def load(fp: Path):
        try:
            return yaml.safe_load(fp.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            err("FACTS-YAML", f"{relof(fp)} YAML 解析失败：{str(e).splitlines()[0]}")
        except OSError as e:
            err("FACTS-YAML", f"{relof(fp)} 读取失败：{e}")
        return None

    # ---- 事实池：schema · 命名 · id 唯一 ----
    pool_ids = {}                      # id -> [出处, ...]
    for fp in _facts_files(root, pool_pfx):
        data = load(fp)
        if data is None:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
            err("FACTS-SCHEMA", f"{relof(fp)} 顶层必须是 `facts:` 列表")
            continue
        for i, f in enumerate(data["facts"]):
            loc = f"{relof(fp)}#facts[{i}]"
            if not isinstance(f, dict):
                err("FACTS-SCHEMA", f"{loc} 不是键值映射")
                continue
            miss = [k for k in required if k not in f]
            if miss:
                err("FACTS-SCHEMA", f"{loc} 缺必填字段：{', '.join(miss)}")
            fid = f.get("id")
            if isinstance(fid, str) and fid.strip():
                pool_ids.setdefault(fid, []).append(loc)
            elif "id" not in miss:
                err("FACTS-SCHEMA", f"{loc} id 不是非空字符串：{fid!r}")
            subj, pred = f.get("subject"), f.get("predicate")
            if isinstance(subj, str) and (not subj_re.match(subj)
                                          or (scoped_subject and "." not in subj)):
                err("FACTS-NAME", f"{loc} subject 不合规范（点分小写 ＋ 范围前缀）：{subj!r}")
            if isinstance(pred, str) and not pred_re.match(pred):
                err("FACTS-NAME", f"{loc} predicate 不合规范（kebab-case 小写）：{pred!r}")
            vt = f.get("value_type")
            if vt is not None and vtypes and vt not in vtypes:
                err("FACTS-VTYPE", f"{loc} value_type 不在枚举内：{vt!r}"
                                   f"（合法：{', '.join(sorted(vtypes))}）")
            elif vt == "number" and need_tol and f.get("tolerance") is None:
                err("FACTS-TOLERANCE", f"{loc} value_type=number 必须给 tolerance（§12.2）")
            elif vt == "enum":
                allowed = f.get("allowed")
                if not isinstance(allowed, list) or f.get("value") not in allowed:
                    err("FACTS-ENUM", f"{loc} value_type=enum 必须给 allowed 且 value 在内")
            st = f.get("status")
            if st is not None and fstatus and st not in fstatus:
                err("FACTS-SCHEMA", f"{loc} status 不在枚举内：{st!r}")

            # ★ S3b：FACTS §4.2「新增的三个字段」—— checkable_by / terms / shape
            #   ① `checkable_by` 必填（在 config 的 fact_required 里 ⇒ 缺了已由上面的
            #      `miss` 报过 FACTS-SCHEMA，这里不重复报）· 必须是**非空字符串数组**
            #      · 元素必须在 `checkable_by_values` 枚举内
            #   ② `checkable_by` 含 `structured_layer` ⇒ `structured_requires`（terms / shape）**全部必填**
            #   ③ `terms` 存在即必须是非空字符串数组（与 `value_type` 同口径：存在就校验）
            #   ④ `shape` 存在即必须在 `shape_values` 枚举内
            #   ⚠️ ④③ 与 ② 是两件事：② 管"缺不缺"，③④ 管"给了的东西合不合法"。
            ck = f.get("checkable_by")
            if "checkable_by" not in miss:
                if not isinstance(ck, list) or not ck or not all(isinstance(x, str) for x in ck):
                    err("FACTS-CHECKABLE",
                        f"{loc} checkable_by 必须是非空字符串数组（§4.2）：{ck!r}")
                else:
                    bad = [x for x in ck if x not in ck_values]
                    if bad:
                        err("FACTS-CHECKABLE",
                            f"{loc} checkable_by 值不在枚举内："
                            f"{', '.join(repr(x) for x in bad)}"
                            f"（合法：{', '.join(ck_values)}）")
                    if structured_layer in ck:
                        for rf in structured_requires:
                            if rf not in f:
                                err("FACTS-SCHEMA",
                                    f"{loc} checkable_by 含 {structured_layer} ⇒ {rf} 必填（§4.2）")
            terms = f.get("terms")
            if "terms" in f and (not isinstance(terms, list) or not terms
                                 or not all(isinstance(x, str) and x.strip() for x in terms)):
                err("FACTS-TERMS",
                    f"{loc} terms 必须是非空字符串数组（§4.2）：{terms!r}")
            shape = f.get("shape")
            if "shape" in f and shape not in shape_values:
                err("FACTS-SHAPE",
                    f"{loc} shape 不在枚举内：{shape!r}（合法：{', '.join(shape_values)}）")
    for fid in sorted(pool_ids):
        locs = pool_ids[fid]
        if len(locs) > 1:
            err("FACTS-DUP-ID", f"事实池内 id 重复 {len(locs)} 次：{fid} —— " + " · ".join(locs))

    # ---- 域：schema · id/refs 可解析 · 通用域 refs 为空 · match 撞名 ----
    doms = {}
    for fp in _facts_files(root, dom_pfx):
        relp = relof(fp)
        key = relp[len(dom_pfx):] if relp.startswith(dom_pfx) else relp
        key = str(Path(key).with_suffix("")).replace("\\", "/")
        data = load(fp)
        if data is None:
            continue
        if not isinstance(data, dict):
            err("FACTS-SCHEMA", f"{relp} 顶层不是键值映射")
            continue
        ok = True
        facts = data.get("facts")
        if not isinstance(facts, list) or not all(isinstance(x, str) for x in facts):
            err("FACTS-SCHEMA", f"{relp}（域 {key}）`facts:` 必须是 fact id 字符串列表")
            facts, ok = [], False
        refs = data.get("refs")
        if refs is None:
            refs = []                       # 缺 refs 视同空（不额外报 schema）
        elif not isinstance(refs, list) or not all(isinstance(x, str) for x in refs):
            err("FACTS-SCHEMA", f"{relp}（域 {key}）`refs:` 必须是域名字符串列表")
            refs, ok = [], False
        if ok:
            doms[key] = {"rel": relp, "facts": facts, "refs": refs, "data": data}

    for key in sorted(doms):
        d = doms[key]
        for fid in d["facts"]:
            if fid not in pool_ids:
                err("FACTS-ID-MISSING", f"{d['rel']}（域 {key}）引用的 fact id 不在池中：{fid}")
        for r in d["refs"]:
            if r not in doms:
                err("FACTS-REF-MISSING",
                    f"{d['rel']}（域 {key}）refs 指向不存在的域：{r}（缺 {dom_pfx}{r}.yaml）")

    if general in doms and doms[general]["refs"]:
        err("FACTS-GENERAL-REFS",
            f"{doms[general]['rel']}（通用域 {general}）refs 必须为空（§2 原则 5），"
            f"实际：{doms[general]['refs']}")

    matches = {}
    for key in sorted(doms):
        if not key.startswith(ws_pfx):
            continue                        # 只有 workspaces/ 有 match（projects/ 靠主动加载）
        m = doms[key]["data"].get("match")
        name = m.get("name") if isinstance(m, dict) else None
        if isinstance(name, str) and name:
            matches.setdefault(name, []).append(f"{key}（{doms[key]['rel']}）")
    for name in sorted(matches):
        if len(matches[name]) > 1:
            err("FACTS-MATCH-AMBIG",
                f"工作区域撞名：match.name={name!r} 被 {len(matches[name])} 个域命中 —— "
                + " · ".join(matches[name]))

    # ---- 环引用（路径栈判环；只走存在的 refs，悬空 ref 已单独报 FACTS-REF-MISSING）----
    adj = {k: [r for r in doms[k]["refs"] if r in doms] for k in doms}
    for cyc in find_domain_cycles(adj, sorted(doms)):
        err("FACTS-CYCLE", "循环引用：" + " → ".join(cyc))

    # ---- 10. 单域闭包体量（★ S3c · FACTS §11.4 · 用户 2026-09-27 定案）----
    #   「链**不需要设限**，但是**单个 list 加上链接的事实超过 80 个报警**，
    #    **我不希望一个 list 看起来小但是实际上大的离谱**」
    #   ⇒ 算该域 `resolve()`（自身 facts ∪ 可达域的 facts，按 id 去重）后的**事实数**，
    #     `> 阈值` 报一条 **WARN**。★ `§11.4`：超限域**不参与拦截** ⇒ 只 WARN、不影响 rc。
    #   ⚠️ 阈值**只从 config 读**（`facts.domain_closure_warn`）：缺失 / 非正整数 ⇒
    #     **该项检查不启用**（代码里不写死数字，免得又留一处会漂移的副本）。
    _th = fc.get("domain_closure_warn")
    try:
        warn_th = 0 if isinstance(_th, bool) else int(_th)
    except (TypeError, ValueError):
        warn_th = 0
    if warn_th < 0:
        warn_th = 0
    if warn_th > 0:
        for key in sorted(doms):
            n = len(domain_closure(doms, key))
            if n > warn_th:
                issues.append(Issue(
                    "WARN", "FACTS-CLOSURE-LARGE",
                    f"{doms[key]['rel']}（域 {key}）闭包后有 {n} 条事实，超过阈值 {warn_th}"
                    f"（config.yaml facts.domain_closure_warn · §11.4）—— 链深不设上限，"
                    f"但闭包过大会撑大语料、让「有支撑」更容易误成立；该域不参与拦截"))

    # ---- 11. 孤儿事实（★ S3d · FACTS §13 判据 6 · 用户 2026-09-27 指令「这个逻辑进 okf 校验」）----
    #   定义：**事实池里的每一条 id 必须被至少一个域的 `facts` 列表列出**。
    #   池里有、但**没有任何域列出它** ⇒ **ERROR**（与其余 ERROR 同级 ⇒ 拦 `commit`、让 `lint` rc=1）。
    #   为什么必须是 ERROR：域才是**加载单元**，孤儿事实**永远不会进加载集合**，
    #   而门禁**看起来一切正常**（Lead 2026-09-27 亲身踩过：10 条事实已落进池子、域引用那一步
    #   没写上 ⇒ 九条校验一条都没报、全说"全部通过"）⇒ 这类**静默失效**只能由静态校验兜住。
    #   ★ 两条边界（写下来免得下一次弄反）：
    #     ① **多域列出同一条是合法的**（KB .facts/README.md@2026-09-29「事实可以重复」；加载时并集去重）
    #        ⇒ 这里只判"**有没有**域列出它"，**不判次数** ⇒ 绝不把"被多个域引用"当孤儿。
    #     ② 域之间 `refs` 的**可达性不改变本判据** —— 判的就是「有没有某个域的 `facts`
    #        **直接**列出它」，与它是否从 general / active_projects 可达无关。
    listed = set()
    for key in doms:
        listed.update(doms[key]["facts"])
    for fid in sorted(pool_ids):
        if fid not in listed:
            err("FACTS-ORPHAN",
                f"{pool_ids[fid][0]} 的 fact id 没有被任何域的 `facts` 列出：{fid}"
                f" —— 池里有、但没有域列出它 ⇒ 永远不会进加载集合"
                f"（FACTS §13 判据 6：至少被一个域可达）")

    # ---- proposals：候选 id 不得撞池（未确认前不占 id，§12.3）----
    for fp in _facts_files(root, pro_pfx):
        data = load(fp)
        if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
            continue                        # proposals 形状自由，只查"id 撞池"这一条
        for i, f in enumerate(data["facts"]):
            if not isinstance(f, dict):
                continue
            fid = f.get("id")
            if isinstance(fid, str) and fid in pool_ids and not fid.startswith(tmp_pfx):
                err("FACTS-PROP-ID",
                    f"{relof(fp)}#facts[{i}] 候选事实 id 与事实池冲突：{fid}"
                    f"（未确认的候选只能用 {tmp_pfx}* 或不写 id）")
    return issues


class NoteReadError(Exception):
    """读 note 文本的失败。四类坏输入各给一个稳定 code，绝不外抛 traceback。

    稳定性契约见 tasks/runs/kb-service/INTERFACE.md §3。
    """

    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def read_note_text(fp: Path, rel: str) -> str:
    """读一份 note 的 UTF-8 文本；失败抛 NoteReadError(code)。

    code 取值：PATH-NOT-FOUND / DIR-NOT-EXPANDED / PATH-NOT-READABLE / NOT-UTF8。
    优先读 bytes 再解码，避免 read_text 在不同 Python 版本上把编码错误抬成不同异常类。
    """
    try:
        if fp.is_dir():
            raise NoteReadError("DIR-NOT-EXPANDED",
                                f"{rel} 是目录：okf 的目标必须是显式文件路径")
        if not fp.exists():
            raise NoteReadError("PATH-NOT-FOUND", f"{rel} 不存在")
        data = fp.read_bytes()
    except NoteReadError:
        raise
    except PermissionError as exc:
        raise NoteReadError("PATH-NOT-READABLE", f"{rel} 无读权限：{exc}") from exc
    except OSError as exc:
        raise NoteReadError("PATH-NOT-READABLE", f"{rel} 读取失败：{exc}") from exc
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NoteReadError("NOT-UTF8",
                            f"{rel} 不是 UTF-8（首个坏字节位置 {exc.start}）：请转码后再入库") from exc


def cmd_fmt(args, cfg, root):
    tz = cfg["timezone"]
    targets = collect_targets(args.paths, root)
    if not targets:
        print("没有需要处理的 Markdown 文件。"); return 0
    changed = 0
    refused = 0
    failed = 0
    for rel in targets:
        if is_reserved(rel, cfg):
            continue
        # ★ 派发顺序固定：is_reserved（上一行）-> formats -> 默认 note。
        fmt = format_for(rel, cfg)
        if fmt == "unknown":
            # 未命中注册表且不是 note 形态（数据文件 / 目录 / 失效路径）。
            # 措辞与注册表落地前**逐字相同** —— 这一档的行为必须零回归。
            print(f"· {rel}（跳过：非 note 格式，拒绝改写 —— okf fmt 只处理 .md）")
            refused += 1
            continue
        if fmt != "note":
            # 注册表命中的非 note 格式（今天只有 facts）：拒绝改写，
            # 绝不让 normalize_document 的结果落盘。
            print(f"· {rel}（跳过：格式 {fmt}，拒绝改写 —— okf fmt 只改写 note 格式）")
            refused += 1
            continue
        fp = root / rel
        try:
            text = read_note_text(fp, rel)
        except NoteReadError as exc:
            print(f"✗ {rel}")
            print(f"    {Issue('ERROR', exc.code, exc.msg)}")
            failed += 1
            continue
        new_text, issues, _ = normalize_document(
            text, cfg, actor=None, source_checked=None,
            is_commit=False, tz_offset=tz, doc_dir=fp.parent)
        errs = [i for i in issues if i.level == "ERROR"]
        if errs:
            print(f"✗ {rel}")
            for i in errs: print(f"    {i}")
            continue
        if new_text != text:
            fp.write_text(new_text, encoding="utf-8", newline="\n"); changed += 1
            print(f"✓ fmt {rel}")
        else:
            print(f"· {rel}（已是标准格式）")
    if refused:
        # 有文件被拒绝改写 ⇒ 硬失败（rc=1），让调用方（脚本 / 计划任务）能判出来。
        # refused == 0 时下面两行与退出码与改前逐字节相同（A8 零回归）。
        print(f" 跳过 {refused} 个非 note 文件（拒绝改写）。")
    if failed:
        print(f" 读取失败 {failed} 个文件（未改写）。")
    print(f"\n格式化完成：改写 {changed} 个文件。")
    return 1 if (refused or failed) else 0


def lint_targets(paths, root: Path, cfg: dict):
    """lint 的目标分派：显式路径先分三类 —— **目录** / **不存在或不是常规文件** / 其余。

    `okf` 的目标语义是「**显式路径**」：静默展开目录会扫到调用者没点的文件，
    而 `.facts/` 是**权威层**（只有用户能写），更不能被顺带扫进来。
    改前「不是常规文件」的两类都会在下一行的 `read_text()` 上抛异常
    （看板卡 e01c497a / 8165d4e0）：`okf lint <目录>` → PermissionError、
    `okf lint <不存在的路径>` → FileNotFoundError —— 退出码都是 1，但**都带完整 traceback**。
    这里两类都变成**明确报错**（`DIR-NOT-EXPANDED` / `PATH-NOT-FOUND`），退出码不变，
    且这两类路径**一个文件都不读**。

    判据就是 `Path.is_file()`（事实 `OPS-OKF-LINT-ARGS`：okf lint 的目标必须解析到常规文件）：
    「不是常规文件」= 不存在 / 目录 / 其它 ⇒ 一律报错，**不静默跳过**。
    ⚠️ 推论：`_raw/` 的豁免只在路径**存在**时成立 —— 不存在的 `_raw/…` 同样是错误参数
    （改前它被 `collect_targets()` 静默丢弃、rc=0，那是"假通过"）。

    返回 `(dirs, missing, targets)`；前两项都以**相对库根的 posix 路径**给出
    （库外路径按调用者原样给，与 `collect_targets()` 的口径一致），
    第三项与改前**逐字节相同**。
    """
    if not paths:
        return [], [], changed_by_format(root, cfg)
    dirs, missing, keep = [], [], []
    for p in paths:
        ap = Path(p)
        if not ap.is_absolute():
            ap = root / ap
        try:
            rel = ap.resolve().relative_to(root).as_posix()
        except (OSError, ValueError):
            rel = p.replace("\\", "/")
        if ap.is_dir():
            dirs.append(rel)
        elif ap.is_file():
            keep.append(p)
        else:
            missing.append(rel)
    return dirs, missing, (collect_targets(keep, root) if keep else [])


def cmd_lint(args, cfg, root):
    tz = cfg["timezone"]
    dir_rels, missing_rels, targets = lint_targets(args.paths, root, cfg)
    n_err = 0
    for rel in dir_rels:
        # ★ 目录参数：明确报错，不展开、不递归（绝不去读目录本身，改前那一步是崩溃点）
        print(f"✗ {rel}")
        print(f"    {Issue('ERROR', 'DIR-NOT-EXPANDED', '目录参数不展开：okf 的目标是显式文件路径，'
                                                      '请指向具体文件（例：okf lint .facts/domains/general.yaml）')}")
        n_err += 1
    for rel in missing_rels:
        # ★ 不存在 / 非常规文件：同一形态的明确报错（改前是 FileNotFoundError + traceback）
        print(f"✗ {rel}")
        print(f"    {Issue('ERROR', 'PATH-NOT-FOUND', '路径不存在或不是常规文件：okf 的目标是显式文件路径，'
                                                    '请确认路径拼写（例：okf lint .facts/domains/general.yaml）')}")
        n_err += 1
    fact_rels = []
    for rel in targets:
        if is_reserved(rel, cfg):
            print(f"· {rel}（保留文件，跳过 concept 校验）"); continue
        if format_for(rel, cfg) not in ("note", "unknown"):
            # **注册表命中**的非 note 格式（今天只有 facts）：**不做**逐文件 frontmatter 归一
            # （那正是会写坏 YAML 的那条路），改由下面的 validate_facts() 整棵树一次性校验
            # —— id 唯一 / 环 / refs 都是跨文件判据，逐文件跑不出来。
            # ⚠️ `unknown` 必须**继续走 note 路径**（= 改前的 read_text + normalize_document），
            # 否则 `okf lint <库根下任意 .yaml>` 的输出会变 —— 那是"零回归红线"要的黑白。
            fact_rels.append(rel); continue
        try:
            text = read_note_text(root / rel, rel)
        except NoteReadError as exc:
            print(f"✗ {rel}")
            print(f"    {Issue('ERROR', exc.code, exc.msg)}")
            n_err += 1
            continue
        _, issues, meta = normalize_document(
            text, cfg, actor=None, source_checked=None,
            is_commit=False, tz_offset=tz, doc_dir=(root / rel).parent)
        # 一致性校验：声明 vs 实际（人源信息检测，见 70.5 §3）
        issues += check_declared_vs_actual(root, rel, meta.get("data") or {})
        errs = [i for i in issues if i.level == "ERROR"]
        warns = [i for i in issues if i.level == "WARN"]
        tag = "✗" if errs else ("!" if warns else "✓")
        tier = meta.get("tier", "-")
        print(f"{tag} {rel}  [tier={tier}]")
        for i in errs + warns:
            print(f"    {i}")
        n_err += len(errs)
    if fact_rels:
        # facts 格式：整棵树跑一次 validate_facts()（跨文件判据），输出形态与 note 一致
        f_issues = validate_facts(root, cfg)
        f_errs = [i for i in f_issues if i.level == "ERROR"]
        f_warns = [i for i in f_issues if i.level == "WARN"]
        tag = "✗" if f_errs else ("!" if f_warns else "✓")
        froot = (cfg.get("facts") or {}).get("root", ".facts/")
        print(f"{tag} 事实源 {froot}（格式 facts：整棵树一次性校验，触发路径 {len(fact_rels)} 个）")
        for i in f_errs + f_warns:
            print(f"    {i}")
        n_err += len(f_errs)
    print(f"\n检查完成：{n_err} 个错误。" + ("存在不合规文件，禁止提交。" if n_err else "全部通过。"))
    return 1 if n_err else 0


# ---- actor 格式门禁（--by 必填，且必须能追到会话）----
# 动因：如果示例文档写死 human:<id>，agent 照抄 → verified 出现 human:* →
# derive_tier 把文档判成 human-reviewed（伪造人工复核）。
ACTOR_RE = re.compile(
    r"^(?:human:[A-Za-z0-9_.-]+"
    r"|process:[A-Za-z0-9_.-]+"
    r"|agent:[a-z0-9][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9_.:-]*)$")

ACTOR_HELP = """--by 格式（必填，用于从会话记录追溯提交者）：
  agent:<runtime>:<sessionId>   有会话的 agent，例 agent:dsh:20260101_120000_abcdef01
  process:<name>                无会话的自动化通道（cron/脚本），例 process:night-commit
  human:<id>                    仅用户本人手写；agent 一律不得使用
                                （verified 里一旦出现 human:* 会把文档判成 human-reviewed）
  ⚠️ runtime 名由 ACTOR_RE 只约束到「小写字母/数字/连字符」⇒ 换身份名**不动正则**；
     历史留痕里的旧 runtime 名**不回填**（那是当时的真实记录）。"""


def validate_actor(actor):
    """合法返回 None，否则返回错误说明。"""
    if not actor:
        return "缺 --by（已取消默认值，必须显式声明提交者）"
    if not ACTOR_RE.match(actor):
        return "actor 格式非法：%r" % (actor,)
    if actor.startswith("agent:") and actor.count(":") < 2:
        return "agent 必须带 sessionId（agent:<runtime>:<sessionId>）"
    return None


# ---------------------------------------------------------------------------
# ★ R5（2026-09-28）：提交成功后同步「向量 / 簇」派生物
#
# 动因（真实事故 · 2026-09-27 夜）：`.facts/state/clusters.json` 是**离线快照**。
#   事实池当晚**删了 2 条**（HOST-BOARD-GUI-URL / HOST-DSH-CLI-VERSION）而快照没跟着重建
#   ⇒ 快照里还引用着它们 ⇒ `retriever/search.py` 直接抛 `ConfigError`（"簇快照过期"）
#   ⇒ **在线检索链整个跑不通**，当时靠人手动重跑才恢复。
#   （还有一种更安静的坏法：只**加**事实 ⇒ 摘要在快照里对不上、但 id 也没悬空 ⇒
#     **不报错**，只是在检索里**静默漏掉新事实** —— 实测 2026-09-28：池 32 条、快照 28 条、无异常。）
#
# 用户 2026-09-28 亲自裁决两条（照它做，不扩大）：
#   「**树我决定不用了，反正一个簇非常小**」          ⇒ 保持现在的**单层簇**，不做树
#   「**向量的话每次更新 list/加 facts 的时候更新就行了**」⇒ **写入时同步**：事实源一变就重建
#     （全量重建实测 32 条 ≈ 12 s，可接受；**不做**查询时按需、**不做**逐条增量）
#
# ★★ 失败语义（本函数唯一重要的一条）：**提交是权威写，向量是派生物** ⇒
#   重建失败**绝不许中止提交**：只打 WARN ＋ 在快照里留 `stale: true`，提交照常成功。
# ★ 回滚一行：`config.yaml` 的 `vector.sync_on_commit: false`（无需重启）。
# ---------------------------------------------------------------------------

def _retriever_clusters_file(vector_cfg: dict):
    """从**检索器配置**里读 `cluster.clusters_file`（快照落盘路径）。

    ★ 为什么不在这里再写一份快照路径：同一件事只留一处，否则两边早晚漂移（A1 的同一条理由）。
    """
    p = str(vector_cfg.get("config") or "").strip()
    if not p:
        return None
    try:
        cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
        f = ((cfg.get("retriever") or {}).get("cluster") or {}).get("clusters_file")
        return Path(str(f)) if f else None
    except (OSError, yaml.YAMLError, AttributeError):
        return None


def mark_snapshot_stale(clusters_file) -> bool:
    """重建失败 ⇒ 在快照里留 `stale: true`（下一轮 `--if-stale` 一定会重建它）。

    只加/改这一个标记键，其余字节按 `cluster.save_snapshot()` 的同一写法回写
    （`indent=1` ＋ 结尾换行）⇒ 不会把快照改坏。
    """
    if clusters_file is None or not Path(clusters_file).is_file():
        return False
    try:
        data = json.loads(Path(clusters_file).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return False
        data["stale"] = True
        Path(clusters_file).write_text(
            json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
        return True
    except (OSError, ValueError):
        return False


def sync_vectors(cfg: dict, root, echo=print) -> dict:
    """跑一次「写入时同步」：`build_clusters.py --if-stale`（子进程，`.venv-groundrails` 的 python）。

    返回 `{"status": ...}`：`not-configured`（本文件没有 `vector:` 段 ⇒ 老行为，别的库不受影响）
    · `disabled`（`sync_on_commit: false` = 回滚）· `unchanged`（事实池没变，秒退）·
    `rebuilt`（已重建）· `failed`（**只 WARN，不抛**）。
    """
    v = cfg.get("vector")
    if not isinstance(v, dict):
        return {"status": "not-configured"}
    if not v.get("sync_on_commit"):
        echo("向量同步    : 已关闭（config.yaml vector.sync_on_commit=false）—— 提交不碰向量")
        return {"status": "disabled"}

    python = str(v.get("python") or "").strip()
    script = str(v.get("script") or "").strip()
    args = [str(x) for x in (v.get("args") or [])]
    cfg_path = str(v.get("config") or "").strip()
    if cfg_path and "--config" not in args:
        args = args + ["--config", cfg_path]
    env = dict(os.environ)
    env.update({str(k): str(x) for k, x in (v.get("env") or {}).items()})
    try:
        timeout = float(v.get("timeout_s") or 0) or None
    except (TypeError, ValueError):
        timeout = None
    clusters_file = _retriever_clusters_file(v)

    def _failed(msg: str) -> dict:
        # ★★ **绝不中止提交**：向量是派生物，权威写已经落库了。
        echo(f"⚠️ 向量同步    : 失败（{msg}）—— 提交已成功；派生物失败不影响权威写。")
        if mark_snapshot_stale(clusters_file):
            echo(f"   快照已标记   : stale: true → {clusters_file}")
        else:
            echo(f"   快照未标记   : 拿不到可写的快照路径（{clusters_file}）")
        return {"status": "failed", "error": msg}

    if not python or not Path(python).is_file():
        return _failed(f"vector.python 不存在：{python!r}")
    if not script or not Path(script).is_file():
        return _failed(f"vector.script 不存在：{script!r}")
    try:
        proc = subprocess.run([python, script] + args, cwd=str(Path(script).parent),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=env, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return _failed(f"起不来 / 超时：{str(exc)[:300]}")

    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        tail = (proc.stderr or out).strip().splitlines()
        return _failed(f"rc={proc.returncode} · " + (" / ".join(tail[-3:])[:400] if tail else "无输出"))
    if "[if-stale] unchanged" in out:
        echo("向量同步    : 事实池没变（--if-stale 秒退，未写文件）")
        return {"status": "unchanged"}
    echo("向量同步    : 事实池变了 ⇒ 已重建簇快照")
    for line in out.splitlines():
        echo("   | " + line)
    return {"status": "rebuilt"}


# ---------------------------------------------------------------------------
# 检查器插件（2026-11-25：内容级检查外置；格式门禁仍在内建 lint/fmt）
#
# 契约见 tasks/runs/kb-client/INTERFACE.md §21：
#   .okf/checkers/<name>/checker.py 或 <name>.py
#   模块常量 NAME / DESCRIPTION / SCOPE / DEFAULT_LEVEL
#   函数 check(ctx) -> [ {level, code, message, line?, field?} ]
# 每个插件在独立子进程运行，超时或崩溃只记 CHECKER-ERROR，不拖垮 okf。
# ---------------------------------------------------------------------------

HEALTH_DEFAULTS = {
    "version": 1,
    "thresholds": {
        "errors_max": 0,
        "ghost_max": 0,
        "unreadable_max": 0,
        "no_frontmatter_ratio_max": 0.10,
        "machine_confirmed_ratio_min": 0.70,
        "stale_ratio_max": 0.25,
        "checker_errors_max": 0,
    },
    "checkers": {"params": {}},
    "external": {},
}


def health_config(root: Path) -> dict:
    """读 .okf/health.yaml（缺省用 HEALTH_DEFAULTS）。只做浅合并，未知键保留。"""
    out = json.loads(json.dumps(HEALTH_DEFAULTS))
    p = root / ".okf" / "health.yaml"
    if p.is_file():
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError) as exc:
            print("! health.yaml 读取失败，用默认阈值：%s" % exc, file=sys.stderr)
            data = {}
        if isinstance(data, dict):
            for k in ("version",):
                if k in data:
                    out[k] = data[k]
            if isinstance(data.get("thresholds"), dict):
                out["thresholds"].update(data["thresholds"])
            if isinstance(data.get("checkers"), dict):
                if isinstance(data["checkers"].get("params"), dict):
                    out["checkers"]["params"].update(data["checkers"]["params"])
            if isinstance(data.get("external"), dict):
                out["external"].update(data["external"])
    return out


def _parse_params(items) -> dict:
    """把 --param name.key=value 解析成 {name: {key: value}}；值尝试 JSON 解析。"""
    out = {}
    for item in items or []:
        if "=" not in item:
            continue
        left, raw = item.split("=", 1)
        parts = left.strip().split(".", 1)
        if not parts or not parts[0]:
            continue
        name = parts[0]
        key = parts[1] if len(parts) > 1 else "value"
        try:
            val = json.loads(raw)
        except json.JSONDecodeError:
            val = raw
        out.setdefault(name, {})[key] = val
    return out


def checker_config(cfg: dict) -> dict:
    c = cfg.get("checkers") or {}
    if not isinstance(c, dict):
        c = {}
    params = c.get("params") if isinstance(c.get("params"), dict) else {}
    return {
        "enabled": c.get("enabled", True) is not False,
        "gate": str(c.get("gate", "warn")),
        "timeout": float(c.get("timeout_seconds", 5) or 5),
        "disable": [str(x) for x in (c.get("disable") or [])],
        "params": params,
    }


def discover_checkers(root: Path, cfg: dict):
    c = checker_config(cfg)
    dirs = [root / ".okf" / "checkers", root / ".okf" / "plugins"]
    found = []
    seen = set()
    for d in dirs:
        if not d.is_dir():
            continue
        for p in sorted(list(d.glob("*.py")) + list(d.glob("*/checker.py"))):
            if p.name.startswith("_"):
                continue
            name = p.parent.name if p.name == "checker.py" else p.stem
            if name in c["disable"] or p in seen:
                continue
            # 渲染插件可在同目录 plugin.json 里声明 enabled:false；检查器跟随
            man = p.parent / "plugin.json"
            if man.is_file():
                try:
                    spec = json.loads(man.read_text(encoding="utf-8"))
                    if isinstance(spec, dict) and spec.get("enabled") is False:
                        continue
                except (OSError, json.JSONDecodeError):
                    pass
            seen.add(p)
            found.append({"name": name, "path": p})
    return found


def _checker_ctx(root: Path, rel: str, text: str, cfg: dict, docs: list, params=None) -> dict:
    data, _raw, body = split_frontmatter(text)
    if not isinstance(data, dict):
        data = {}
    return {
        "root": str(root),
        "rel": rel,
        "text": text,
        "fm": data,
        "body": body,
        "now": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "docs": docs,
        "config": {"timezone": cfg.get("timezone")},
        "params": params or {},
    }


def _run_checker_once(path: Path, ctx: dict, timeout: float):
    """子进程跑一个插件；返回 (findings, error)。"""
    try:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "checker-run", str(path)],
            input=json.dumps(ctx, ensure_ascii=False, default=str), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return [], "超时（>%gs）" % (timeout,)
    except (OSError, subprocess.SubprocessError) as exc:
        return [], "起不来：%s" % (str(exc)[:200],)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return [], "rc=%d %s" % (proc.returncode, (tail[-1] if tail else "")[:200])
    out = (proc.stdout or "").strip()
    if not out:
        return [], "插件没有输出"
    try:
        data = json.loads(out.splitlines()[-1])
    except json.JSONDecodeError as exc:
        return [], "输出不是 JSON：%s" % (exc,)
    if isinstance(data, dict) and "__error__" in data:
        return [], str(data["__error__"])[:300]
    if not isinstance(data, list):
        return [], "check() 必须返回列表"
    return data, None


def _norm_finding(f, checker_name: str, rel: str):
    if not isinstance(f, dict):
        return {"checker": checker_name, "rel": rel, "level": "warn",
                "code": "BAD-FINDING", "message": str(f)[:300], "line": None, "field": None}
    level = str(f.get("level") or "warn").lower()
    if level not in ("warn", "error"):
        level = "warn"
    line = f.get("line")
    try:
        line = int(line) if line is not None else None
    except (TypeError, ValueError):
        line = None
    return {
        "checker": checker_name, "rel": rel, "level": level,
        "code": str(f.get("code") or "FINDING"),
        "message": str(f.get("message") or ""),
        "line": line, "field": (str(f["field"]) if f.get("field") else None),
    }


def run_checkers(cfg: dict, root: Path, targets, echo=print, only=None, params_override=None) -> dict:
    """对 targets=[(rel, text)] 跑全部启用的检查器。无插件时完全静默。

    参数链（后者覆盖前者）：config checkers.params → health.checkers.params → --param。
    """
    c = checker_config(cfg)
    health = health_config(root)
    merged_params = {}
    for src in (c.get("params") or {}, (health.get("checkers") or {}).get("params") or {}, params_override or {}):
        if isinstance(src, dict):
            merged_params.update(src)
    if not c["enabled"]:
        return {"enabled": False, "checkers": [], "findings": [], "errors": 0, "warns": 0,
                "params": merged_params}
    checkers = discover_checkers(root, cfg)
    if only:
        checkers = [x for x in checkers if x["name"] == only]
    if not checkers:
        return {"enabled": True, "checkers": [], "findings": [], "errors": 0, "warns": 0,
                "params": merged_params}
    docs = git_scoped_markdown(root)
    findings, problems = [], []
    for chk in checkers:
        for rel, text in targets:
            ctx = _checker_ctx(root, rel, text, cfg, docs, merged_params.get(chk["name"], {}))
            raw, err = _run_checker_once(chk["path"], ctx, c["timeout"])
            if err:
                problems.append((chk["name"], rel, err))
                findings.append({"checker": chk["name"], "rel": rel, "level": "warn",
                                 "code": "CHECKER-ERROR", "message": err, "line": None, "field": None})
                continue
            for f in raw:
                findings.append(_norm_finding(f, chk["name"], rel))
    errors = sum(1 for f in findings if f["level"] == "error")
    warns = sum(1 for f in findings if f["level"] == "warn")
    if echo and (findings or checkers):
        echo("检查器      : %d 个（%s）" % (len(checkers), ", ".join(x["name"] for x in checkers)))
        for f in findings:
            loc = f["rel"] + ((":" + str(f["line"])) if f["line"] else "")
            mark = "✗" if f["level"] == "error" else "!"
            echo("  %s %s %s %s %s" % (mark, f["checker"], loc, f["code"], f["message"]))
    return {"enabled": True, "checkers": [x["name"] for x in checkers],
            "findings": findings, "errors": errors, "warns": warns, "problems": problems,
            "gate": c["gate"], "params": merged_params}


def cmd_checker_run(args) -> int:
    """隐藏子命令：从 stdin 读 ctx，stdout 写 findings。"""
    path = Path(args.plugin)
    if not path.is_file():
        print("插件不存在：%s" % path, file=sys.stderr)
        return 2
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print("ctx 不是 JSON：%s" % exc, file=sys.stderr)
        return 2
    try:
        spec = importlib.util.spec_from_file_location("kb_checker_" + path.stem, path)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载插件")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        fn = getattr(mod, "check", None)
        if not callable(fn):
            raise RuntimeError("缺少 check(ctx) 函数")
        out = fn(payload)
        if not isinstance(out, list):
            raise RuntimeError("check(ctx) 必须返回列表")
    except Exception as exc:
        print(json.dumps({"__error__": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False))
        return 0
    print(json.dumps(out, ensure_ascii=False, default=str))
    return 0


def cmd_check(args, cfg: dict, root: Path) -> int:
    c = checker_config(cfg)
    if not c["enabled"]:
        print("检查器已关闭（.okf/config.yaml checkers.enabled=false）")
        return 0
    checkers = discover_checkers(root, cfg)
    if args.plugin:
        checkers = [x for x in checkers if x["name"] == args.plugin]
    if not checkers:
        print("没有可用的检查器：.okf/checkers/ 为空或已被 disable")
        return 0
    if args.paths:
        rels = collect_targets(args.paths, root)
    else:
        rels = git_scoped_markdown(root)
    targets = []
    for rel in rels:
        fp = root / rel
        if not fp.is_file() or is_reserved(rel, cfg):
            continue
        try:
            targets.append((rel, read_note_text(fp, rel)))
        except NoteReadError as exc:
            print("! %s %s %s" % (rel, exc.code, exc.msg))
    res = run_checkers(cfg, root, targets, echo=(print if not args.json else None), only=args.plugin,
                       params_override=_parse_params(getattr(args, "param", None)))
    if args.json:
        print(json.dumps({"ok": True, "gate": res.get("gate", c["gate"]), "checkers": res["checkers"],
                          "counts": {"errors": res["errors"], "warns": res["warns"]},
                          "findings": res["findings"]}, ensure_ascii=False, indent=2, default=str))
    else:
        print("\n检查完成：%d 个错误 / %d 个警告（gate=%s）" % (res["errors"], res["warns"], c["gate"]))
    if res["errors"] or (args.strict and res["warns"]):
        return 1
    return 0


def cmd_commit(args, cfg, root):
    tz = cfg["timezone"]
    if args.source_checked is None:
        print("✗ 必须显式声明是否进行源检查：--source-checked 或 --no-source-checked")
        return 2
    err = validate_actor(args.by)
    if err:
        print("✗ " + err)
        print(ACTOR_HELP)
        return 2
    actor = args.by
    targets, extra_files, missing = collect_commit_targets(args.paths, root)
    if missing:
        # ★ 2026-10-04 修：改前 `_expand_one()` 对不存在/库外的显式路径返回 `[]` ⇒ 静默
        #   「没有需要提交的变更」rc=0（打错一个路径就以为提交过了）。与 `okf lint` 对齐。
        print("✗ 显式路径没有落到任何文件（提交器不再静默忽略）：")
        for p in missing:
            print(f"    [ERROR/PATH-NOT-FOUND] {p}：路径不存在、在库外、或已被 .gitignore 忽略")
        print("提示：路径相对**知识库根**解析；确认拼写，或改用 `okf status` 看真实变更。")
        return 1
    if not targets and not extra_files:
        print("没有需要提交的变更（工作区干净，或被 .gitignore 忽略）。"); return 0
    if extra_files:
        print("附带提交（非笔记文件 / `_raw` 豁免 / 已删除项，原样入库、不做 frontmatter 转换）：")
        for f in extra_files:
            print(f"  + {f}")

    # ★ 第零阶段：facts 格式在**提交时**真拦（FACTS §11.1「提交时拦」）。
    # 触发判据与 cmd_lint 同一套：目标里出现**非保留**的注册表命中项（今天只有 `.facts/`）。
    # 为什么放在这里：`cmd_commit` 的收集器 `collect_commit_targets()` **会展开目录**
    # （`_expand_one()` 的 rglob，与 `cmd_fmt`/`cmd_lint` 的 `collect_targets()` 语义不同），
    # 所以 `.facts/**` 在这里是以 **extra_files**（非 md）身份进来的 —— 改前它们
    # **原样入库、零校验**（实测：6 类结构错误照旧提交成功）。
    # ⚠️ 零回归红线：`gated` 为空时本块**一行都不打印**、不产生任何副作用，
    # 未命中 `formats` 的提交（note / unknown）与改前逐字节相同。
    gated = [r for r in (targets + extra_files)
             if not is_reserved(r, cfg) and format_for(r, cfg) not in ("note", "unknown")]
    if gated:
        f_issues = validate_facts(root, cfg)
        f_errs = [i for i in f_issues if i.level == "ERROR"]
        f_warns = [i for i in f_issues if i.level == "WARN"]
        tag = "✗" if f_errs else ("!" if f_warns else "✓")
        froot = (cfg.get("facts") or {}).get("root", ".facts/")
        print(f"{tag} 事实源 {froot}（格式 facts：提交前结构校验，触发路径 {len(gated)} 个）")
        for i in f_errs + f_warns:
            print(f"    {i}")
        if f_errs:
            # 硬拦：此处在任何 read_text 之外**什么都没做过**，所以"未改写"是结构保证的
            print(f"\n✗ facts 结构校验未通过（{len(f_errs)} 个错误），已中止："
                  f"未改写、未 add、未 commit。")
            return 1

    # 第一阶段：归一化 + 校验（任一 ERROR 整体中止，不写任何东西）
    plans = []
    fatal = 0
    for rel in targets:
        if is_reserved(rel, cfg):
            plans.append((rel, None, None, True)); continue
        fp = root / rel
        try:
            orig = read_note_text(fp, rel)
        except NoteReadError as exc:
            fatal += 1
            print(f"✗ {rel}")
            print(f"    {Issue('ERROR', exc.code, exc.msg)}")
            continue
        new_text, issues, meta = normalize_document(
            orig, cfg, actor=actor, source_checked=args.source_checked,
            is_commit=True, tz_offset=tz, doc_dir=fp.parent)
        errs = [i for i in issues if i.level == "ERROR"]
        if errs:
            fatal += 1
            print(f"✗ {rel}")
            for i in errs: print(f"    {i}")
            continue
        plans.append((rel, orig, new_text, False, meta))
    if fatal:
        print(f"\n✗ {fatal} 个文件未通过门禁，已中止：未改写、未 add、未 commit。")
        return 1

    # 第 1.2 阶段：内容级检查器（外置插件；无插件时完全静默）
    chk_targets = [(p[0], p[2]) for p in plans if not p[3] and p[2] is not None]
    chk = run_checkers(cfg, root, chk_targets, echo=print)
    gate = str(chk.get("gate") or "warn")
    blocked = (gate == "block" and chk.get("errors", 0) > 0) or \
              (getattr(args, "strict", False) and (chk.get("errors", 0) + chk.get("warns", 0)) > 0)
    if blocked:
        print(f"\n✗ 检查器未通过（gate={gate}）：已中止，未改写、未 add、未 commit。")
        return 1

    # --dry-run 必须零副作用：不写文件、不碰 log.md、不 add、不 commit。
    # 历史缺陷（2026-09-15 实测）：dry-run 只跳过了第四阶段 git 动作，
    # 第二阶段 write_text 与第三阶段 update_log 照跑 → 演练会把 log.md 写脏。
    if args.dry_run:
        print("\n[--dry-run] 演练结束：未改写文件、未更新 log.md、未 add、未 commit。")
        for p in plans:
            if p[3]:
                print(f"  reserved（原样提交，不治理）: {p[0]}")
        cand = [p[0] for p in plans if not p[3]] + list(extra_files)
        print("[--dry-run] 将通过门禁并提交的路径：", cand)
        return 0

    # ★ 第 1.5 阶段：**可写性预检**（2026-10-04 修）。
    #   动因（沙箱复现）：改前"写失败"发生在第 2 阶段**中途** ⇒ 排在前面的目标已经改写，
    #   后面的目标抛 `PermissionError` + traceback，且没 add / 没 commit ⇒ 工作区留下
    #   **没有 git 快照的半治理改动**（README §三.6 承诺的"整体中止：不写任何东西"被破坏）。
    #   判据：只探**真的需要写**的目标（`new_text == orig` 的不写、也就不需要写位）。
    unwritable = [item[0] for item in plans
                  if not item[3] and item[2] != item[1]
                  and not os.access(root / item[0], os.W_OK)]
    if unwritable:
        print("✗ 目标文件不可写（未改写任何文件、未 add、未 commit）：")
        for rel in unwritable:
            print(f"    [ERROR/NOT-WRITABLE] {rel}")
        print("提示：目录 555 **不影响**改写已存在的文件；文件本体缺属主写位才走到这里"
              "（同族判据见 KB 30.11 §14.1）。")
        return 1

    # ---- 第 2–4 阶段统一带「回滚」：任一步失败 ⇒ 按原字节恢复本次改过的文件 ----
    log_path = root / str(((cfg.get("log") or {}).get("path")) or "log.md")
    log_orig = log_path.read_text(encoding="utf-8") if log_path.is_file() else None
    mutated = []          # [(rel, 原始文本)] —— 回滚账本
    written = []          # 本次纳入提交的 md（提交信息用）
    passive_add = []      # reserved 文件（如 log.md）：不做治理，但原样纳入提交
    add_list = []
    log_entries = []
    pre_staged = set()

    def _rollback(reason: str, exc) -> int:
        """恢复工作区 ＋ 取消**本次**新加的暂存；绝不吞掉原因。"""
        restored = 0
        for rel, orig in mutated:
            try:
                (root / rel).write_text(orig, encoding="utf-8", newline="\n"); restored += 1
            except OSError as e:
                print(f"    ⚠️ 回滚失败：{rel}（{e}）")
        if log_orig is not None and log_path.exists():
            try:
                log_path.write_text(log_orig, encoding="utf-8", newline="\n")
            except OSError as e:
                print(f"    ⚠️ 回滚 log.md 失败：{e}")
        for f in add_list:                      # 只撤本次 add 的（此前已暂存的不动）
            if f not in pre_staged:
                git(["reset", "-q", "--", f], root, check=False)
        print(f"\n✗ {reason}：已回滚本次改写（{restored}/{len(mutated)} 个文件"
              f"{' ＋ log.md' if log_orig is not None else ''}），未 add、未 commit。")
        print(f"    原因：{exc}")
        return 1

    try:
        # 第二阶段：写回归一化结果
        for item in plans:
            rel = item[0]
            if item[3]:  # reserved
                if (root / rel).exists():
                    passive_add.append(rel)
                continue
            _, orig, new_text, _, meta = item
            fp = root / rel
            if new_text != orig:
                fp.write_text(new_text, encoding="utf-8", newline="\n")
                mutated.append((rel, orig))
            written.append(rel)
            verb = "created" if not is_tracked(fp, root) else "updated"
            title = extract_title(meta.get("data", {}), new_text, rel)
            log_entries.append((verb, rel, title, args.source_checked))
            print(f"✓ {rel}  type={meta['type']} status={meta['status']} tier={meta['tier']}")

        # 第三阶段：维护 log.md
        log_rel = None
        if log_entries:
            lp = update_log(root, log_entries, cfg)
            if lp:
                log_rel = lp.relative_to(root).as_posix()

        # 第四阶段：git add + commit（md 治理结果 + 非 md 附带 + reserved 原样 + log.md）
        merged = written + extra_files + passive_add + ([log_rel] if log_rel else [])
        seen_add = set()
        for x in merged:
            if x and x not in seen_add:
                seen_add.add(x); add_list.append(x)
        pre_staged = set(git(["diff", "--cached", "--name-only"], root).splitlines())
        for f in add_list:
            # ★ 2026-10-04：**已删除的目标不许再 `git add`** —— `git rm` 把文件从
            #   工作区和索引**同时**删掉，此时 `git add -- <路径>` 会以
            #   `pathspec … did not match any files` 直接失败；而那次删除**早已暂存**，
            #   自动就会被这次 commit 带上。只有「工作区删了、索引还在」（裸 rm）才需要 add。
            if not (root / f).exists() and not is_tracked(root / f, root):
                continue
            git(["add", "--", f], root)
        summary = args.message or _default_message(log_entries, actor, args.source_checked)
        msg = _format_commit_message(summary, actor, args.source_checked,
                                     written + extra_files)
        git(["commit", "-m", msg], root)
    except (OSError, RuntimeError) as exc:
        # RuntimeError = `git()` 的非零退出（add / commit 失败，如 .git/index.lock 建不了）
        return _rollback("提交阶段失败", exc)

    print("\n" + git(["log", "-1", "--stat", "--oneline"], root))
    print("\n✔ 提交完成。回滚：git revert HEAD（撤销并保留历史）/ git reset --hard HEAD~1（硬回滚）")

    # ★ R5（2026-09-28）：提交（= **权威写**）已经完成 ⇒ 再同步「向量 / 簇」这条**派生物**。
    #   为什么落在这里（而不是紧挨着上面的 facts 门禁）：
    #     ① `--dry-run` 在上面就 return 了 —— 演练必须**零副作用**（历史上踩过演练把 log.md 写脏）；
    #     ② 放在"提交成功之后"⇒ 失败语义天然成立：**提交是权威写、向量是派生物** ⇒
    #        重建失败只 WARN ＋ 快照留 `stale: true`，**绝不回滚、绝不中止**（任务书 R5 ②）。
    #   事实池没变时它自己秒退（`--if-stale`：rc=0 且不写文件，实测 < 0.5 s）⇒ 每次提交都调也不白付。
    sync_vectors(cfg, root)
    return 0


def _default_message(entries, actor, sc):
    n_create = sum(1 for e in entries if e[0] == "created")
    n_update = sum(1 for e in entries if e[0] == "updated")
    parts = []
    if n_create: parts.append(f"新增 {n_create}")
    if n_update: parts.append(f"更新 {n_update}")
    return "OKF 提交：" + "、".join(parts) if parts else "OKF 提交"


def check_declared_vs_actual(root: Path, rel: str, data: dict) -> list:
    """校验「声明的最后改动」与「实际最后改动」一致性（人源信息检测信号）。

    规则：
      - frontmatter generated.at（声明） vs git 实际提交时间（git log -1 %cI）
      - 若声明时间早于实际提交时间 → 说明文件被提交后又有改动/声明未更新 → WARN
      - 若声明时间晚于实际提交时间 → 声明时间在未来（异常）→ ERROR
      - source_checked=true 但 verified 无 source-check 记录 → WARN（声明了源检查但无留痕）
    """
    issues = []
    gen = data.get("generated") or {}
    declared = str(gen.get("at", "")).strip()
    if not declared:
        return issues
    try:
        declared_dt = dt.datetime.fromisoformat(declared.replace("Z", "+00:00"))
    except Exception:
        return issues  # 时间格式错误已有 TIME-BAD 处理

    # 取 git 实际最后提交时间
    proc = subprocess.run(
        ["git", "log", "-1", "--format=%cI", "--", rel],
        cwd=str(root), capture_output=True, text=True,
        encoding="utf-8", errors="replace")
    actual_str = proc.stdout.strip()
    if not actual_str:
        return issues  # 未提交过的文件（新建未入库）跳过
    try:
        actual_dt = dt.datetime.fromisoformat(actual_str.replace("Z", "+00:00"))
    except Exception:
        return issues

    # 转 naive 比较（都转本地时区偏移）
    def _naive(d):
        return d.replace(tzinfo=None) if d.tzinfo else d
    declared_n, actual_n = _naive(declared_dt), _naive(actual_dt)
    # 归一化到分钟级比较（秒级抖动不告警）
    delta = (declared_n - actual_n).total_seconds()

    if delta < -120:  # 声明比实际早 2 分钟以上 → 实际有更新但声明未刷新
        issues.append(Issue(
            "WARN", "TIME-STALE",
            f"声明的最后改动(generated.at={declared})早于实际提交时间({actual_str})："
            f"文件可能被人源改动或声明未更新（见 70.5 §3 双版本登记）"))
    elif delta > 120:  # 声明比实际晚 2 分钟以上 → 声明时间在未来
        issues.append(Issue(
            "ERROR", "TIME-FUTURE",
            f"声明的最后改动(generated.at={declared})晚于实际提交时间({actual_str})："
            f"声明时间在未来，数据可疑"))

    # source_checked 真实性：声明 true 但 verified 无 source-check 记录
    if data.get("source_checked") is True:
        has_sc = any(
            isinstance(ev, dict) and str(ev.get("method", "")).startswith("source-check")
            for ev in (data.get("verified") or []))
        if not has_sc:
            issues.append(Issue(
                "WARN", "SRC-UNVERIFIED",
                "source_checked=true 但 verified 无 source-check 记录："
                "源检查是自声明，无留痕（agent 不得代用户声明 human 级确认）"))
    return issues


def _format_commit_message(summary, actor, sc, files):
    tail = "\n".join(f"  - {f}" for f in files)
    return (
        f"{summary}\n\n"
        f"updated_by: {actor}\n"
        f"source_checked: {'true' if sc else 'false'}\n"
        f"files: {len(files)}\n"
        f"{tail}"
    )


def status_snapshot(root: Path, cfg) -> dict:
    """全库合规快照 —— `okf status`、`okf status --json`、外部服务 import 三处**共用这一份数据**。

    字段语义见 tasks/runs/kb-service/INTERFACE.md §2。单一真相：不要在别处再算一遍。
    """
    rels = git_scoped_markdown(root)
    total = err = 0
    tier_count = {"unverified": 0, "machine-confirmed": 0, "human-reviewed": 0}
    no_fm = 0
    ghost = 0
    unreadable = 0
    for rel in rels:
        if is_reserved(rel, cfg):
            continue
        fp = root / rel
        if not fp.is_file():
            # 索引里有、工作区已删：只计数不读（口径同 collect_commit_targets，见 §4.1 删除项）
            ghost += 1
            continue
        try:
            text = read_note_text(fp, rel)
        except NoteReadError:
            unreadable += 1
            continue
        _, issues, meta = normalize_document(
            text, cfg, actor=None, source_checked=None,
            is_commit=False, tz_offset=cfg["timezone"], doc_dir=fp.parent)
        total += 1
        if any(i.level == "ERROR" for i in issues):
            err += 1
        if any(i.code == "FM-AUTOCREATE" for i in issues):
            no_fm += 1
        t = meta.get("tier", "unverified")
        tier_count[t] = tier_count.get(t, 0) + 1
    return {
        "schema_version": 1,
        "root": str(root),
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "total": total,
        "errors": err,
        "no_frontmatter": no_fm,
        "ghost": ghost,
        "unreadable": unreadable,
        "tiers": tier_count,
    }


def _health_targets(root: Path, cfg: dict):
    targets, stale = [], 0
    today = dt.date.today()
    for rel in git_scoped_markdown(root):
        if is_reserved(rel, cfg):
            continue
        fp = root / rel
        if not fp.is_file():
            continue
        try:
            text = read_note_text(fp, rel)
        except NoteReadError:
            continue
        targets.append((rel, text))
        data, _raw, _body = split_frontmatter(text)
        if isinstance(data, dict):
            raw = data.get("stale_after")
            if raw:
                try:
                    if dt.date.fromisoformat(str(raw)[:10]) < today:
                        stale += 1
                except ValueError:
                    pass
    return targets, stale


def compute_health(root: Path, cfg: dict, params_override=None) -> dict:
    """按 .okf/health.yaml 计算健康结论；status_snapshot + 检查器 + 外部检查器。"""
    health = health_config(root)
    th = {k: v for k, v in (health.get("thresholds") or {}).items()}
    snap = status_snapshot(root, cfg)
    targets, stale = _health_targets(root, cfg)
    res = run_checkers(cfg, root, targets, echo=None, params_override=params_override)
    total = max(int(snap.get("total") or 0), 1)
    tiers = snap.get("tiers") or {}
    metrics = {
        "total": snap.get("total", 0),
        "errors": snap.get("errors", 0),
        "ghost": snap.get("ghost", 0),
        "unreadable": snap.get("unreadable", 0),
        "no_frontmatter": snap.get("no_frontmatter", 0),
        "no_frontmatter_ratio": round(snap.get("no_frontmatter", 0) / total, 4),
        "machine_confirmed_ratio": round(tiers.get("machine-confirmed", 0) / total, 4),
        "stale": stale,
        "stale_ratio": round(stale / total, 4),
        "checker_errors": res.get("errors", 0),
        "checker_warns": res.get("warns", 0),
    }
    rules = [
        ("errors", "errors_max", "error", "错误文档数超过上限"),
        ("ghost", "ghost_max", "error", "工作区已删文档超过上限"),
        ("unreadable", "unreadable_max", "error", "不可读文档超过上限"),
        ("checker_errors", "checker_errors_max", "error", "检查器 error 级结果超过上限"),
        ("no_frontmatter_ratio", "no_frontmatter_ratio_max", "warn", "缺头部比例超过上限"),
        ("machine_confirmed_ratio", "machine_confirmed_ratio_min", "warn", "机器确认比例低于下限"),
        ("stale_ratio", "stale_ratio_max", "warn", "过期文档比例超过上限"),
    ]
    violations = []
    for metric, key, level, msg in rules:
        if key not in th:
            continue
        limit = th[key]
        val = metrics.get(metric)
        if val is None:
            continue
        bad = (val > limit) if key.endswith("_max") else (val < limit)
        if bad:
            violations.append({"metric": metric, "level": level, "value": val,
                               "threshold": limit, "message": msg})
    ext = health.get("external") or {}
    if isinstance(ext, dict) and ext.get("command"):
        cmd = [str(ext["command"])] + [str(x) for x in (ext.get("args") or [])]
        payload = json.dumps({"root": str(root), "metrics": metrics, "thresholds": th,
                              "params": res.get("params") or params_override or {}}, ensure_ascii=False, default=str)
        try:
            proc = subprocess.run(cmd, input=payload, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace",
                                  timeout=float(ext.get("timeout_seconds", 10) or 10))
            if proc.returncode != 0:
                raise RuntimeError("rc=%d %s" % (proc.returncode, (proc.stderr or "")[-200:]))
            data = json.loads((proc.stdout or "").strip().splitlines()[-1])
            for f in (data.get("findings") or []):
                violations.append({"metric": "external", "level": str(f.get("level") or "warn"),
                                   "value": f.get("value"), "threshold": f.get("threshold"),
                                   "message": str(f.get("message") or f.get("code") or "external")})
        except Exception as exc:
            violations.append({"metric": "external", "level": "warn", "value": None,
                               "threshold": None, "message": "外部检查器失败：%s" % str(exc)[:200]})
    errors = sum(1 for v in violations if v.get("level") == "error")
    warns = sum(1 for v in violations if v.get("level") == "warn")
    return {"ok": errors == 0, "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "metrics": metrics, "thresholds": th, "violations": violations,
            "errors": errors, "warns": warns, "checkers": res.get("checkers", [])}


def cmd_health(args, cfg, root) -> int:
    params = _parse_params(getattr(args, "param", None))
    res = compute_health(root, cfg, params)
    if getattr(args, "json", False):
        print(json.dumps(res, ensure_ascii=False, indent=2, default=str))
    else:
        print("OKF 健康检查：%s" % ("通过" if res["ok"] else "不通过"))
        m = res["metrics"]
        print("  文档 %s · 错误 %s · ghost %s · 不可读 %s · 缺头 %s" %
              (m["total"], m["errors"], m["ghost"], m["unreadable"], m["no_frontmatter"]))
        print("  缺头比例 %.2f%% · 机器确认 %.2f%% · 过期 %.2f%%" %
              (m["no_frontmatter_ratio"] * 100, m["machine_confirmed_ratio"] * 100, m["stale_ratio"] * 100))
        print("  检查器：%s（error %s / warn %s）" % (", ".join(res["checkers"]) or "无", m["checker_errors"], m["checker_warns"]))
        for v in res["violations"]:
            print("  %s %s：%s（实际 %s / 阈值 %s）" %
                  ("✗" if v.get("level") == "error" else "!",
                   v.get("metric"), v.get("message"), v.get("value"), v.get("threshold")))
    if res["errors"]:
        return 1
    if getattr(args, "strict", False) and res["warns"]:
        return 1
    return 0


def cmd_status(args, cfg, root):
    snap = status_snapshot(root, cfg)
    if getattr(args, "json", False):
        print(json.dumps(snap, ensure_ascii=False, indent=2))
        return 0
    print("OKF 知识库合规概览")
    print(f"  concept 文档总数 : {snap['total']}")
    print(f"  有错误(禁止提交) : {snap['errors']}")
    print(f"  缺头部(提交时自动建) : {snap['no_frontmatter']}")
    print(f"  工作区已删(ghost) : {snap['ghost']}")
    print(f"  不可读(unreadable) : {snap['unreadable']}")
    print(f"  信任层级分布     : {snap['tiers']}")
    return 0


def cmd_rawcheck(args, cfg, root):
    """扫描 _raw/ 生命周期 + 主目录大文件违规，生成每日统计文档（用户每天看）。

    规则（70.5 §1，用户 2026-09-04 拍板）：
      - _raw 文档 >1 个月 → 归档
      - _raw 内 >100MB 文件停留 ≤7 天
      - 主目录不允许 ≥100MB 文件
      - _raw 不允许 ≥2GB 文件
    """
    now = dt.datetime.now()
    raw_root = root / "_raw"
    report = []
    errs, warns = [], []

    def _fmt_mb(b):
        return f"{b / 1048576:.1f}MB"

    report.append(f"# _raw 生命周期状态报告（{now.strftime('%Y-%m-%d %H:%M')}）\n")
    files = []
    if raw_root.exists():
        files = [f for f in raw_root.rglob("*") if f.is_file()]
        by_src = {}
        for f in files:
            rel = f.relative_to(raw_root)
            src = rel.parts[0] if len(rel.parts) > 1 else "(根)"
            by_src.setdefault(src, []).append(f)
        total_b = sum(f.stat().st_size for f in files)
        report.append("## 统计概览\n")
        report.append(f"- 文件总数：{len(files)}")
        report.append(f"- 来源分类：{len(by_src)} 个（{', '.join(sorted(by_src))}）")
        report.append(f"- 总大小：{_fmt_mb(total_b)}\n")
        report.append("## 生命周期检查\n")
        report.append("> 天数 = 文件 mtime 距今；规则：文档>1月归档 / >100MB 观察≤7天 / _raw<2GB\n")
        report.append("| 文件 | 大小 | 天数 | 状态 |")
        report.append("|---|---|---|---|")
        for src in sorted(by_src):
            report.append(f"\n### {src}\n")
            for f in sorted(by_src[src], key=lambda x: x.stat().st_mtime, reverse=True):
                st = f.stat()
                size, days = st.st_size, (now - dt.datetime.fromtimestamp(st.st_mtime)).days
                rel = f.relative_to(raw_root).as_posix()
                if size >= 2 * 1000 ** 3:
                    status = "❌ 违规(≥2GB)"
                    errs.append(f"_raw 超2GB: {rel} ({_fmt_mb(size)})")
                elif size >= 100 * 1000 ** 2 and days > 7:
                    status = "⚠️ 超观察期(≥100MB 且 >7天)"
                    warns.append(f"_raw 超观察期: {rel} ({_fmt_mb(size)}, {days}天)")
                elif size >= 100 * 1000 ** 2:
                    status = f"⏳ 观察中(剩 {7 - days} 天)"
                elif days > 30:
                    status = "⚠️ 超1个月(应归档)"
                    warns.append(f"_raw 超1月: {rel} ({days}天)")
                else:
                    status = "✅ 正常"
                report.append(f"| {rel} | {_fmt_mb(size)} | {days} | {status} |")
    else:
        report.append("# _raw 生命周期状态报告\n")
        report.append("_raw/ 目录不存在（尚未使用）\n")

    # 主目录大文件检查（<100MB）
    report.append("\n## 主目录大文件检查（规则：<100MB）\n")
    big = []
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        parts = f.relative_to(root).parts
        if parts and parts[0] in (".git", ".obsidian", ".okf", "_raw"):
            continue
        sz = f.stat().st_size
        if sz >= 100 * 1000 ** 2:
            big.append((f.relative_to(root).as_posix(), sz))
    if big:
        for rel, sz in big:
            report.append(f"- ❌ {rel}：{_fmt_mb(sz)}（≥100MB，应移 _raw 观察）")
            errs.append(f"主目录≥100MB: {rel}")
    else:
        report.append("- ✅ 无 ≥100MB 文件")

    report.append(f"\n## 结论：❌ {len(errs)} 违规 / ⚠️ {len(warns)} 警告")
    if warns:
        report.append("\n### 警告清单")
        for w in warns:
            report.append(f"- {w}")

    report_path = raw_root / "生命周期报告.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(report) + "\n", encoding="utf-8", newline="\n")

    print("OKF _raw 生命周期检查")
    print(f"  _raw 文件数 : {len(files)}")
    print(f"  违规(❌)    : {len(errs)}")
    print(f"  警告(⚠️)    : {len(warns)}")
    for e in errs:
        print(f"    ❌ {e}")
    for w in warns:
        print(f"    ⚠️ {w}")
    print(f"  报告已写   : {report_path}")
    return 1 if errs else 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_baseline(args, cfg, root):
    """一次性：把治理前的全部文件原样入库作为回滚基线（唯一不做 fmt/lint 的提交）。"""
    def _rc(git_args):
        return subprocess.run(["git"] + git_args, cwd=str(root),
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace").returncode
    if _rc(["rev-parse", "--git-dir"]) != 0:
        print("✗ 当前不是 git 仓库，请先在知识库根执行 git init", file=sys.stderr)
        return 2
    if _rc(["rev-parse", "--verify", "HEAD"]) == 0:
        print("✗ 仓库已存在提交，baseline 只允许在空仓库执行一次。", file=sys.stderr)
        return 2
    git(["add", "-A"], root)
    staged = git(["diff", "--cached", "--name-only"], root)
    if not staged:
        print("（暂存区为空，没有可建立基线的内容）")
        return 0
    msg = ("chore(baseline): OKF 治理前知识库基线快照（原样入库，作为回滚起点）\n\n"
           "这是唯一一次不经过 fmt/lint 的提交；此后所有变更必须走 okf commit。")
    git(["commit", "-m", msg], root)
    n = len([l for l in staged.splitlines() if l.strip()])
    print(f"✔ 基线已建立：{n} 个文件原样入库。此后所有改动请走 commit（fmt+lint+留痕）。")
    print("回滚基线：git reset --hard HEAD 可丢弃基线之后的全部改动。")
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="okf_commit",
        description="OKF 知识库统一提交工具（fmt 归一化 -> lint 门禁 -> git 提交）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_paths(sp):
        sp.add_argument("paths", nargs="*", help="目标 md 文件/目录；缺省取 git 变更")

    sp_fmt = sub.add_parser("fmt", help="格式转换（rustfmt 式归一化 frontmatter）并写回")
    add_paths(sp_fmt)

    sp_lint = sub.add_parser("lint", help="只检查不改动")
    add_paths(sp_lint)

    sp_c = sub.add_parser("commit", help="fmt+lint 通过后自动留痕并 git 提交")
    add_paths(sp_c)
    sp_c.add_argument("--by", required=True,
                      help="更新者 actor（必填）：agent:<runtime>:<sessionId> / process:<name> / human:<id>")
    grp = sp_c.add_mutually_exclusive_group()
    grp.add_argument("--source-checked", dest="source_checked", action="store_true",
                     help="本次已对照 sources 做源检查（必填声明之一）")
    grp.add_argument("--no-source-checked", dest="source_checked", action="store_false",
                     help="本次未做源检查（必填声明之一）")
    sp_c.set_defaults(source_checked=None)
    sp_c.add_argument("-m", "--message", help="提交摘要（缺省自动生成）")
    sp_c.add_argument("--dry-run", action="store_true", help="只演练，不真正 commit")
    sp_c.add_argument("--strict", action="store_true", help="把检查器的 warning 也视为阻断")

    sp_ck = sub.add_parser("check", help="运行 .okf/checkers/ 下的插件检查（不写文件）")
    add_paths(sp_ck)
    sp_ck.add_argument("--json", action="store_true", help="输出机器可读结果")
    sp_ck.add_argument("--strict", action="store_true", help="warning 也返回非零")
    sp_ck.add_argument("--plugin", help="只跑指定插件")
    sp_ck.add_argument("--param", action="append", default=[], metavar="NAME.KEY=VALUE",
                       help="覆盖检查器参数（可重复）")
    sp_h = sub.add_parser("health", help="按 .okf/health.yaml 计算健康结论")
    sp_h.add_argument("--json", action="store_true", help="输出机器可读结果")
    sp_h.add_argument("--strict", action="store_true", help="warning 也返回非零")
    sp_h.add_argument("--param", action="append", default=[], metavar="NAME.KEY=VALUE",
                      help="覆盖检查器参数（可重复）")

    sp_cr = sub.add_parser("checker-run", help=argparse.SUPPRESS)
    sp_cr.add_argument("plugin")

    sp_st = sub.add_parser("status", help="全仓库合规概览")
    sp_st.add_argument("--json", action="store_true",
                       help="输出机器可读快照（字段见 INTERFACE.md §2；服务侧唯一消费入口）")

    sub.add_parser("raw-check", help="_raw 生命周期检查 + 每日统计报告")

    sp_b = sub.add_parser("baseline", help="【一次性】治理前原样入库，建立回滚基线")
    sp_b.set_defaults(paths=[])
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg = load_config()
    root = repo_root(TOOL_DIR)
    if args.cmd == "fmt":
        return cmd_fmt(args, cfg, root)
    if args.cmd == "lint":
        return cmd_lint(args, cfg, root)
    if args.cmd == "commit":
        return cmd_commit(args, cfg, root)
    if args.cmd == "check":
        return cmd_check(args, cfg, root)
    if args.cmd == "health":
        return cmd_health(args, cfg, root)
    if args.cmd == "checker-run":
        return cmd_checker_run(args)
    if args.cmd == "status":
        return cmd_status(args, cfg, root)
    if args.cmd == "raw-check":
        return cmd_rawcheck(args, cfg, root)
    if args.cmd == "baseline":
        return cmd_baseline(args, cfg, root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
