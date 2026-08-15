#!/usr/bin/env bash
# Fix residual Clash/Surge fake-IP DNS on macOS (198.18.0.0/15).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅用于 macOS" >&2
  exit 1
fi

echo "==> 当前系统解析（若仍是 198.18.* = DNS 仍被劫持）"
dig +short app.finedo.cn || true
dig +short www.baidu.com || true

echo ""
echo "==> 公共 DNS 解析（应是公网 IP）"
dig @223.5.5.5 +short app.finedo.cn || true
dig @8.8.8.8 +short app.finedo.cn || true

echo ""
echo "==> 查找仍在跑的代理相关进程"
ps aux | egrep -i 'clash|surge|mihomo|quantumult|v2ray|xray|sing-box' | grep -v egrep || echo "(未发现常见代理进程名)"

echo ""
echo "==> 当前 DNS 配置"
scutil --dns 2>/dev/null | head -n 40 || true
echo "---"
networksetup -listallnetworkservices 2>/dev/null | while read -r svc; do
  [[ "$svc" == *"An asterisk"* ]] && continue
  [[ -z "$svc" ]] && continue
  servers="$(networksetup -getdnsservers "$svc" 2>/dev/null || true)"
  echo "[$svc] DNS: $servers"
done

echo ""
echo "==> 尝试：把常用网卡 DNS 设为自动（需你确认网卡名，默认 Wi-Fi）"
IFACE="${1:-Wi-Fi}"
if networksetup -listallnetworkservices 2>/dev/null | grep -qx "$IFACE"; then
  echo "重置 $IFACE DNS → Empty (自动)"
  networksetup -setdnsservers "$IFACE" Empty
else
  echo "未找到服务「$IFACE」。可手动: networksetup -setdnsservers 'Wi-Fi' Empty"
  echo "或指定网卡: bash scripts/fix-mac-dns.sh 'USB 10/100/1000 LAN'"
fi

echo ""
echo "==> 刷新 DNS 缓存"
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder 2>/dev/null || true

echo ""
echo "==> 再次检测"
echo -n "system dig app.finedo.cn: "
dig +short app.finedo.cn | head -1
echo -n "public  dig app.finedo.cn: "
dig @223.5.5.5 +short app.finedo.cn | head -1

echo ""
echo "若 system dig 仍是 198.18.*（即使 Wi-Fi DNS 已是 223.5.5.5）："
echo "  → 这是 Clash/Surge TUN/增强模式劫持，改系统 DNS 无效"
echo "  1) 菜单栏完全 Quit Clash/Surge（不是只关 System Proxy）"
echo "  2) 关闭 TUN / 增强模式 / fake-IP"
echo "  3) 活动监视器结束残留进程；必要时重启 Mac"
echo "  4) Clash 规则: DOMAIN-SUFFIX,finedo.cn,DIRECT"
echo "     fake-ip-filter 加: +.finedo.cn"
echo "恢复正常后: dig +short git.finedo.cn 应等于 dig @223.5.5.5 +short git.finedo.cn"
