#!/usr/bin/env bash
# Install FineNet Auth on this machine (Linux / macOS).
# macOS: use --service to install LaunchAgent (login auto-start).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OS="$(uname -s)"
LABEL="cn.finedo.finenet-auth"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "需要 Node.js >= 18。" >&2
    if [[ "$OS" == "Darwin" ]]; then
      echo "可用 Homebrew 安装: brew install node" >&2
    else
      echo "请安装: https://nodejs.org/" >&2
    fi
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

  local bindir="${FINENET_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bindir"
  ln -sfn "$target" "$bindir/finenet-auth"
  echo "命令已安装: $bindir/finenet-auth"

  case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
      local rc=""
      if [[ "$OS" == "Darwin" ]]; then
        rc="$HOME/.zshrc"
      else
        rc="$HOME/.bashrc"
      fi
      if [[ -f "$rc" ]] && ! grep -q '.local/bin' "$rc" 2>/dev/null; then
        echo '' >>"$rc"
        echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$rc"
        echo "已写入 PATH 到 $rc"
      else
        echo "请确保 PATH 包含: $bindir"
      fi
      export PATH="$bindir:$PATH"
      ;;
  esac
}

install_macos_launchagent() {
  local node_bin data_dir log_dir
  node_bin="$(command -v node)"
  data_dir="${FINENET_DATA_DIR:-$HOME/.finenet-auth}"
  log_dir="$data_dir/logs"
  mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"

  # Unload existing if present
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true

  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${ROOT}/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>3927</string>
    <key>FINENET_DATA_DIR</key>
    <string>${data_dir}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${log_dir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/stderr.log</string>
</dict>
</plist>
EOF

  # macOS Ventura+ prefers bootstrap; fall back to load
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
    launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else
    launchctl load -w "$PLIST_PATH"
  fi

  echo "==> macOS 开机/登录自启已启用"
  echo "    plist: $PLIST_PATH"
  echo "    日志:  $log_dir/"
  echo "    状态:  launchctl print gui/\$(id -u)/$LABEL | head"
  echo "    UI:    http://127.0.0.1:3927"
}

install_linux_systemd() {
  local unit_dir unit node_bin
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  unit="$unit_dir/finenet-auth.service"
  node_bin="$(command -v node)"
  cat >"$unit" <<EOF
[Unit]
Description=Finedo FineNet Auth (网络授权)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$node_bin $ROOT/src/index.js
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
OPEN_BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --service|--autostart) INSTALL_SERVICE=1 ;;
    --no-start) START_NOW=0 ;;
    --open) OPEN_BROWSER=1 ;;
  esac
done

# On macOS, --service implies we manage lifecycle via LaunchAgent
if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  if [[ "$OS" == "Darwin" ]]; then
    install_macos_launchagent
    START_NOW=0
    OPEN_BROWSER=1
  elif command -v systemctl >/dev/null 2>&1; then
    install_linux_systemd
    START_NOW=0
  else
    echo "当前系统无法配置自启，请手动运行: finenet-auth" >&2
  fi
fi

echo ""
echo "部署完成。"
echo "  启动 UI:   finenet-auth"
echo "  打开:      http://127.0.0.1:3927"
echo "  探测:      finenet-auth status"
if [[ "$OS" == "Darwin" ]]; then
  echo "  自启:      bash scripts/install-local.sh --service --no-start"
fi
echo ""

if [[ "$OPEN_BROWSER" -eq 1 && "$OS" == "Darwin" ]]; then
  sleep 1
  open "http://127.0.0.1:3927" 2>/dev/null || true
fi

if [[ "$START_NOW" -eq 1 ]]; then
  echo "==> 启动本地服务 (Ctrl+C 退出)"
  exec "${FINENET_BIN_DIR:-$HOME/.local/bin}/finenet-auth"
fi
