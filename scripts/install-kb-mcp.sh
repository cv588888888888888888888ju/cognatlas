#!/usr/bin/env bash
# 安装知识库 MCP 服务（kb-serve --mcp）到用户目录，供 AI 客户端拉起。
# 幂等：重复运行不覆盖已有 config.json（除非 --force-config），不 sudo，不改任何客户端配置。
# 用法：
#   KB_ROOT=/path/to/vault bash install-kb-mcp.sh
#   bash install-kb-mcp.sh --kb-root /path/to/vault [--force-config]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
BIN="${HOME}/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/kb-service"
KB_ROOT_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --kb-root) KB_ROOT_ARG="$2"; shift 2 ;;
    --force-config) FORCE_CONFIG=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "需要 python3" >&2; exit 1; }

KB_ROOT="${KB_ROOT_ARG:-${KB_ROOT:-${KB_SERVE_KB_ROOT:-}}}"
if [ -z "$KB_ROOT" ] && [ -f "$DATA/config.json" ]; then
  KB_ROOT=$(python3 -c "import json,sys;print(json.load(open('$DATA/config.json')).get('kb_root',''))" 2>/dev/null || true)
fi
if [ -z "$KB_ROOT" ]; then
  echo "没有指定知识库：请带 --kb-root /path/to/vault，或设 KB_ROOT 环境变量" >&2
  exit 1
fi
[ -d "$KB_ROOT" ] || { echo "知识库目录不存在：$KB_ROOT" >&2; exit 1; }

mkdir -p "$BIN" "$DATA"

# 1) 安装 kb-serve（优先用随包源码，其次用 PATH 里已有的）
if [ -f "$HERE/kb-serve.py" ]; then
  cp "$HERE/kb-serve.py" "$BIN/kb-serve"
elif command -v kb-serve >/dev/null 2>&1; then
  cp "$(command -v kb-serve)" "$BIN/kb-serve"
else
  echo "找不到 kb-serve.py（随包脚本）或已安装的 kb-serve" >&2
  exit 1
fi
chmod +x "$BIN/kb-serve"

# 2) 写配置（默认不覆盖）
CFG="$DATA/config.json"
if [ ! -f "$CFG" ] || [ "${FORCE_CONFIG:-0}" = "1" ]; then
  [ -f "$CFG" ] && cp "$CFG" "$CFG.bak.$(date +%Y%m%d-%H%M%S)"
  python3 - "$CFG" "$KB_ROOT" <<'PY'
import json, sys
cfg_path, kb = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(cfg_path))
except Exception:
    cfg = {}
cfg["kb_root"] = kb
cfg.setdefault("port", 18812)
cfg.setdefault("refresh_interval_seconds", 1800)
cfg.setdefault("search_limit_default", 10)
cfg.setdefault("search_limit_max", 50)
cfg.setdefault("snippet_tokens", 16)
json.dump(cfg, open(cfg_path, "w"), ensure_ascii=False, indent=2)
print("config:", cfg_path)
PY
fi

# 3) 建索引（失败不致命，MCP 仍可启动但会返回 no-index）
KB_SERVE_HOME="$DATA" "$BIN/kb-serve" --refresh 2>&1 | tail -2 || echo "warn: --refresh 失败（知识库可能缺 .okf/okf_commit.py）"

# 4) 令牌检查（MCP 强制鉴权；缺失只警告，不代签）
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/kb/token"
if [ -z "${KB_TOKEN:-}" ] && [ ! -s "$TOKEN_FILE" ]; then
  echo "warn: 未找到令牌（$TOKEN_FILE）；MCP 会以退出码 2 拒绝启动。" >&2
  echo "      先运行：kb token new --name mcp --save" >&2
fi

# 5) 打印客户端配置片段
cat <<EOF

kb-serve 已安装：$BIN/kb-serve
配置：$CFG
下一步把下面片段加进你的 AI 客户端（路径已按当前用户填好）：

[Claude Code / ~/.claude.json 或 mcp.json]
{"mcpServers":{"kb":{"command":"$BIN/kb-serve","args":["--mcp"],"env":{"KB_TOKEN_FILE":"$TOKEN_FILE"}}}}

[Codex config.toml]
[mcp_servers.kb]
command = "$BIN/kb-serve"
args = ["--mcp"]
startup_timeout_ms = 20000
[mcp_servers.kb.env]
KB_TOKEN_FILE = "$TOKEN_FILE"

[Cursor ~/.cursor/mcp.json]
{"mcpServers":{"kb":{"command":"$BIN/kb-serve","args":["--mcp"],"env":{"KB_TOKEN_FILE":"$TOKEN_FILE"}}}}

自检（必须带令牌）：
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | KB_TOKEN_FILE="$TOKEN_FILE" "$BIN/kb-serve" --mcp
EOF
