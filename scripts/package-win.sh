#!/usr/bin/env bash
# 打包 cognatlas 为 Windows x64 可分发包
# 产物：dist/cognatlas-win32-x64/（cognatlas.exe + resources/runtime/{python,git}）
#       dist/cognatlas-<ver>-win32-x64.zip
# 不依赖 Wine；目标机不需要预装 Python/Git。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="$ROOT/dist"
NAME=cognatlas
VER=$(node -p "require('$ROOT/package.json').version")
OUT="$DIST/${NAME}-win32-x64"
PACK="$DIST/.pack-win"
CACHE="${KB_WIN_CACHE:-$HOME/.cache/cognatlas-win}"
CLEAN=/usr/bin/rm

ELECTRON_VER=33.4.11
PY_VER=3.12.8
GIT_VER=2.56.1
ELECTRON_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip"
PY_URL="https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip"
GIT_URL="https://github.com/git-for-windows/git/releases/download/v${GIT_VER}.windows.1/MinGit-${GIT_VER}-64-bit.zip"

dl() {
  local url=$1 out=$2
  if [ -s "$out" ]; then echo "cached $(basename "$out")"; return; fi
  echo "download $(basename "$out")"
  curl -fL --retry 3 --connect-timeout 20 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

command -v unzip >/dev/null || { echo "需要 unzip" >&2; exit 1; }
command -v curl >/dev/null || { echo "需要 curl" >&2; exit 1; }
mkdir -p "$CACHE" "$DIST"
dl "$ELECTRON_URL" "$CACHE/electron-v${ELECTRON_VER}-win32-x64.zip"
dl "$PY_URL" "$CACHE/python-${PY_VER}-embed-amd64.zip"
dl "$GIT_URL" "$CACHE/MinGit-${GIT_VER}-64-bit.zip"

$CLEAN -rf "$PACK" "$OUT"
mkdir -p "$PACK" "$OUT/resources/runtime"

# 1) asar：app/core/lib（依赖已 bundle 到 app/bundle.js）
mkdir -p "$PACK/app" "$PACK/core" "$PACK/lib"
cp -a "$ROOT"/app/. "$PACK/app/"
$CLEAN -rf "$PACK/app/node_modules" "$PACK/app/bundle.js.map" 2>/dev/null || true
cp -a "$ROOT"/core/. "$PACK/core/"
cp -a "$ROOT"/lib/. "$PACK/lib/"
$CLEAN -rf "$PACK/core/__pycache__" 2>/dev/null || true
cat > "$PACK/package.json" <<JSON
{
  "name": "cognatlas",
  "version": "${VER}",
  "main": "app/main.js",
  "private": true
}
JSON
npx --yes @electron/asar pack "$PACK" "$OUT/resources/app.asar" >/dev/null
mkdir -p "$OUT/resources/app.asar.unpacked/core"
cp "$PACK/core/fm.py" "$OUT/resources/app.asar.unpacked/core/fm.py"

# 2) Electron Windows 壳
mkdir -p "$DIST/.electron-win"
$CLEAN -rf "$DIST/.electron-win"/*
unzip -q "$CACHE/electron-v${ELECTRON_VER}-win32-x64.zip" -d "$DIST/.electron-win"
cp -a "$DIST/.electron-win"/. "$OUT/"
mv "$OUT/electron.exe" "$OUT/${NAME}.exe"

# 3) Python embeddable（纯 Python PyYAML，不带任何 .so/.pyd 扩展）
mkdir -p "$OUT/resources/runtime/python"
unzip -q "$CACHE/python-${PY_VER}-embed-amd64.zip" -d "$OUT/resources/runtime/python"
YAML_SRC=$(python3 -c "import yaml,os;print(os.path.dirname(yaml.__file__))")
mkdir -p "$OUT/resources/runtime/python/Lib/site-packages/yaml"
find "$YAML_SRC" -maxdepth 1 -name '*.py' -exec cp {} "$OUT/resources/runtime/python/Lib/site-packages/yaml/" \;
PY_PTH="$OUT/resources/runtime/python/python312._pth"
grep -qx 'Lib\\site-packages' "$PY_PTH" 2>/dev/null || printf 'Lib\\site-packages\n' >> "$PY_PTH"
grep -qx 'import site' "$PY_PTH" || printf 'import site\n' >> "$PY_PTH"

# 4) MinGit
mkdir -p "$DIST/.mingit" "$OUT/resources/runtime/git"
$CLEAN -rf "$DIST/.mingit"/*
unzip -q "$CACHE/MinGit-${GIT_VER}-64-bit.zip" -d "$DIST/.mingit"
cp -a "$DIST/.mingit"/. "$OUT/resources/runtime/git/"
[ -f "$OUT/resources/runtime/git/cmd/git.exe" ] || { echo "MinGit 结构异常：缺 cmd/git.exe" >&2; exit 1; }

# 5) 随包文档、许可证与 MCP 安装脚本
cp -a "$ROOT"/docs "$OUT/docs" 2>/dev/null || true
for f in LICENSE NOTICE THIRD_PARTY_NOTICES.md README.md CHANGELOG.md RELEASE_NOTES.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$OUT/$f"
done
[ -d "$ROOT/licenses" ] && cp -a "$ROOT/licenses" "$OUT/licenses"
cp -a "$ROOT"/scripts/install-kb-mcp.sh "$OUT/install-kb-mcp.sh" 2>/dev/null || true
cp -a "$ROOT"/scripts/kb-serve.py "$OUT/kb-serve.py" 2>/dev/null || true

# 6) 自检
[ -f "$OUT/${NAME}.exe" ] || { echo "缺 ${NAME}.exe" >&2; exit 1; }
[ -f "$OUT/resources/app.asar" ] || { echo "缺 app.asar" >&2; exit 1; }
[ -f "$OUT/resources/app.asar.unpacked/core/fm.py" ] || { echo "缺 unpacked fm.py" >&2; exit 1; }
[ -f "$OUT/resources/runtime/python/python.exe" ] || { echo "缺 runtime python" >&2; exit 1; }
"$OUT/resources/runtime/python/python.exe" -c 'import yaml; print(yaml.__version__)' 2>/dev/null || echo "WARN: 本机不能直接跑 Windows python.exe（正常，交 Wine 验证）"

# 7) zip
ZIP="$DIST/${NAME}-${VER}-win32-x64.zip"
$CLEAN -f "$ZIP"
( cd "$DIST" && zip -qr "$ZIP" "${NAME}-win32-x64" )
$CLEAN -rf "$PACK" "$DIST/.electron-win" "$DIST/.mingit"
echo "OK $OUT"
echo "OK $ZIP"
ls -lh "$ZIP" | awk '{print $5, $9}'