#!/usr/bin/env bash
# One-shot Mac installer: clone/update repo, install, enable login autostart.
# Run this ON your Mac Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/IVMYM/finenet-auth/cursor/finenet-auth-miniapp-5029/scripts/install-mac.sh | bash
#
# or after clone:
#   bash scripts/install-mac.sh
set -euo pipefail

REPO_URL="${FINENET_REPO_URL:-https://github.com/IVMYM/finenet-auth.git}"
BRANCH="${FINENET_BRANCH:-cursor/finenet-auth-miniapp-5029}"
INSTALL_DIR="${FINENET_INSTALL_DIR:-$HOME/Applications/finenet-auth}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本仅用于 macOS。Linux 请用: bash scripts/install-local.sh --service" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> 安装 Node.js (Homebrew)"
    brew install node
  else
    echo "未找到 Node.js。请先安装: https://nodejs.org/ 或 brew install node" >&2
    exit 1
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  echo "未找到 git。请先安装 Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> 更新已有安装: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  echo "==> 克隆到 $INSTALL_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
bash scripts/install-local.sh --service --no-start --open

echo ""
echo "Mac 部署完成并已设置登录自启。"
echo "  目录: $INSTALL_DIR"
echo "  UI:   http://127.0.0.1:3927"
echo "  停用: bash $INSTALL_DIR/scripts/uninstall-local.sh"
