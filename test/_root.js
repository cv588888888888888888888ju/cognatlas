'use strict';
/**
 * 集成测试的知识库入口。测试需要真实 OKF 库作为夹具，不猜开发者路径。
 * 用法：KB_ROOT=/path/to/okf-vault node test/xxx.test.js
 */
const fs = require('node:fs');
const path = require('node:path');

const raw = process.env.KB_ROOT;
if (!raw) {
  console.error('[test] KB_ROOT 未设置。请指向一个已有 .okf/okf_commit.py 的 OKF 知识库。');
  process.exit(2);
}
const root = path.resolve(raw);
if (!fs.existsSync(path.join(root, '.okf', 'okf_commit.py'))) {
  console.error('[test] KB_ROOT 不是 OKF 库（缺 .okf/okf_commit.py）：' + root);
  process.exit(2);
}
module.exports = root;
