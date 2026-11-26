# 让 AI 帮你安装知识库 MCP（复制即用）

把下面整段 prompt 发给任意能执行命令的 AI（Claude Code / Codex / Cursor / 其它 agent）。它只做用户级安装，不需要 sudo。

---

## 可直接复制的 prompt

```text
你是我的本机运维助手。请在这台机器上安装「知识库 MCP 服务」（kb-serve --mcp），让我在 AI 客户端里能检索我的 markdown 知识库。

约束：
1. 只写用户目录（~/.local/bin、~/.local/share/kb-service），不要 sudo，不要改系统路径。
2. 幂等：如果已经装过，不要重复覆盖配置；需要改配置时先备份。
3. 不确定知识库路径时先问我，不要猜；确认目录里存在 .okf/config.yaml（OKF 知识库标志）。
4. 鉴权：本机必须先有有效令牌（运行 kb token new --name mcp --save，或在桌面客户端启动一次自动生成）。MCP 配置里加 env KB_TOKEN_FILE=<HOME>/.config/kb/token；没有令牌时 kb-serve --mcp 会直接以退出码 2 拒绝启动。

步骤：
A. 确认 python3 >= 3.10 存在。
B. 把随包脚本目录里的 install-kb-mcp.sh、kb-serve.py 复制到临时目录（如果脚本已经在手边，直接用）。
C. 执行：KB_ROOT=<我的知识库绝对路径> bash install-kb-mcp.sh
D. 验证 stdio MCP 能握手：
   KB_TOKEN_FILE=$HOME/.config/kb/token printf '%s
' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ~/.local/bin/kb-serve --mcp
   期望输出里能看到 "search_knowledge" 与 "get_document_detail" 两个工具，且没有 traceback。
E. 把下面片段写入我使用的客户端配置（先告诉我你要改哪个文件，再改；改前备份）：
   - Claude Code (~/.claude.json 或项目 .mcp.json)：{"mcpServers":{"kb":{"command":"<HOME>/.local/bin/kb-serve","args":["--mcp"],"env":{"KB_TOKEN_FILE":"<HOME>/.config/kb/token"}}}}
   - Codex (config.toml)：[mcp_servers.kb] command="<HOME>/.local/bin/kb-serve" args=["--mcp"]
   - Cursor (~/.cursor/mcp.json)：同上 mcpServers 结构
F. 最后报告：安装路径、配置路径、自检输出、以及我下一步要怎么在客户端里启用这个 MCP。

排错顺序（不要跳步）：
- 握手失败：先手动跑 D 的验证命令，把 stderr 原文贴给我。
- 无索引/搜索为空：跑 ~/.local/bin/kb-serve --refresh，再验证一次；仍空则检查 config.json 的 kb_root 是否指向真实知识库。
- 权限错误：确认 ~/.local/bin/kb-serve 有可执行位，不要用 sudo 修。
```

---

## 手工安装（四步）

```bash
# 0. 先有令牌（没有就会 401 / 退出码 2）；桌面客户端启动过可跳过
kb token new --name mcp --save

# 1. 安装 kb-serve 并写配置（KB_ROOT 换成你的知识库）
KB_ROOT=/path/to/vault bash install-kb-mcp.sh

# 2. 建索引
~/.local/bin/kb-serve --refresh

# 3. 自检（应看到两个工具）
printf '%s
' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ~/.local/bin/kb-serve --mcp
```

安装脚本做的事：
- 检查 `~/.config/kb/token`（或 `KB_TOKEN`）是否存在；缺失时打印签发命令但不代签；
- 复制 `kb-serve.py` → `~/.local/bin/kb-serve`，加可执行位；
- 首次写 `~/.local/share/kb-service/config.json`（已存在则不动，`--force-config` 才改并先备份）；
- 跑一次 `--refresh` 建索引；
- 打印各客户端配置片段。

## 客户端配置片段

| 客户端 | 文件 | 片段 |
|---|---|---|
| Claude Code | `~/.claude.json` 或项目 `.mcp.json` | `{"mcpServers":{"kb":{"command":"$HOME/.local/bin/kb-serve","args":["--mcp"],"env":{"KB_TOKEN_FILE":"$HOME/.config/kb/token"}}}}` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.kb]\ncommand = ".../kb-serve"\nargs = ["--mcp"]\nstartup_timeout_ms = 20000` |
| Cursor | `~/.cursor/mcp.json` | 同 Claude Code 的 `mcpServers` 结构 |
| Cherry Studio | 设置 → MCP → 添加 | 类型 stdio，命令 `~/.local/bin/kb-serve`，参数 `--mcp` |

## 验证与回滚

- 自检命令见上；成功判据：`tools/list` 返回两个工具且进程正常退出（或保持 stdio 等待）。
- 实际检索：在客户端调 `search_knowledge`，query 用你库里确定有的词；返回结果带 `path/title/snippet`。
- 回滚：`rm ~/.local/bin/kb-serve`、`rm -r ~/.local/share/kb-service`，并从客户端配置里删掉 `kb` 条目（配置改前已备份）。
- 端口无关：stdio 模式不占端口；只有 HTTP 模式（`kb-serve` 无参）才监听 127.0.0.1:18812。
