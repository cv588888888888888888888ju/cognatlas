# 变更记录

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
- 空目录不是建库器：没有 .okf 时只能编辑，不能提交/health/插件。
- 插件默认信任；client 插件虽有 iframe 隔离，仍是你主动安装的代码。
- 令牌不是操作系统级安全边界。
- macOS 与 ARM 未构建。
- Windows 仅在 Wine 11.22 下完成主要路径验证，未在真实 Windows 长期验证。

### 修复

- Windows MinGit 默认 core.autocrlf=true 导致保存后 CRLF：仓库初始化时设
  core.autocrlf=false、core.safecrlf=false。
- okf 提交写文件统一 newline=\n，避免跨平台换行漂移。
