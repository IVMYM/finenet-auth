#!/usr/bin/env bash
# Install FineNet Auth on this machine (Linux / macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "需要 Node.js >= 18。请先安装: https://nodejs.org/" >&2
    exit 1
  fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" -lt 18 ]]; then
    echo "当前 Node $(node -v)，需要 >= 18" >&2
    exit 1
  fi
}

link_cli() {
  local target="$ROOT/bin/finenet-auth.js"
  chmod +x "$target"

  # Prefer user-writable ~/.local/bin (no sudo).
  local bindir="${FINENET_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bindir"
  ln -sfn "$target" "$bindir/finenet-auth"
  echo "命令已安装: $bindir/finenet-auth"

  case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
      echo ""
      echo "请把下面一行加入 ~/.bashrc 或 ~/.zshrc 后重新打开终端："
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      echo ""
      export PATH="$bindir:$PATH"
      ;;
  esac

  # Best-effort global npm link (may fail without write access).
  if npm link >/dev/null 2>&1; then
    echo "同时完成 npm link（全局可用）"
  fi
}

need_node

echo "==> 安装依赖"
npm install --omit=dev

echo "==> 安装本地命令 finenet-auth"
link_cli

DATA_DIR="${FINENET_DATA_DIR:-$HOME/.finenet-auth}"
mkdir -p "$DATA_DIR"
echo "密钥目录: $DATA_DIR"

INSTALL_SERVICE=0
START_NOW=1
for arg in "$@"; do
  case "$arg" in
    --service) INSTALL_SERVICE=1 ;;
    --no-start) START_NOW=0 ;;
  esac
done

if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ "$(uname -s)" == "Linux" ]]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT="$UNIT_DIR/finenet-auth.service"
    NODE_BIN="$(command -v node)"
    cat >"$UNIT" <<EOF
[Unit]
Description=Finedo FineNet Auth (网络授权)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/src/index.js
Restart=on-failure
RestartSec=3
Environment=HOST=127.0.0.1
Environment=PORT=3927
Environment=FINENET_DATA_DIR=$DATA_DIR

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now finenet-auth.service
    echo "==> 已启用用户服务: systemctl --user status finenet-auth"
    START_NOW=0
  else
    echo "当前环境不支持 systemd --user，跳过 --service" >&2
  fi
fi

echo ""
echo "部署完成。"
echo "  启动 UI:   finenet-auth"
echo "  或:        npm --prefix \"$ROOT\" start"
echo "  打开:      http://127.0.0.1:3927"
echo "  探测:      finenet-auth status"
echo ""

if [[ "$START_NOW" -eq 1 ]]; then
  echo "==> 启动本地服务 (Ctrl+C 退出)"
  exec "$HOME/.local/bin/finenet-auth"
fi
