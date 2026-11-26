#!/usr/bin/env bash
# KBC CLI 判据 A1–A3（沙箱库，不碰真库）
set -u
APP=$(cd "$(dirname "$0")/.." && pwd)
KB_REAL="${KB_ROOT:?set KB_ROOT to a reference OKF vault}"
SB=/tmp/kbc-cli-sandbox
KBIN="$APP/core/cli.js"
[ -n "${KB_ROOT_OVERRIDE:-}" ] && SB="$KB_ROOT_OVERRIDE"

/usr/bin/rm -rf "$SB"; mkdir -p "$SB"
( cd "$KB_REAL" && find . -name '*.md' -print0 | tar --null -T - -cf - ) | tar -xf - -C "$SB"
cp -a "$KB_REAL/.okf/." "$SB/.okf/"
( cd "$SB" && git init -q && git config core.quotepath false && git config user.name "kb cli test" && git config user.email "kb@localhost" && git add -A && git commit -qm "cli sandbox init" )
export KB_ROOT="$SB"
export XDG_CONFIG_HOME=/tmp/kbc-cli-cfg
export KB_TOKEN_DIR=/tmp/kbc-cli-store
/usr/bin/rm -rf /tmp/kbc-cli-cfg /tmp/kbc-cli-store
mkdir -p /tmp/kbc-cli-cfg /tmp/kbc-cli-store
export KB_TOKEN=$(node "$KBIN" token new --name clitest 2>/dev/null)
[ -n "$KB_TOKEN" ] || { echo "FAIL A0 无法签发测试令牌"; exit 1; }

fail=0
ok() { echo "PASS $1 $2"; }
bad() { echo "FAIL $1 $2"; fail=1; }

# A1 带 -m
echo "A1 行" >> "$SB/70-元知识/70.1-OKF规范要点.md"
node "$KBIN" commit -m "x" >/tmp/kbc-a1.log 2>&1
rc=$?
subj=$(cd "$SB" && git log -1 --format=%s)
[ "$rc" = 0 ] && [ "$subj" = "x" ] && ok A1 "rc=0 subject=$subj" || bad A1 "rc=$rc subject=$subj"

# A2 不带 -m：消息含被改文件主干名
echo "A2 行" >> "$SB/70-元知识/70.2-okf工具使用.md"
node "$KBIN" commit >/tmp/kbc-a2.log 2>&1
rc=$?
subj=$(cd "$SB" && git log -1 --format=%s)
case "$subj" in *70.2-okf工具使用*) ok A2 "subject=$subj";; *) bad A2 "rc=$rc subject=$subj";; esac

# A3 kb new
node "$KBIN" new "测试标题A3" --dir 70-元知识 >/tmp/kbc-a3.log 2>&1
rc=$?
f="$SB/70-元知识/测试标题A3.md"
grep -q '^type:' "$f" && grep -q '^title:' "$f" && grep -q 'by: "human:user"' "$f" && grep -q '^source_checked:' "$f" && grep -q 'at: "' "$f"
fm=$?
lint=1
( cd "$SB" && ./.okf/okf lint >/tmp/kbc-a3-lint.log 2>&1 ) && lint=0
[ "$rc" = 0 ] && [ "$fm" = 0 ] && [ "$lint" = 0 ] && ok A3 "rc=0 frontmatter=4字段 lint=0" || bad A3 "rc=$rc fm=$fm lint=$lint"

echo "RESULT $([ "$fail" = 0 ] && echo PASS || echo FAIL)"
exit "$fail"