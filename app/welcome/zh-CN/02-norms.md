# 泛用规范

这页是所有文档都适用的底线。它描述的是**当前库的实际规则**，不是理想设计；改规则要同步改 `.okf/config.yaml` 与本页。

## frontmatter 的 12 个标准字段

顺序固定（`okf commit` 会自动归一到这个顺序，未列出的自定义字段排在后面并保留）：

| 字段 | 含义 | 必填 |
|---|---|---|
| `type` | 文档类型，见下节 | ✅ |
| `title` | 标题；正文 H1 之外的独立标题 | 建议 |
| `description` | 一句话摘要，检索与悬浮预览直接用它 | 强烈建议 |
| `tags` | 标签数组，复用既有词表 | 建议 |
| `aliases` | 别名，便于搜索命中 | 可选 |
| `status` | `draft` / `stable` / `deprecated` | 建议 |
| `generated.by` | 最后更新者身份 | ✅ |
| `generated.at` | 最后更新时间，提交时自动刷新 | ✅ |
| `source_checked` | 是否做过源检查（布尔，必须显式写） | ✅ |
| `source_checked_at` | 源检查时间 | 可选 |
| `verified` | 校验记录数组（工具自动追加） | 自动 |
| `stale_after` | 过期日期，到期后检索带警告 | 建议 |
| `sources` | 外部来源列表 | 可选 |

四个必填缺一不可，`okf commit` 会直接拒绝并回滚。

## 文档类型

库里现有的取值：

- `Knowledge` —— 可复用的知识、规范、结论（最常用）。
- `Note` —— 过程笔记、临时记录、待整理。
- `Policy` —— 约束性规则（门禁、流程、必须遵守的约定）。
- `Asset` —— 图片、附件等非文本资源。

拿不准就写 `Note`：它是默认兜底，之后可以随时升级成 `Knowledge`。

## 属性写什么

- `description`：一句能独立看懂的话，不要写「本文介绍了……」。
- `tags`：先搜词表再加。同一个概念不要造第二个标签（例如「Agent工程」与「Agent 工程」）。
- `status`：`draft` 表示还会大改，`stable` 表示可以引用，`deprecated` 表示保留但别再用。
- `stale_after`：有外部事实（版本、价格、API、政策）的文档必须写；纯内部结论可以不写。

## 命名与目录

- 文件名用中文短句或 `编号-主题`，不要用空格与 `#`、`?` 等符号。
- 目录按「领域」分，不按「时间」分；时间信息放 frontmatter 与正文。
- `_raw/` 只放原始材料，不参与治理；`70-元知识/` 放规范本身；`00-收件箱/` 放还没归类的草稿。
- 新建用 `kb new "标题" --dir 30-Agent工程`，骨架会自动补必填字段。

## 链接

- 内部链接写 `[[文件名]]` 或 `[文字](相对路径.md)`；两者都会进反链。
- 链接指向「规范/索引」优先于指向同层碎片。
- 改名用客户端重命名或 `kb rename`，会全库改链；不要在文件管理器里直接改。

## 提交身份与令牌

- `human:user` —— 你本人。桌面客户端与交互终端默认用这个身份；客户端首启会自动签发令牌。
- `agent:<runtime>:<sessionId>` —— AI 会话认领的令牌，例如 `agent:deepseekharness:s-abc123`。
- `process:<name>` —— 无会话的脚本、cron。
- 令牌命令：`kb token new --name <名字> [--runtime deepseekharness --session <sessionId>] [--save]`；明文只打印一次，`--save` 会写进 `~/.config/kb/token`。
- **没有有效令牌一律拒绝**：CLI 退出码 2（AUTH-NEEDED / AUTH-INVALID），HTTP 返回 401，MCP 直接退出 2。第一次用先跑 `kb token new --name me --save`。
- 提交后 `git log` 的作者就是令牌身份；客户端状态栏会显示「最后提交：谁 · 日期」。
- 不要把令牌写进知识库、不要提交到 git。

## 检查器

- 内容级检查由 `.okf/checkers/` 下的插件负责，`okf check` 跑全部插件；提交时按 `checkers.gate`（`warn` 只提示 / `block` 拒绝）执行。
- 格式门禁（frontmatter 必填、YAML 可解析）仍在 okf 内建，不要试图绕过。
- 健康阈值与检查器参数在 `.okf/health.yaml`；`okf health --json` 给出 `ok`、指标与 `violations`。默认值只是起点，按项目改，别为变绿改标准。

## 不要做的事

- 不要手写 `generated.at` 假装刚更新过；它由提交自动刷新。
- 不要为了「好看」补一堆没读过的 `verified` 记录。
- 不要把同一份内容复制到两个目录；用链接与索引。
- 不要在正文里手写绝对路径或 `file://` 链接。
