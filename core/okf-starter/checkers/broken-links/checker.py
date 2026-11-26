"""broken-links —— 检查内部链接是否落到现有文档（示例插件）。"""
import posixpath
import re

NAME = "broken-links"
DESCRIPTION = "检查 [[链接]] 与 [文字](相对.md) 是否指向库内现有文档"
SCOPE = "doc"
DEFAULT_LEVEL = "warn"

WIKI_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
MD_RE = re.compile(r"\]\(([^)\s]+\.md)(?:#[^)]*)?\)")


def _resolve(from_rel, target):
    t = target.strip().replace("\\", "/")
    if t.startswith("/"):
        return t.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(from_rel), t))


def check(ctx):
    params = ctx.get("params") or {}
    ignore = [str(x) for x in (params.get("ignore") or [])]
    level = str(params.get("level") or "warn")
    docs = set(ctx.get("docs") or [])
    stems = {posixpath.basename(p)[:-3]: p for p in docs}
    out = []
    in_fence = False
    for lineno, line in enumerate(str(ctx.get("text") or "").splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in WIKI_RE.finditer(line):
            target = m.group(1).strip()
            rel = target if "/" in target else None
            if target in stems or (rel and _resolve(ctx["rel"], rel) in docs):
                continue
            if any(p.endswith("/" + target + ".md") or p == target + ".md" for p in docs):
                continue
            if rel and (_resolve(ctx["rel"], rel) + ".md") in docs:
                continue
            if any(s in target for s in ignore):
                continue
            out.append({"level": level, "code": "LINK-MISSING",
                        "message": "内部链接目标不存在：%s" % target, "line": lineno})
        for m in MD_RE.finditer(line):
            target = m.group(1)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            if _resolve(ctx["rel"], target) in docs:
                continue
            if any(p.endswith("/" + target) or p == target for p in docs):
                continue
            if any(s in target for s in ignore):
                continue
            out.append({"level": level, "code": "LINK-MISSING",
                        "message": "内部链接目标不存在：%s" % target, "line": lineno})
    return out
