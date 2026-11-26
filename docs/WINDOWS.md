# Cognatlas Windows 版（x64）

## 安装

1. 解压 `cognatlas-0.1.0-win32-x64.zip` 到任意目录（支持空格与中文路径，例如 `D:\工具\Cognatlas`）。
2. 双击 `cognatlas.exe`。
3. 首次启动会显示内置介绍文档与「还没有选择知识库文件夹」。点按钮选择已有的 OKF 知识库根目录；选空目录只会 `git init`，**不会生成 .okf 工具链**，不能提交/健康检查/加载插件。

**不需要预装 Python 或 Git**：`resources\runtime\python` 是 Python 3.12.8 embeddable（含纯 Python PyYAML 6.0.3），`resources\runtime\git` 是 MinGit 2.56.1。

## 启动参数与调试

- 正常使用：直接双击，或 `cognatlas.exe --user-data-dir=D:\kb-data` 指定数据目录。
- 指定知识库：设置环境变量 `KB_ROOT=D:\我的知识库` 再启动。
- 无头自检（开发用）：`cognatlas.exe --headless --disable-gpu --no-sandbox`，配合 `KB_EVAL` / `KB_SHOT`，输出 `EVAL_RESULT {...}`。
- 单实例：重复启动只会把已有窗口拉到前面。

## 数据位置

| 内容 | 位置 |
|---|---|
| 配置（kb_root / identity / 插件开关） | `%APPDATA%\cognatlas\config.json` |
| 客户端令牌（0600 语义） | `%USERPROFILE%\.config\cognatlas\token` |
| 令牌库（只存 sha256） | `%USERPROFILE%\.local\share\kb-service\tokens.json` |
| 窗口状态 / 会话 | `%APPDATA%\cognatlas\` 与 localStorage |

提交作者默认 `human:user`；状态栏显示每篇最后一次提交的作者与日期。

## 检索

客户端优先请求本机 `http://127.0.0.1:18812` 的 kb-serve；没有启动或不可达时自动退回本地索引（结果带 `local-fallback`），不需要额外安装。

## 插件

- 声明式插件：知识库 `.okf\plugins\<name>\plugin.json`，当前支持 `video` / `custom` 围栏。
- 带 `client.js` 的插件在渲染进程的 sandbox iframe 里执行，通过父窗口代理 `ui` / `webview` / `commands` 能力；插件拿不到 `window.kb`、Node 或 ipcRenderer。
- 清单里 `trusted: false` 的插件默认不加载；`config.json` 的 `plugins.client_enabled=false` 或环境变量 `KB_NO_PLUGIN_CLIENT=1` 可全局关闭 client 插件。

## 健康检查

健康阈值在知识库 `.okf\health.yaml`。命令行（在解压目录执行）：

```bat
set APP=D:\工具\Cognatlas
set PATH=%APP%\resources\runtime\git\cmd;%APP%\resources\runtime\python;%PATH%
cd /d D:\我的知识库
"%APP%\resources\runtime\python\python.exe" .okf\okf_commit.py health --json
```

## 通过 Wine 验证（Linux 维护者）

- 便携 Wine 11.22；Windows 版实测可在 Wine 下启动、打开中文库、保存提交、加载插件。
- 需要 X 显示；无头环境用 agentdesk/Xvfb，启动参数 `--headless --disable-gpu --no-sandbox`。
- Wine prefix 必须放在用户可写目录（Wine 拒绝直接在 `/tmp` 下创建 prefix）。
- Wine 日志里的 `MESA-EGL ... DRI3` 警告是虚拟显示没有 GPU，可忽略。

## 已知限制

- 未做代码签名：SmartScreen 可能提示「未知发布者」，选择「更多信息 → 仍要运行」。
- 不做自动更新；升级请解压新版本覆盖（用户数据在 `%APPDATA%`，不会丢）。
- 未打包 Windows 服务；kb-serve / MCP 需手动用随包 Python 启动，或继续用 Linux 服务。
- Windows 下 `okf` 直接走随包 `python.exe .okf\okf_commit.py`，不依赖 `okf.cmd`；提交作者、检查器与 Linux 版一致。
## 许可证

本包采用 Apache License 2.0。安装目录下包含 LICENSE、NOTICE、
THIRD_PARTY_NOTICES.md 与 licenses/；第三方组件（含 MinGit 的 GPL-2.0）
与源码提供声明见 THIRD_PARTY_NOTICES.md。
