# 使用建议：让 AI 写，你来看

这套库的目标不是「手写得很整齐」，而是**把整理成本压到最低，把判断留给你**。所以默认分工是：

> AI 负责改文件、补 frontmatter、打标签、连链接、跑校验；你负责读、判断、拍板。

## 为什么这样分工

- 机械活（字段顺序、时间戳、状态归一、路径、链接改写）交给工具，不会漏，也不会写出「看起来对」的假字段。
- 判断活（这篇值不值得留、结论对不对、链接该连到哪）只有你能做。
- 客户端是给你**看**的：树、反链、悬浮预览、检索、历史版本；不是让你逐字敲字段的。

## 一次典型的编辑

1. 你丢一句话给 AI：「把今天这个结论记进知识库，放 30-Agent工程，连到 30.11」。
2. AI 用 `kb new` 建骨架 → 写正文 → 补 `description` / `tags` / `[[链接]]` → `kb save` 或客户端保存（自动 `okf commit`）。
3. 客户端里你读一遍：标题是否说清结论、描述是否一句话、标签是否复用既有词表、链接是否指对。
4. 要改就直接在客户端改：属性点一下就能编辑，正文改完自动保存。

## AI 编辑时该守的规矩

- **身份**：AI 先认领令牌——`kb token new --name <名字> --runtime deepseekharness --session <sessionId>`，把输出放进 `KB_TOKEN` 再调用 CLI；没有令牌会被直接拒绝。不能用 `human:` 冒充人工审阅。
- **三必填**：`type`、`generated.by`、`generated.at`、`source_checked` 一个都不能少；不声明 `source_checked` 会被门禁直接拒绝。
- **描述**：`description` 写成一句可独立看懂的话——它会出现在检索结果和悬浮预览里。
- **标签**：先查现有词表再加新词；同义标签是检索的大敌。
- **链接**：优先链到「最近的规范/索引」，不要链一堆同层文档；反链是长出来的，不是硬造的。

## 你该看什么（而不是逐字校对）

- 标题与描述：能不能在没有上下文时看懂。
- 事实：数字、日期、版本、路径是否可复现。
- 时效：`stale_after` 到了没有；过期内容仍会被检索到，但会带警告。
- 结构：这篇该不该拆、该不该并入别的文档。

## 客户端替你做的事

- 保存即提交：写盘后立刻 `okf commit`，失败会回滚并提示拒绝原因。
- 外部改动检测：文件在编辑器外被改过，保存会报冲突而不是覆盖。
- 属性历史：每个字段的变更都能在右侧栏看历史版本。
- 条目标签：给单个属性打标签，不动文件级 tags。
- 提交者显示：状态栏显示最后一次提交的身份与日期；历史面板能看到每个字段是谁改的。

## 常见坑

- 手写 frontmatter 容易漏 `source_checked`；用 `kb new` 或客户端新建，骨架是补好的。
- 复制旧文档当模板会把旧时间戳带进来；`generated.at` 由提交自动刷新，但别手工写死。
- 改名不要用文件管理器：用客户端重命名或 `kb rename`，否则全库链接会断。

## 外链与视频块

- 外链默认在内置浏览器打开；加载成功后会自动快照。断网或加载失败会自动回退到最近快照，顶部黄条显示「离线快照 · 抓取于 …」，可点「重试在线」。
- 普通链接里的 file: / javascript: / data: 一律拦截，只显示原因；本地文件只能作为视频或图片资产，路径相对当前文档，或以 / 开头表示知识库根，不允许跑出知识库。
- 视频用声明式块，插件在 .okf/plugins/video：

```kb-video
src: https://example.com/clip.mp4
fallback: _assets/clip.mp4
poster: _assets/poster.png
title: 演示
controls: true
```

- 在线视频加载失败会切换到 fallback 并显示黄色警告；没有 fallback 就显示错误。

### 插件与信任

- 本地 vault 插件默认信任，不弹授权框。清单 `.okf/plugins/<name>/plugin.json` 里写 `client: "client.js"`，客户端启动时就在隔离 iframe 里执行它；只写声明式 `component`/`props` 的插件不会执行 JS。
- 插件能改的范围：`ui.html/css/toast` 改插件 UI 区、`webview.eval/css/navigate/getUrl` 改内置浏览器、`commands.register` 加命令面板项。清单的 `capabilities` 可只留需要的几项。
- 插件拿不到 `window.kb`、Node、`ipcRenderer` 或文件系统；`webview.navigate` 只放行 http/https，`file:` 会被拒绝。
- 不信任某个插件：清单里写 `trusted: false`；想一次全关：客户端 config.json 设 `plugins.client_enabled: false`，或启动时设 `KB_NO_PLUGIN_CLIENT=1`。
- 插件是本地代码，安装前自己看一眼 `client.js`；它不是沙箱里的远程度假村，只是不直接拿到宿主能力。

- 按 Ctrl+Shift+K（或命令面板「检查当前文档（插件检查器）」）会同时跑 OKF 内建检查、.okf/checkers/ 与 .okf/plugins/*/checker.py，结果显示行号与错误码。
