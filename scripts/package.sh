#!/usr/bin/env bash
# 打包 cognatlas 为 Linux x64 可分发包
# 产物：dist/cognatlas-linux-x64/（Electron 运行时 + resources/app.asar）
#       dist/cognatlas-<ver>-linux-x64.tar.gz
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="$ROOT/dist"
NAME=cognatlas
VER=$(node -p "require('$ROOT/package.json').version")
OUT="$DIST/${NAME}-linux-x64"
PACK="$DIST/.pack"
CLEAN=/usr/bin/rm

[ -x "$ROOT/node_modules/electron/dist/electron" ] || { echo "缺少 node_modules/electron/dist，先 npm install" >&2; exit 1; }

$CLEAN -rf "$PACK" "$OUT"
mkdir -p "$PACK" "$OUT/resources"

# asar 只装运行时需要的文件（依赖已 bundle 到 app/bundle.js）
mkdir -p "$PACK/app" "$PACK/core" "$PACK/lib"
cp -a "$ROOT"/app/. "$PACK/app/"
$CLEAN -rf "$PACK/app/node_modules" "$PACK/app/bundle.js.map" 2>/dev/null || true
cp -a "$ROOT"/core/. "$PACK/core/"
cp -a "$ROOT"/lib/. "$PACK/lib/"
cat > "$PACK/package.json" <<JSON
{
  "name": "cognatlas",
  "version": "${VER}",
  "main": "app/main.js",
  "private": true
}
JSON

npx --yes @electron/asar pack "$PACK" "$OUT/resources/app.asar" >/dev/null
# python 脚本不能在 asar 虚拟路径里执行 → 外置到 app.asar.unpacked
mkdir -p "$OUT/resources/app.asar.unpacked/core"
cp "$PACK/core/fm.py" "$OUT/resources/app.asar.unpacked/core/fm.py"

# Electron 运行时
cp -a "$ROOT"/node_modules/electron/dist/. "$OUT"/
mv "$OUT/electron" "$OUT/$NAME"
chmod +x "$OUT/$NAME"

# 随包文档、许可证与脚本
cp -a "$ROOT"/docs "$OUT/docs" 2>/dev/null || true
for f in LICENSE NOTICE THIRD_PARTY_NOTICES.md README.md CHANGELOG.md RELEASE_NOTES.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$OUT/$f"
done
[ -d "$ROOT/licenses" ] && cp -a "$ROOT/licenses" "$OUT/licenses"
cp -a "$ROOT"/scripts/install.sh "$OUT/install.sh" 2>/dev/null || true
cp -a "$ROOT"/scripts/install-kb-mcp.sh "$OUT/install-kb-mcp.sh" 2>/dev/null || true
cp -a "$ROOT"/scripts/kb-serve.py "$OUT/kb-serve.py" 2>/dev/null || true

tar -C "$DIST" -czf "$DIST/${NAME}-${VER}-linux-x64.tar.gz" "$NAME-linux-x64"
$CLEAN -rf "$PACK"
echo "OK $OUT"
echo "OK $DIST/${NAME}-${VER}-linux-x64.tar.gz"