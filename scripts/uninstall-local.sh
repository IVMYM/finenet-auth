#!/usr/bin/env bash
# Uninstall local FineNet Auth link / autostart (Linux systemd or macOS LaunchAgent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OS="$(uname -s)"
LABEL="cn.finedo.finenet-auth"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ "$OS" == "Darwin" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "已移除 macOS LaunchAgent: $LABEL"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now finenet-auth.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/finenet-auth.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

npm unlink -g finenet-auth 2>/dev/null || true
rm -f "${FINENET_BIN_DIR:-$HOME/.local/bin}/finenet-auth"

echo "已移除命令与自启。数据目录保留: ${FINENET_DATA_DIR:-$HOME/.finenet-auth}"
echo "如需删除密钥: rm -rf ~/.finenet-auth"
