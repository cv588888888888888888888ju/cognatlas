#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kb-serve —— 知识库服务（健康快照 + 检索 + MCP stdio）。

接口契约见 docs/ARCHITECTURE.md。
可调参数全部来自 ~/.local/share/kb-service/config.json，代码里不写字面量。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import re
import json
import os
import sqlite3
import sys
import datetime as dt
from pathlib import Path

BASE = Path(os.environ.get("KB_SERVE_HOME", str(Path.home() / ".local/share/kb-service")))
DB = Path(os.environ.get("KB_SERVE_DB", str(BASE / "kb.db")))
CONFIG = BASE / "config.json"
TOKENS = Path(os.environ.get("KB_TOKEN_STORE", str(BASE / "tokens.json")))

DEFAULTS = {
    "kb_root": os.environ.get("KB_ROOT", str(Path.home() / "KnowledgeBase")),
    "port": 18812,
    "refresh_interval_seconds": 1800,
    "search_limit_default": 10,
    "search_limit_max": 50,
    "snippet_tokens": 16,
    "auth_required": True,
}


def load_cfg() -> dict:
    """读配置；缺文件就落一份默认值（可调值只在这里，不在代码里）。"""
    cfg = dict(DEFAULTS)
    if not CONFIG.is_file():
        BASE.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return cfg
    try:
        cfg.update(json.loads(CONFIG.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        print(f"[ERROR/CONFIG-JSON] {CONFIG} 不是合法 JSON：{exc}", file=sys.stderr)
        raise SystemExit(1)
    return cfg


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def token_identity(token: str | None) -> dict | None:
    """按 sha256 查令牌；文件不存在或令牌吊销都返回 None。"""
    if not token:
        return None
    try:
        db = json.loads(TOKENS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    h = _sha256(token.strip())
    for rec in db.get("tokens", []):
        if rec.get("sha256") == h and not rec.get("revoked_at"):
            return rec
    return None


def _resolve_local_token() -> str | None:
    env = os.environ.get("KB_TOKEN")
    if env and env.strip():
        return env.strip()
    cfg_home = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    for path in (cfg_home / "kb" / "token", cfg_home / "cognatlas" / "token", cfg_home / "kb-client" / "token"):
        try:
            tok = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if tok:
            return tok
    return None


def load_okf(kb_root: str):
    """import 库内的 okf_commit.py，与 CLI 共用同一份实现（契约见 INTERFACE.md §4）。"""
    path = Path(kb_root) / ".okf" / "okf_commit.py"
    if not path.is_file():
        print(f"[ERROR/OKF-MISSING] {path} 不存在", file=sys.stderr)
        raise SystemExit(1)
    spec = importlib.util.spec_from_file_location("okf_commit", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)          # 模块级只有常量与 stdout 重配，无副作用
    return module


def init_db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB))
    con.execute(
        "CREATE TABLE IF NOT EXISTS health ("
        " id INTEGER PRIMARY KEY CHECK (id = 1),"
        " snapshot TEXT NOT NULL,"
        " generated_at TEXT NOT NULL,"
        " written_at TEXT NOT NULL)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS docs ("
        " path TEXT PRIMARY KEY,"
        " title TEXT NOT NULL,"
        " type TEXT,"
        " status TEXT,"
        " tags TEXT,"
        " stale_after TEXT,"
        " mtime TEXT,"
        " body TEXT NOT NULL)"
    )
    con.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5("
        " path UNINDEXED, title, body, tags, tokenize='trigram')"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS index_meta ("
        " id INTEGER PRIMARY KEY CHECK (id = 1),"
        " built_at TEXT NOT NULL,"
        " docs INTEGER NOT NULL,"
        " skipped INTEGER NOT NULL)"
    )
    return con


# ---------------------------------------------------------------- 刷新（S6 + S8 索引）
def cmd_refresh(cfg: dict) -> int:
    """跑一次 okf 快照 + 重建检索索引 → 落库。请求路径上不重算，只有这里算。"""
    module = load_okf(cfg["kb_root"])
    root = module.repo_root(module.TOOL_DIR)
    snap = module.status_snapshot(root, module.load_config())
    written = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    rows, skipped = build_docs(module, root, cfg)
    con = init_db()
    with con:
        con.execute(
            "INSERT OR REPLACE INTO health (id, snapshot, generated_at, written_at) VALUES (1, ?, ?, ?)",
            (json.dumps(snap, ensure_ascii=False), snap["generated_at"], written),
        )
        con.execute("DELETE FROM docs")
        con.execute("DELETE FROM docs_fts")
        con.executemany(
            "INSERT INTO docs (path, title, type, status, tags, stale_after, mtime, body)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        con.executemany(
            "INSERT INTO docs_fts (path, title, body, tags) VALUES (?, ?, ?, ?)",
            [(r[0], r[1], r[7], r[4] or "") for r in rows])
        con.execute(
            "INSERT OR REPLACE INTO index_meta (id, built_at, docs, skipped) VALUES (1, ?, ?, ?)",
            (written, len(rows), skipped))
    con.close()
    print(json.dumps({"ok": True, "db": str(DB), "generated_at": snap["generated_at"],
                      "total": snap["total"], "errors": snap["errors"],
                      "ghost": snap["ghost"], "unreadable": snap["unreadable"],
                      "indexed": len(rows), "index_skipped": skipped},
                     ensure_ascii=False))
    return 0


def build_docs(module, root: Path, cfg: dict):
    """把 git 视野内的 md 读成索引行。坏输入按 NoteReadError 跳过并计数，不中断。"""
    rows, skipped = [], 0
    cfg_okf = module.load_config()
    for rel in module.git_scoped_markdown(root):
        if module.is_reserved(rel, cfg_okf):
            continue
        fp = root / rel
        if not fp.is_file():          # 索引里有、工作区已删：与 status 的 ghost 同口径
            skipped += 1
            continue
        try:
            text = module.read_note_text(fp, rel)
        except module.NoteReadError:
            skipped += 1
            continue
        data, _raw, body = module.split_frontmatter(text)
        data = data if isinstance(data, dict) else {}
        title = str(data.get("title") or module.extract_title(data, text, rel) or Path(rel).stem)
        tags = module.as_list(data.get("tags"))
        rows.append((
            rel, title, _scalar(data.get("type")), _scalar(data.get("status")),
            json.dumps([str(t) for t in tags], ensure_ascii=False),
            _scalar(data.get("stale_after")),
            dt.datetime.fromtimestamp(fp.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            body,
        ))
    return rows, skipped


def _scalar(v):
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


# ---------------------------------------------------------------- HTTP 服务（S7 / S8）
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def read_health_row():
    try:
        con = sqlite3.connect(str(DB))
        try:
            return con.execute("SELECT snapshot, generated_at, written_at FROM health WHERE id = 1").fetchone()
        finally:
            con.close()
    except sqlite3.OperationalError:
        return None


def read_index_meta():
    try:
        con = sqlite3.connect(str(DB))
        try:
            row = con.execute("SELECT built_at, docs, skipped FROM index_meta WHERE id = 1").fetchone()
        finally:
            con.close()
    except sqlite3.OperationalError:
        row = None
    if row is None:
        return {"built_at": None, "docs": 0, "skipped": 0, "age_seconds": None, "stale": True}
    built_at, docs, skipped = row
    try:
        age = int((_now() - dt.datetime.fromisoformat(built_at)).total_seconds())
    except ValueError:
        age = None
    return {"built_at": built_at, "docs": docs, "skipped": skipped, "age_seconds": age, "stale": None}


def health_payload(cfg: dict) -> tuple[int, dict]:
    """只读快照，不重算。契约见 INTERFACE.md §7.2。"""
    kb_root = Path(cfg["kb_root"])
    if not kb_root.is_dir():
        return 503, {"ok": False, "reason": "kb-missing", "kb_root": str(kb_root)}
    row = read_health_row()
    if row is None:
        return 503, {"ok": False, "reason": "no-snapshot"}
    snapshot, generated_at, written_at = row
    try:
        snap = json.loads(snapshot)
        born = dt.datetime.fromisoformat(generated_at)
    except (json.JSONDecodeError, ValueError) as exc:
        return 503, {"ok": False, "reason": "snapshot-corrupt", "detail": str(exc)}
    age = int((_now() - born).total_seconds())
    idx = read_index_meta()
    if idx["age_seconds"] is not None:
        idx["stale"] = idx["age_seconds"] > int(cfg["refresh_interval_seconds"])
    return 200, {
        "ok": True,
        "kb": {
            "total": snap.get("total"),
            "errors": snap.get("errors"),
            "ghost": snap.get("ghost"),
            "unreadable": snap.get("unreadable"),
            "generated_at": generated_at,
            "age_seconds": age,
            "stale": age > int(cfg["refresh_interval_seconds"]),
        },
        "index": {"docs": idx["docs"], "updated_at": idx["built_at"], "stale": idx["stale"]},
        "served_at": _now().isoformat(timespec="seconds"),
    }


def _expired(stale_after, today: dt.date) -> bool:
    if not stale_after:
        return False
    try:
        return dt.date.fromisoformat(str(stale_after)[:10]) < today
    except ValueError:
        return False


def search_payload(cfg: dict, payload: dict) -> tuple[int, dict]:
    """检索：FTS5 召回 + 溯源字段 + 过期文档默认召回但带警告。契约见 INTERFACE.md §7.3。"""
    q = str(payload.get("q") or payload.get("query") or "").strip()
    if not q:
        return 400, {"ok": False, "reason": "empty-query"}
    limit = payload.get("limit", cfg["search_limit_default"])
    try:
        limit = max(1, min(int(limit), int(cfg["search_limit_max"])))
    except (TypeError, ValueError):
        return 400, {"ok": False, "reason": "bad-limit"}
    exclude_expired = bool(payload.get("exclude_expired", False))
    if not DB.is_file():
        return 503, {"ok": False, "reason": "no-index"}
    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row
    try:
        try:
            meta = con.execute("SELECT built_at, docs FROM index_meta WHERE id = 1").fetchone()
            if meta is None:
                return 503, {"ok": False, "reason": "no-index"}
            hits = _query(con, cfg, q, limit, exclude_expired)
        except sqlite3.OperationalError:
            return 503, {"ok": False, "reason": "no-index"}
    finally:
        con.close()
    try:
        age = int((_now() - dt.datetime.fromisoformat(meta["built_at"])).total_seconds())
    except ValueError:
        age = None
    return 200, {
        "ok": True,
        "query": q,
        "count": len(hits),
        "index": {"docs": meta["docs"], "built_at": meta["built_at"], "age_seconds": age,
                  "stale": (age is not None and age > int(cfg["refresh_interval_seconds"]))},
        "hits": hits,
        "served_at": _now().isoformat(timespec="seconds"),
    }


def _snippet(text: str, q: str, n: int) -> str:
    """短查询的片段：按命中位置开窗，用 «» 标出命中的词（FTS 的 snippet 只覆盖 trigram 路径）。"""
    body = " ".join(text.split())
    i = body.lower().find(q.lower())
    if i < 0:
        return body[: n * 6]
    lo, hi = max(0, i - n * 3), min(len(body), i + len(q) + n * 4)
    return ("…" if lo > 0 else "") + body[lo:i] + "«" + body[i:i + len(q)] + "»" + body[i + len(q):hi] + ("…" if hi < len(body) else "")


def _query(con, cfg, q: str, limit: int, exclude_expired: bool):
    today = _now().date()
    n = int(cfg["snippet_tokens"])
    if len(q) >= 3:                      # trigram 至少要 3 个字符才建 token
        match = '"' + q.replace('"', '""') + '"'
        rows = con.execute(
            "SELECT d.path, d.title, d.status, d.type, d.tags, d.stale_after, d.mtime,"
            " snippet(docs_fts, 2, '«', '»', '…', ?) AS snip, bm25(docs_fts) AS score"
            " FROM docs_fts JOIN docs d ON d.path = docs_fts.path"
            " WHERE docs_fts MATCH ? ORDER BY score LIMIT ?",
            (n, match, limit * 3)).fetchall()
    else:                                # 短查询退回包含匹配（中文两字词走这里）
        like = f"%{q}%"
        rows = con.execute(
            "SELECT d.path, d.title, d.status, d.type, d.tags, d.stale_after, d.mtime,"
            " d.body AS snip, 0.0 AS score"
            " FROM docs d WHERE d.body LIKE ? OR d.title LIKE ? OR IFNULL(d.tags,'') LIKE ?"
            " ORDER BY d.mtime DESC LIMIT ?",
            (like, like, like, limit * 3)).fetchall()
    out = []
    for r in rows:
        snip = r["snip"] or ""
        snip = re.sub("«+", "«", re.sub("»+", "»", snip))   # trigram 重叠命中会叠标记，收敛成一个
        expired = _expired(r["stale_after"], today)
        if expired and exclude_expired:
            continue
        warnings = []
        if expired:
            warnings.append(f"expired: stale_after={str(r['stale_after'])[:10]}（该文档已过期，结论需复核）")
        out.append({
            "path": r["path"],
            "title": r["title"],
            "status": r["status"],
            "type": r["type"],
            "stale_after": r["stale_after"],
            "expired": expired,
            "score": round(float(r["score"] or 0.0), 6),
            "snippet": snip if len(q) >= 3 else _snippet(snip, q, n),
            "mtime": r["mtime"],
            "warnings": warnings,
        })
        if len(out) >= limit:
            break
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "kb-serve"

    def log_message(self, fmt, *args):      # 日志进 journal 由 systemd 管，避免请求行刷屏
        return

    def _send(self, code: int, payload: dict, headers: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        """鉴权失败时直接回 401 并返回 None；成功返回令牌记录。"""
        if not self.server.cfg.get("auth_required", True):
            return {"identity": "anonymous", "name": "anonymous"}
        hdr = self.headers.get("Authorization") or ""
        token = hdr[7:].strip() if hdr.lower().startswith("bearer ") else ""
        rec = token_identity(token)
        if not rec:
            self._send(401, {"ok": False, "auth": False, "reason": "unauthorized"},
                       {"WWW-Authenticate": 'Bearer realm="kb"'})
            return None
        return rec

    def do_GET(self):
        who = self._auth()
        if who is None:
            return
        path = self.path.split("?", 1)[0]
        if path == "/health":
            code, payload = health_payload(self.server.cfg)
            return self._send(code, payload)
        return self._send(404, {"ok": False, "reason": "not-found"})

    def do_POST(self):
        who = self._auth()
        if who is None:
            return
        path = self.path.split("?", 1)[0]
        if path != "/search":
            return self._send(404, {"ok": False, "reason": "not-found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("body 不是 JSON 对象")
        except (ValueError, UnicodeDecodeError) as exc:
            return self._send(400, {"ok": False, "reason": "bad-json", "detail": str(exc)})
        code, out = search_payload(self.server.cfg, payload)
        return self._send(code, out)


def cmd_serve(cfg: dict) -> int:
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", int(cfg["port"])), Handler)
    except OSError as exc:
        print(f"[ERROR/PORT-IN-USE] 无法监听 127.0.0.1:{cfg['port']}：{exc}", file=sys.stderr)
        return 1
    srv.cfg = cfg
    print(f"kb-serve 监听 http://127.0.0.1:{cfg['port']}  （kb_root={cfg['kb_root']}，db={DB}）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


# ---------------------------------------------------------------- MCP stdio（S9）
MCP_PROTOCOL = "2024-11-05"

MCP_TOOLS = [
    {
        "name": "search_knowledge",
        "description": "在本地知识库里检索文档。返回带绝对路径、标题、片段与警告的命中列表；"
                       "过期文档照常返回，但带 expired 警告。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索词（中英文均可）"},
                "limit": {"type": "integer", "description": "返回条数，默认取服务配置", "minimum": 1},
                "exclude_expired": {"type": "boolean",
                                    "description": "true 时过滤过期文档；默认 false（过期照常召回并警告）"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_document_detail",
        "description": "按相对路径取一篇已索引文档的头部元数据与正文（只能取索引内的文档）。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "相对知识库根的路径，如 70-元知识/70.1-OKF规范要点.md"}},
            "required": ["path"],
        },
    },
]


def mcp_search(cfg: dict, args: dict) -> dict:
    payload = {"q": args.get("query"), "limit": args.get("limit", cfg["search_limit_default"]),
               "exclude_expired": bool(args.get("exclude_expired", False))}
    return search_payload(cfg, payload)[1]


def mcp_detail(cfg: dict, args: dict) -> dict:
    rel = str(args.get("path") or "").strip()
    if not rel:
        return {"ok": False, "reason": "empty-path"}
    if not DB.is_file():
        return {"ok": False, "reason": "no-index"}
    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            "SELECT path, title, type, status, tags, stale_after, mtime, body FROM docs WHERE path = ?",
            (rel,)).fetchone()
    finally:
        con.close()
    if row is None:
        return {"ok": False, "reason": "not-indexed", "path": rel}
    today = _now().date()
    expired = _expired(row["stale_after"], today)
    out = {"ok": True, "path": row["path"], "title": row["title"], "type": row["type"],
           "status": row["status"], "tags": json.loads(row["tags"] or "[]"),
           "stale_after": row["stale_after"], "expired": expired, "mtime": row["mtime"],
           "warnings": [], "body": row["body"]}
    if expired:
        out["warnings"].append(f"expired: stale_after={str(row['stale_after'])[:10]}（该文档已过期，结论需复核）")
    out["abs_path"] = str(Path(cfg["kb_root"]) / row["path"])
    return out


def _render_search(d: dict) -> str:
    if not d.get("ok"):
        return f"检索失败：{d.get('reason')}"
    if not d.get("hits"):
        return f"没有命中（query={d.get('query')}）。知识库里没有相关内容，不要编造。"
    lines = [f"query={d['query']}  命中 {d['count']} 条  索引 {d['index']['docs']} 篇"
             f"（built_at={d['index']['built_at']}）"]
    for h in d["hits"]:
        lines.append(f"- {h['path']} | {h['title']} | score={h['score']} | status={h['status']}")
        if h["snippet"]:
            lines.append(f"  片段：{h['snippet']}")
        for w in h["warnings"]:
            lines.append(f"  ⚠ {w}")
    return "\n".join(lines)


def mcp_handle(cfg: dict, msg: dict) -> dict | None:
    """一条 JSON-RPC 消息 → 一条响应；通知（无 id）返回 None。"""
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "kb-serve", "version": "1.0.0"},
        }}
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": MCP_TOOLS}}
    if method == "tools/call":
        params = msg.get("params") or {}
        name, args = params.get("name"), (params.get("arguments") or {})
        if name == "search_knowledge":
            if not str(args.get("query") or "").strip():
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "query 不能为空"}}
            text, is_err = _render_search(mcp_search(cfg, args)), False
        elif name == "get_document_detail":
            d = mcp_detail(cfg, args)
            is_err = not d.get("ok")
            text = json.dumps(d, ensure_ascii=False) if is_err else (
                f"{d['title']}（{d['path']}）\nstatus={d['status']} type={d['type']} "
                f"tags={d['tags']} stale_after={d['stale_after']}\n"
                + "".join(f"⚠ {w}\n" for w in d["warnings"]) + "\n" + d["body"])
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"未知工具：{name}"}}
        return {"jsonrpc": "2.0", "id": mid,
                "result": {"content": [{"type": "text", "text": text}], "isError": is_err}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"未知方法：{method}"}}


