# Cognatlas 0.1.1 — 2026-11-26

Cognatlas 第二个预览版：修复“打开空目录只做 git init、没有建立 OKF 库”的问题。

## 本版变化

- **空目录自动建库**：首次选择一个空目录（或只有 `.git` 的旧空目录）时，客户端会生成
  `.okf/okf_commit.py`、`.okf/okf`、`config.yaml`、`health.yaml` 与两个示例检查器，
  并自动做一次“初始化 OKF 知识库”提交。之后新建文档保存即通过 okf 提交。
- **非空目录不改写**：非空且没有 `.okf` 的目录仍只做 `git init`，可以阅读和编辑，
  但保存会返回 `NO-OKF`，不会覆盖用户文件。
- 空库状态栏改为显示“已建立知识库 · 按 Ctrl+N 新建第一篇”。
- 新增 `test/bootstrap.test.js`，覆盖空目录建库、已有库不覆盖、旧空目录补建、
  非空目录不建库与 `NO-OKF` 降级。

## 下载

- Linux x64：cognatlas-0.1.1-linux-x64.tar.gz
- Windows x64（预览）：cognatlas-0.1.1-win32-x64.zip
- 校验：SHA256SUMS

Windows 包约 162 MB，超过 GitHub 单文件 100 MiB 限制，因此只作为 Release
asset，不提交进源码历史。

## 安装

Linux：

~~~bash
tar -xzf cognatlas-0.1.1-linux-x64.tar.gz
./cognatlas-linux-x64/cognatlas
~~~

需要系统 Git、Python 3 与 PyYAML。首次启动选择一个空目录会自动建库；
选择已有 `.okf/okf_commit.py` 的 OKF 知识库则直接打开。

Windows：

1. 解压 cognatlas-0.1.1-win32-x64.zip。
2. 双击 cognatlas.exe。
3. SmartScreen 提示未知发布者时选择「更多信息 → 仍要运行」。

Windows 包随带 Python 3.12.8 与 MinGit 2.56.1，不需要另装。

## 校验

~~~bash
sha256sum -c SHA256SUMS
~~~

Windows 可用 PowerShell：

~~~powershell
Get-FileHash .\cognatlas-0.1.1-win32-x64.zip -Algorithm SHA256
~~~

## 已知限制

- exe 未签名；无自动更新；macOS/ARM 未构建。
- 插件默认信任；令牌不是操作系统级安全边界。
- Windows 仅在 Wine 11.22 下完成主要路径验证，未在真实 Windows 长期验证。

## 许可证

Apache-2.0。第三方组件、GPL-2.0 源码提供声明见 THIRD_PARTY_NOTICES.md。
