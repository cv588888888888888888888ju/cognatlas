# Cognatlas

一个本地优先、可视化浏览的 AI 知识库桌面客户端：编辑自然、元数据自动补齐、保存即提交。
基于 Electron 33 + CodeMirror 6，面向单用户、单机；已有 OKF 知识库可直接打开，空目录会自动建库。
Cognatlas 由 cognition + atlas 组成：不是记东西的地方，而是把认知画成一张可看、可走的地图。

当前版本 **0.1.1（preview）**；变更见 [CHANGELOG.md](CHANGELOG.md)。Linux x64 为主要支持平台；Windows x64 为预览版，
已在 Wine 11.22 下完成启动、中文路径、保存提交、插件与健康检查验证。

## 功能

- CodeMirror 6 编辑器：Markdown 行内渲染、中文输入法、会话恢复。
- 保存时自动补 frontmatter，自动执行 fmt / lint / commit；失败不写盘。
- 属性面板：字段、tag、类型补全；条目历史与反链。
- 链接三态：悬浮预览、左键内置浏览器或跳转、中键新窗口。
- 全库检索：优先本机 kb-serve，不可达时本地索引兜底。
- 外链默认在线打开，自动快照与离线回退。
- 声明式插件与 trusted client 插件；插件代码在 sandbox iframe 中运行。
- 健康检查：读取知识库 .okf/health.yaml，支持自定义检查器。
- 内置中英文介绍文档；空目录首次打开会自动生成可提交、可做健康检查的 .okf 工具链。

## 安装

### Linux x64（主要支持）

发布包：cognatlas-0.1.1-linux-x64.tar.gz

~~~bash
tar -xzf cognatlas-0.1.1-linux-x64.tar.gz
./cognatlas-linux-x64/cognatlas
~~~

需要系统已安装 Git 与 Python 3（以及 Python 包 PyYAML）。首次启动选择空目录时，
客户端会自动生成 `.okf` 工具链并做首次提交；选择已有 OKF 知识库
（根目录下存在 `.okf/okf_commit.py`）则直接打开。也可以设置 `KB_ROOT`。

非空且没有 `.okf` 的目录不会被改写：仍可阅读和编辑，但保存会返回
`NO-OKF`，不能提交或跑健康检查。

### Windows x64（预览）

发布包：cognatlas-0.1.1-win32-x64.zip

1. 解压到任意目录（支持空格与中文路径）。
2. 双击 cognatlas.exe。
3. 首次启动选择一个空目录会自动建库；选择已有 OKF 知识库根目录则直接打开。

Windows 包已随带 Python 3.12.8 与 MinGit 2.56.1，不需要另装 Python 或 Git。
详见 [docs/WINDOWS.md](docs/WINDOWS.md)。

**未签名提示**：Windows exe 未做代码签名，SmartScreen 可能显示「未知发布者」。
选择「更多信息 → 仍要运行」。这是当前版本的已知边界，不是安装损坏。

### 从源码运行

需要 Node 22+、npm、Git、Python 3（仅 Linux 侧调用 .okf 工具时需要）。

~~~bash
npm ci
npm run build:renderer
KB_ROOT=/path/to/your/okf-vault npm start
~~~

改 app/renderer.js 后必须重新执行 npm run build:renderer。

## 快速开始

1. 启动后选择知识库文件夹；空目录会自动建库，客户端会记住路径。
2. 左侧树打开一篇文档，正文直接编辑。
3. 停手约 1.2 秒自动保存并提交；Ctrl+S 立即保存。
4. Ctrl+P 打开命令面板；Ctrl+Shift+F 全库检索；Ctrl+F 当前文档查找。
5. 保存失败时看状态栏错误码；LINT-REJECT 表示格式门禁拒绝，文件不会被改写。

## 数据与隐私

- 不收集遥测，不上传统计，不包含自动更新。
- 客户端只主动访问本机 127.0.0.1:18812 的 kb-serve；不可达时使用本地索引。
- 只有你主动打开外链时，才会访问对应网站；内置浏览器会保存快照到本地。
- 知识库内容、配置、令牌、快照与日志的位置见 [docs/PRIVACY.md](docs/PRIVACY.md)。
- 删除客户端不会删除你的知识库；知识库是普通文件夹，自行备份。

## 安全边界

- 这是单用户本地应用。令牌用于身份、审计与吊销，不是操作系统级安全边界；
  能读你用户目录的同机进程本来就能读知识库。
- 插件默认按 trusted 处理；client 插件在 sandbox iframe 中运行，但插件仍然是你
  主动装进知识库的代码。不要安装来源不明的插件。
- 外链在 webview 中打开，已禁用 preload、Node 集成与任意本地文件导航；
  但网页内容本身仍应按不可信内容对待。
- Windows exe 未签名；没有自动更新；发布包请从本项目 Release 获取并核对
  SHA256SUMS。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私密报告，不要在公开 issue 里贴利用细节。

## 支持范围

| 平台 | 状态 | 说明 |
|---|---|---|
| Linux x64 | 主要支持 | Fedora 44 实测；需要 Git + Python 3 |
| Windows x64 | 预览 | Wine 11.22 实测；未在真实 Windows 机器长期验证 |
| macOS | 不支持 | 未构建、未测试 |
| Linux ARM / Windows ARM | 不支持 | 未构建 |

**非目标**：多用户、云同步、移动端、macOS 客户端、WYSIWYG 编辑器、
插件市场、自动更新、替用户从零创建 OKF 工具链。完整边界见
[docs/PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md)。

## 测试

测试是集成测试，需要一个真实 OKF 知识库作为夹具：

~~~bash
export KB_ROOT=/path/to/test-vault
node test/kb-core.test.js tree
node test/kb-core.test.js all
~~~

未设置 KB_ROOT 时测试会明确失败，不会去猜你的知识库路径。
UI 测试还需要 X 显示与 Electron；细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目采用 **Apache License 2.0**，见 [LICENSE](LICENSE)。
保留的版权与归属声明见 [NOTICE](NOTICE)；第三方组件与 GPL 源码提供声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [licenses/](licenses/)。

Apache-2.0 不授予项目名称、图标或商标的使用权；不要用本项目名义暗示官方背书。