# Cognatlas 0.1.0 — 2026-11-26

Cognatlas 首个可发布预览。

## 下载

- Linux x64：cognatlas-0.1.0-linux-x64.tar.gz
- Windows x64（预览）：cognatlas-0.1.0-win32-x64.zip
- 校验：SHA256SUMS

Windows 包约 162 MB，超过 GitHub 单文件 100 MiB 限制，因此只作为 Release
asset，不提交进源码历史。

## 安装

Linux：

~~~bash
tar -xzf cognatlas-0.1.0-linux-x64.tar.gz
./cognatlas-linux-x64/cognatlas
~~~

需要系统 Git 与 Python 3，以及一个已有 .okf/okf_commit.py 的 OKF 知识库。

Windows：

1. 解压 cognatlas-0.1.0-win32-x64.zip。
2. 双击 cognatlas.exe。
3. SmartScreen 提示未知发布者时选择「更多信息 → 仍要运行」。

Windows 包随带 Python 3.12.8 与 MinGit 2.56.1，不需要另装。

## 校验

~~~bash
sha256sum -c SHA256SUMS
~~~

Windows 可用 PowerShell：

~~~powershell
Get-FileHash .\cognatlas-0.1.0-win32-x64.zip -Algorithm SHA256
~~~

## 已知限制

- exe 未签名；无自动更新；macOS/ARM 未构建。
- 空目录不是建库器：没有 .okf 时只能编辑，不能提交/health/插件。
- 插件默认信任；令牌不是操作系统级安全边界。
- Windows 仅在 Wine 11.22 下完成主要路径验证，未在真实 Windows 长期验证。

## 许可证

Apache-2.0。第三方组件、GPL-2.0 源码提供声明见 THIRD_PARTY_NOTICES.md。
