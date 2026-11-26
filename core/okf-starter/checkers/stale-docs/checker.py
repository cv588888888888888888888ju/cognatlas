"""stale-docs —— stale_after 已过期的文档给出警告（示例插件）。"""
import datetime as dt

NAME = "stale-docs"
DESCRIPTION = "stale_after 早于今天时提示文档已过期"
SCOPE = "doc"
DEFAULT_LEVEL = "warn"


def check(ctx):
    params = ctx.get("params") or {}
    try:
        grace = int(params.get("grace_days", 0) or 0)
    except (TypeError, ValueError):
        grace = 0
    level = str(params.get("level") or "warn")
    raw = (ctx.get("fm") or {}).get("stale_after")
    if not raw:
        return []
    text = str(raw)[:10]
    try:
        due = dt.date.fromisoformat(text)
    except ValueError:
        return [{"level": level, "code": "STALE-BAD-FORMAT",
                 "message": "stale_after 不是 YYYY-MM-DD：%s" % raw, "field": "stale_after"}]
    today = dt.date.fromisoformat(str(ctx.get("now"))[:10])
    if due + dt.timedelta(days=grace) < today:
        return [{"level": level, "code": "STALE-DOC",
                 "message": "文档已过期：stale_after=%s" % text, "field": "stale_after"}]
    return []
