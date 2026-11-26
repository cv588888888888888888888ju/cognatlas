# 架构

本文给贡献者一个模块地图。它不是完整 API 文档；具体 IPC 参数以代码与
类型注释为准。

## 进程与数据流

~~~text
renderer (app/renderer.js → app/bundle.js)
  │  window.kb.*  (contextBridge, app/preload.js)
  ▼
main (app/main.js)
  │  KB class (core/kb-core.js)
  ├── git / .okf/okf_commit.py（保存、lint、commit、health）
  ├── core/fm.py（frontmatter 解析/生成）
  ├── lib/links-store.js（外链快照）
  ├── core/plugins.js（插件清单校验）
  └── HTTP 127.0.0.1:18812（kb-serve，检索；不可达时本地索引）
~~~

渲染进程不直接碰文件系统；所有读写都经 IPC 到主进程。主进程用
contextIsolation: true、nodeIntegration: false，preload 只暴露白名单方法。

## 模块

| 路径 | 职责 |
|---|---|
| app/main.js | 窗口、IPC、单实例、菜单/快捷键、webview 加固、无头截图 |
| app/preload.js | contextBridge 暴露 window.kb，不暴露 Node |
| app/renderer.js | 编辑器、文件树、属性面板、检索、插件 UI |
| app/bundle.js | esbuild 产物；改 renderer.js 后必须重建 |
| core/kb-core.js | 索引、树、补全、反链、保存、改名、检索、git/okf 调用 |
| core/cli.js | kb 命令行入口 |
| core/fm.py | frontmatter parse/build/canon（PyYAML） |
| core/identity.js | 令牌解析顺序与客户端首启签发 |
| core/token-store.js | 令牌库，只存 sha256，0600 |
| core/plugins.js | plugin.json 校验、围栏与能力白名单 |
| lib/links-store.js | 外链快照的保存、配额、清理 |
| docs/ | 产品边界、隐私、Windows 说明 |

## 安全不变量

- 所有相对路径先 normalize，再确认落在知识库根内；符号链接用 realpath 再查一次。
- webview 不继承 preload、不开 Node、不允许任意 file: 导航；只允许 http/https
  与快照目录内的 page.html。
- 插件 client 在 sandbox iframe 中运行，只能通过父窗口代理使用声明的 ui /
  webview / commands 能力。
- 令牌只用于身份与审计；不是 OS 级隔离。
- 外链内容按不可信输入处理；快照 HTML 经过清理后落盘。

## 构建与测试

~~~bash
npm ci
npm run build:renderer
KB_ROOT=/path/to/okf-vault npm start
KB_ROOT=/path/to/okf-vault node test/kb-core.test.js all
~~~

Windows 包由 scripts/package-win.sh 组装：Electron win32 x64 + Python
3.12.8 embeddable + MinGit 2.56.1，app.asar 外置 core/fm.py。

## 配置与数据

配置在 Electron userData：Linux ~/.config/cognatlas，Windows
%APPDATA%\cognatlas。令牌、快照、tag sidecar 的具体位置见 docs/PRIVACY.md。
