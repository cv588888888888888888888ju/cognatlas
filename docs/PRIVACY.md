# 数据与隐私

Cognatlas 是本地优先应用。它不收集遥测、不上传统计、不做崩溃上报，
也没有自动更新检查。

## 客户端会访问哪里

| 目标 | 何时 | 说明 |
|---|---|---|
| 127.0.0.1:18812 | 检索时优先尝试 | 本机 kb-serve；不可达则本地索引兜底 |
| 你主动打开的外链 | 点击链接时 | 在内置 webview 或系统浏览器打开；可保存页面快照 |
| 本地知识库目录 | 启动、编辑、保存 | 读写 Markdown 与 .okf 工具 |
| 本机 Git / Python | 保存、健康检查 | 调用知识库自带的 .okf 工具 |

除上述之外，客户端不主动发起网络请求。插件若自行联网，属于插件行为；
安装前请阅读插件代码。

## 本地数据清单

Linux（XDG）：

| 内容 | 位置 |
|---|---|
| 配置（kb_root、identity、插件开关） | ~/.config/cognatlas/config.json |
| 窗口状态 | ~/.config/cognatlas/window-state.json |
| 条目 tag sidecar | ~/.config/cognatlas/entry-tags.json |
| 外链快照 | ~/.config/cognatlas/links/snapshots/ |
| 客户端令牌（明文，0600） | ~/.config/cognatlas/token |
| 令牌库（只存 sha256） | ~/.local/share/kb-service/tokens.json |
| 检索库 | ~/.local/share/kb-service/kb.db |
| 会话/界面状态 | ~/.config/cognatlas/Local Storage/ |

Windows：

| 内容 | 位置 |
|---|---|
| 配置、窗口状态、tag、快照 | %APPDATA%\cognatlas\ |
| 客户端令牌 | %USERPROFILE%\.config\cognatlas\token |
| 令牌库 | %USERPROFILE%\.local\share\kb-service\tokens.json |

知识库本身不在上述目录：它是你选择的普通文件夹，客户端不复制、不上传。
客户端不主动写运行日志文件；开发模式日志输出到终端或开发者工具。

## 删除数据

1. 关闭客户端。
2. 删除配置目录（Linux ~/.config/cognatlas；Windows %APPDATA%\cognatlas）。
3. 删除令牌库（Linux ~/.local/share/kb-service；Windows %USERPROFILE%\.local\share\kb-service）。
4. 如需删除检索库，一并删除 kb-service 下的 kb.db。
5. 知识库按你自己的备份策略处理；客户端不会替你删。

## 儿童与敏感数据

本项目不面向儿童，也不收集个人信息。知识库内容由用户自行负责；
不要在没有访问控制的共享账户上存放敏感资料。

## 变更

隐私边界如有变化，会在 CHANGELOG.md 记录。当前版本：0.1.0。
