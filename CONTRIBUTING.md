# 贡献

感谢你愿意改进 Cognatlas。这个项目是本地优先的 Electron 桌面客户端，
许可证为 Apache-2.0。

## 开发环境

- Node 22+ 与 npm。
- Git。
- Linux 侧需要 Python 3（调用知识库 .okf 工具）；Windows 发布包已随带运行时。
- 一个可写的 OKF 知识库作为集成测试夹具，路径通过 KB_ROOT 指定。

~~~bash
npm ci
npm run build:renderer
KB_ROOT=/path/to/okf-vault npm start
~~~

修改 app/renderer.js 后必须重新打包：

~~~bash
npm run build:renderer
~~~

## 测试

测试是集成测试，不会猜测你的知识库路径：

~~~bash
export KB_ROOT=/path/to/test-vault
node test/kb-core.test.js tree
node test/kb-core.test.js all
~~~

UI 测试还需要 X 显示与 Electron；无头环境用 agentdesk/Xvfb，并设置 DISPLAY。
未设置 KB_ROOT 时测试会以非 0 退出并提示，不会读取开发者本机路径。

## 提交约定

- 一个提交只做一件事；提交信息用中文或英文均可，写清动机。
- 不提交 node_modules、dist、日志、令牌、真实知识库内容或个人绝对路径。
- 新增配置键、IPC 通道、插件字段时，同步更新 docs/ARCHITECTURE.md。
- 新增第三方依赖时，同步更新 THIRD_PARTY_NOTICES.md 与 licenses/。
- 不引入来源不明的二进制；Windows 运行时只从官方 Release 获取并核对哈希。

## 许可证约定

提交即表示你有权按 Apache License 2.0 提交该贡献，并同意它随本项目以
Apache-2.0 分发。项目不使用 CLA；不要求版权转让。请保留第三方代码的
原始许可证与版权声明。

## 安全问题

不要用公开 PR 修安全漏洞；先按 SECURITY.md 私密报告。
