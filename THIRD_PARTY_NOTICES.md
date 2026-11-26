# 第三方软件与许可证

Cognatlas 自身代码采用 Apache License 2.0（见 LICENSE）。本文件列出随发布物
分发的第三方组件。开发依赖（esbuild、@electron/asar 等）不随二进制分发，
不在本表逐项列出。

## 组件清单

| 组件 | 版本 | 许可证 | 分发形式 | 源码 / 许可证 |
|---|---|---|---|---|
| Electron | 33.4.11 | MIT；Chromium 及其他组件见 LICENSES.chromium.html | Linux 运行时、Windows 运行时 | https://github.com/electron/electron |
| Chromium（Electron 内嵌） | Electron 33 对应版本 | BSD-3-Clause 等；完整清单见 LICENSES.chromium.html | 随 Electron 运行时 | https://www.chromium.org/ |
| CodeMirror 6（@codemirror/*、@lezer/*） | 6.x（以 package-lock.json 为准） | MIT | 已打包进 app/bundle.js | https://github.com/codemirror/dev |
| Remix Icon | 图标路径内嵌（无独立运行时） | Apache-2.0 | app/icons.js 中的 path 数据 | https://remixicon.com |
| PyYAML | 6.0.3 | MIT | Windows 包 resources/runtime/python/Lib/site-packages/yaml | https://github.com/yaml/pyyaml |
| Python | 3.12.8（embeddable） | PSF-2.0 | Windows 包 resources/runtime/python | https://www.python.org/downloads/release/python-3128/ |
| MinGit / Git for Windows | 2.56.1 | GPL-2.0（含其自身第三方组件） | Windows 包 resources/runtime/git | https://github.com/git-for-windows/git |

## 许可证文本

发布包内 licenses/ 目录包含：

- Apache-2.0.txt
- MIT.txt
- GPL-2.0.txt
- Git-for-Windows-LICENSE.txt
- Python-LICENSE.txt
- PyYAML-LICENSE.txt
- Electron-LICENSE.txt
- CodeMirror-NOTICE.txt
- Remix-Icon-NOTICE.txt

Electron 运行时根目录另带 LICENSES.chromium.html（Chromium 及其他组件的完整
声明）。MinGit 运行时内另带 LICENSE.txt 与 usr/share/licenses/（其第三方组件）。
Python 运行时内另带 LICENSE.txt。

## GPL 源码提供声明（MinGit / Git for Windows）

Windows 发布包随带 MinGit 2.56.1，按 GNU General Public License version 2
（GPL-2.0）分发。对应源码可从以下地址获取：

- 发布页：https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1
- 源码仓库：https://github.com/git-for-windows/git

自该发布物分发之日起至少三年内，Cognatlas 维护者向任何第三方提供 MinGit
对应源码的完整机器可读副本；获取方式为上述公开源码地址。若你需要物理介质，
可通过本仓库的 Issue 联系维护者，费用不超过实际执行源码分发的成本。

该声明不改变 GPL-2.0 赋予你的权利；MinGit 的许可证全文见
licenses/Git-for-Windows-LICENSE.txt 与发布包内
resources/runtime/git/LICENSE.txt。

## 商标

Apache-2.0 不授予商标权。项目名称、图标与“Cognatlas”标识不得用于暗示
官方背书；第三方组件的名称与商标归各自所有者。
