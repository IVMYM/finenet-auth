#!/usr/bin/env bash
# Immediately stop FineNet Auth autostart / process (use when IP is blocked).
set -euo pipefail

OS="$(uname -s)"
LABEL="cn.finedo.finenet-auth"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "==> 停止 FineNet Auth，避免继续敲门触发封堵"

if [[ "$OS" == "Darwin" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  echo "已停用 LaunchAgent（若存在）: $LABEL"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop finenet-auth.service 2>/dev/null || true
  systemctl --user disable finenet-auth.service 2>/dev/null || true
fi

pkill -f "finenet-auth|src/index.js" 2>/dev/null || true
echo "已尝试结束本地进程。"
echo ""
echo "接下来："
echo "  1) 不要再运行 finenet-auth authorize / apply"
echo "  2) 联系运维解封：工号 + IP（企业微信通知里的地址）"
echo "  3) 解封且 DNS 正常后，再手动 authorize 一次即可"