def cmd_mcp(cfg: dict) -> int:
    """MCP stdio：逐行 JSON-RPC。stdout 只写协议消息，日志走 stderr。"""
    rec = token_identity(_resolve_local_token())
    if not rec:
        print("[ERROR/AUTH-NEEDED] MCP 需要有效 token：设置 KB_TOKEN 或先运行 kb token new --name me --save",
              file=sys.stderr, flush=True)
        return 2
    print(f"kb-serve MCP stdio 就绪（identity={rec.get('identity')}，tools={[t['name'] for t in MCP_TOOLS]}）",
          file=sys.stderr, flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            _mcp_emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
            continue
        try:
            resp = mcp_handle(cfg, msg if isinstance(msg, dict) else {})
        except Exception as exc:                      # 单条消息出问题不许拖垮整个会话
            resp = {"jsonrpc": "2.0", "id": (msg or {}).get("id"), "error": {"code": -32603, "message": str(exc)}}
        if resp is not None:
            _mcp_emit(resp)
    return 0


def _mcp_emit(obj: dict):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="kb-serve", description="知识库服务（健康快照 / 检索 / MCP）")
    ap.add_argument("--refresh", action="store_true", help="跑一次健康快照 + 重建检索索引并落库（手动刷新）")
    ap.add_argument("--serve", action="store_true", help="启动 HTTP 服务（不带参数时的默认动作）")
    ap.add_argument("--mcp", action="store_true", help="以 MCP stdio 模式运行（供 Cherry Studio 等客户端拉起）")
    args = ap.parse_args(argv)
    cfg = load_cfg()
    if args.refresh:
        return cmd_refresh(cfg)
    if args.mcp:
        return cmd_mcp(cfg)
    return cmd_serve(cfg)


if __name__ == "__main__":
    sys.exit(main())
