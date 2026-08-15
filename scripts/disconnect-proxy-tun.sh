#!/usr/bin/env bash
# Disconnect Shadowrocket / Karing TUN that hijacks DNS to 198.18.*
# 「直连」规则不会关掉 VPN 隧道；必须断开 VPN / Packet Tunnel。
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅用于 macOS" >&2
  exit 1
fi

echo "==> 当前 VPN"
scutil --nc list 2>/dev/null || true

disconnect_one() {
  local name="$1"
  if scutil --nc status "$name" 2>/dev/null | grep -qi 'Connected'; then
    echo "==> 断开 VPN: $name"
    scutil --nc stop "$name" || true
  else
    echo "==> $name 未连接（跳过）"
  fi
}

# Common Chinese Mac clients that install as VPN services
disconnect_one "Shadowrocket"
disconnect_one "Karing"
disconnect_one "Clash"
disconnect_one "ClashX"
disconnect_one "Clash Verge"
disconnect_one "Surge"

# Best-effort: stop packet tunnel helpers (app may still stay in menu bar)
pkill -f 'MacPacketTunnel' 2>/dev/null || true

sleep 1
echo ""
echo "==> DNS 对比"
echo -n "system git: "; dig +short git.finedo.cn | head -1
echo -n "public git: "; dig @223.5.5.5 +short git.finedo.cn | head -1
echo ""
scutil --dns 2>/dev/null | head -20

echo ""
if dig +short git.finedo.cn | grep -q '^198\.1[89]\.'; then
  echo "仍是 198.18.*：请在小火箭里关掉连接开关，或 系统设置→VPN 断开 Shadowrocket；必要时 Quit 应用。"
  exit 1
fi

echo "DNS 已正常。可测:"
echo "  curl -sI https://app.finedo.cn/spacheck.json"
echo "  curl -sI https://git.finedo.cn/"
echo "若 spacheck=200 而 git 仍 nginx 403 → 找运维确认 SPA 是否放行 git/harbor（不是 hosts/堡垒问题）。"
