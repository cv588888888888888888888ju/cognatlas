#!/usr/bin/env bash
# 安装 cognatlas 到用户目录
# 用法：install.sh [dist/cognatlas-linux-x64 或 .tar.gz]
# 只写用户级路径：~/.local/opt/cognatlas、~/.local/bin/cognatlas、~/.local/share/applications
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARG="${1:-$ROOT/dist/cognatlas-linux-x64}"
PREFIX="${PREFIX:-$HOME/.local/opt/cognatlas}"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
CLEAN=/usr/bin/rm

mkdir -p "$PREFIX" "$BIN" "$APPS"

case "$ARG" in
  *.tar.gz)
    TMP=$(mktemp -d)
    tar -xzf "$ARG" -C "$TMP"
    SRC=$(find "$TMP" -maxdepth 1 -type d -name 'cognatlas-*' | head -1)
    [ -n "$SRC" ] || { echo "压缩包里没有 cognatlas-* 目录" >&2; exit 1; }
    $CLEAN -rf "$PREFIX"
    mkdir -p "$PREFIX"
    cp -a "$SRC"/. "$PREFIX"/
    $CLEAN -rf "$TMP"
    ;;
  *)
    [ -x "$ARG/cognatlas" ] || { echo "找不到可执行文件：$ARG/cognatlas" >&2; exit 1; }
    $CLEAN -rf "$PREFIX"
    mkdir -p "$PREFIX"
    cp -a "$ARG"/. "$PREFIX"/
    ;;
esac

ln -sfn "$PREFIX/cognatlas" "$BIN/cognatlas"

cat > "$APPS/cognatlas.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Cognatlas
Comment=Cognatlas — 本地优先的 AI 知识库
Exec=$BIN/cognatlas %U
Terminal=false
Categories=Office;
StartupWMClass=cognatlas
DESKTOP
chmod +x "$BIN/cognatlas"

echo "installed: $PREFIX"
echo "launcher : $BIN/cognatlas"
echo "desktop  : $APPS/cognatlas.desktop"
