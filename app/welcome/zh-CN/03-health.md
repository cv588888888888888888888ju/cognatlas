# 健康度基准

「健康」不是文档数量，而是**能不能被信任地检索到**。这页给出一组可测指标与建议红线；具体数值以 `okf status --json` 的实时输出为准，不写死快照。

## 六个核心指标

| 指标 | 含义 | 健康线 |
|---|---|---|
| `errors` | lint 级错误（frontmatter 非法、字段缺失等） | **必须为 0** |
| `ghost` | git 索引里有、磁盘上已删除的文件 | **必须为 0** |
| `unreadable` | 读不了的文件（权限、编码） | **必须为 0** |
| `no_frontmatter` | 没有任何 frontmatter 的文档 | 占比 < 10%，且逐月下降 |
| `tiers` | 信任层级：unverified / machine-confirmed / human-reviewed | machine-confirmed ≥ 70% |
| `stale_after` 覆盖率 | 有外部时效事实的文档是否写了过期日 | 关键规范 100% |

`errors`、`ghost`、`unreadable` 是硬红线：任意一个非 0，先修再写新东西。

## 信任层级怎么读

- `unverified`：没经过任何校验（新文档默认）。
- `machine-confirmed`：至少跑过一次格式门禁（`okf commit` 会自动追加一条 `process:okf-commit` 记录）。
- `human-reviewed`：你本人确认过内容；只有 `human:` 身份的记录才算，AI 不能代签。

层级低不代表内容错，只代表「没留下可追溯的校验记录」。不要为了数字好看去补记录。

## 怎么测

```bash
# 全库健康快照（JSON）
python3 .okf/okf_commit.py status --json

# 客户端同款 CLI（人类可读）
kb status

# 常驻服务的健康接口（含索引新鲜度）
curl -s http://127.0.0.1:18812/health
```

`/health` 返回 `stale` 表示索引超过刷新周期（默认 30 分钟），此时检索仍可用，但结果可能落后于磁盘。

## 异常怎么处置

- **no_frontmatter 高**：优先用 `okf fmt`/客户端属性块补 `type`、`generated`、`source_checked`；批量补之前先小样本验证。
- **ghost 非 0**：通常是 `git ls-files` 里还有已删除文件；`git add -A` 后重新 status，别直接删文件。
- **unreadable 非 0**：查权限与编码；非 UTF-8 会直接计入。
- **过期文档**：保留，不要删；到期后检索照常召回并带 `expired` 警告，复核后更新 `stale_after` 或把 `status` 改成 `deprecated`。
- **反链为 0**：不是错误，但说明这篇还没进入网络；至少从索引页或上级文档链过来一次。

## 每周五分钟的检查

1. `kb status` 看三条红线是否归零。
2. 检索 `status:draft` 看有没有放了很久的草稿。
3. 看反链面板，挑一篇 0 入链的文档决定「链进去」或「归档」。
4. 看 `stale_after` 过期的文档，复核结论是否还成立。

## 自定义健康标准（进阶）

默认阈值只是起点，不是产品写死的规则。健康标准放在知识库自己的 `.okf/health.yaml` 里，跟着仓库走；换团队、换项目可以改，不需要改代码。

### 1. 改阈值

```yaml
version: 1
thresholds:
  errors_max: 0              # 硬红线：lint 错误数
  ghost_max: 0               # git 索引有、磁盘没有的文档数
  unreadable_max: 0          # 读不了的文档数
  no_frontmatter_ratio_max: 0.10
  machine_confirmed_ratio_min: 0.70
  stale_ratio_max: 0.25
  checker_errors_max: 0
checkers:
  params: {}
external: {}
```

改完立即生效：`python3 .okf/okf_commit.py health` 重新计算；`--json` 给机器读，`--strict` 让 warning 也返回非 0。`/health` 的 `kb.health` 字段返回同一份 `ok / thresholds / violations`。

`ok` 只表示没有 error 级违规；warning 会出现在 `violations` 里但不把 `ok` 置 false。想让 warning 也阻断，用 `--strict`。

### 2. 给检查器传参数

参数链从低到高：

1. `.okf/config.yaml` 的 `checkers.params`（全库默认）
2. `.okf/health.yaml` 的 `checkers.params`（健康检查专用覆盖）
3. 命令行 `--param name.key=value`（临时覆盖，可重复）

```yaml
# .okf/health.yaml
checkers:
  params:
    broken-links:
      ignore: ["草稿/", "归档/"]
    stale-docs:
      grace_days: 7
```

```bash
okf health --param stale-docs.grace_days=30
okf check --param broken-links.ignore='["临时/"]' 00-收件箱/
```

同一个 checker 名下的参数表是**整体替换**，不是深合并：health 层写了 `broken-links`，就完全接管 config 层的 `broken-links`。不想覆盖就别写这一项。

内置示例插件认这些参数：

| 插件 | 参数 | 含义 |
|---|---|---|
| `broken-links` | `ignore`（字符串数组） | 目标里含任一子串的链接跳过 |
| `broken-links` | `level` | `warn` / `error` |
| `stale-docs` | `grace_days`（整数） | 过期后再宽限几天才报 |
| `stale-docs` | `level` | `warn` / `error` |

### 3. 接外部检查器

不想让检查器住在 `.okf/checkers/`，可以把任意命令接进健康结论。`okf health` 会把指标 JSON 从 stdin 喂给它，读它 stdout 最后一行：

```yaml
external:
  command: ~/bin/check-kb
  args: ["--strict"]
  timeout_seconds: 10
```

stdin：`{root, metrics, thresholds, params}`。stdout 末行返回 `{"findings":[{"level":"warn","message":"…","value":0,"threshold":0}]}`。命令失败或超时会记一条 warning，不会让整个健康检查崩掉。

外接命令拥有本机权限，只接自己信得过的脚本；它不是沙箱。

### 4. 什么时候改标准

- 新库刚起步：先放宽 `no_frontmatter_ratio_max`，别让第一天全红；格式稳定后再收回 0.10。
- 规范库：把 `errors_max` / `ghost_max` 保持 0，`machine_confirmed_ratio_min` 提到 0.80。
- 有外部时效事实的库：把 `stale_ratio_max` 收紧，并给 `stale-docs` 设 `grace_days`。
- 数值是政策，不是事实：改了要在提交里说明为什么改，别为了变绿而改。