#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""frontmatter 助手：把 YAML 头解析/生成交给 Python（本机有 PyYAML，Node 侧不引第三方解析器）。

用法：
  python3 fm.py parse   < 文件全文  -> {"data": {...}|null, "body": "...", "raw": "..."}
  python3 fm.py build   < {"data":{...},"body":"..."} -> 文件全文
"""
import json
import re
import sys

import yaml


def split(text: str):
    text = text.lstrip("\ufeff")
    if not text.startswith("---"):
        return None, None, text
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.DOTALL)
    if not m:
        return None, None, text
    raw, body = m.group(1), text[m.end():]
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as exc:
        return {"__yaml_error__": str(exc)}, raw, body
    if not isinstance(data, dict):
        return {"__yaml_error__": "frontmatter 不是键值映射"}, raw, body
    return data, raw, body


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "parse"
    payload = sys.stdin.read()
    if mode == "parse":
        data, raw, body = split(payload)
        sys.stdout.write(json.dumps({"data": data, "raw": raw, "body": body}, ensure_ascii=False, default=str))
        return 0
    if mode == "canon":
        cfg_path = sys.argv[2]
        data = yaml.safe_load(open(cfg_path, encoding="utf-8")) or {}
        sys.stdout.write(json.dumps({"canonical_order": data.get("canonical_order") or [],
                                     "required": data.get("required") or [],
                                     "reserved_filenames": data.get("reserved_filenames") or []},
                                    ensure_ascii=False))
        return 0
    if mode == "build":
        obj = json.loads(payload)
        data = obj.get("data") or {}
        body = obj.get("body") or ""
        out = "---\n" + yaml.safe_dump(data, allow_unicode=True, sort_keys=False,
                                       default_flow_style=False).rstrip("\n") + "\n---\n" + body
        sys.stdout.write(out)
        return 0
    sys.stderr.write("unknown mode\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
