# 变更记录

## 0.1.1 — 2026-11-26

### 修复

- 空目录首次打开不再只做 git init：现在会生成完整的 .okf 工具链并做首次提交；
  保存走 okf fmt/lint/commit，不再返回 NO-OKF。
- 只有 .git 的旧空目录也会补建 .okf；已有 .okf 的库不覆盖。
- 非空且无 .okf 的目录仍保持只读可编辑，不自动改写用户文件。

### 新增

- 内置通用 OKF starter：okf、okf_commit.py、config.yaml、health.yaml、
  broken-links 与 stale-docs 检查器。
- 空库状态栏提示与 test/bootstrap.test.js。

## 0.1.0 — 2026-11-26（preview）

首个可发布预览。公开名称定为 Cognatlas（cognition + atlas）；产品路径迁移到 cognatlas，旧数据自动复制。

### 新增

- Electron 33 + CodeMirror 6 桌面客户端：文件树、编辑器、状态栏、会话恢复。
- 保存时自动 fmt / lint / commit；失败不写盘；自动保存与冲突检测。
- frontmatter 属性面板、字段/tag/类型/链接补全、反链、条目历史。
- 链接三态、内置浏览器、外链快照与离线回退。
- 全库检索：本机 kb-serve 优先，本地索引兜底。
- 声明式插件与 trusted client 插件（sandbox iframe）。
- 知识库健康检查：health.yaml、阈值、自定义检查器。
- 中英文内置介绍文档。
- Linux x64 发布包；Windows x64 预览包（随带 Python 3.12.8 + MinGit 2.56.1）。
- Apache-2.0 许可证、NOTICE、第三方声明、隐私与安全文档。

### 已知限制

- Windows exe 未签名；SmartScreen 会提示未知发布者。
- 无自动更新；升级需手动覆盖。
- 空目录不是建库器：没有 .okf 时只能编辑，不能提交/health/插件（0.1.1 已修复）。
- 插件默认信任；client 插件虽有 iframe 隔离，仍是你主动安装的代码。
- 令牌不是操作系统级安全边界。
- macOS 与 ARM 未构建。
- Windows 仅在 Wine 11.22 下完成主要路径验证，未在真实 Windows 长期验证。

### 修复

- Windows MinGit 默认 core.autocrlf=true 导致保存后 CRLF：仓库初始化时设
  core.autocrlf=false、core.safecrlf=false。
- okf 提交写文件统一 newline=\n，避免跨平台换行漂移。
