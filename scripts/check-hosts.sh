#!/usr/bin/env bash
# Quick SPA reachability matrix after DNS is fixed.
set -euo pipefail

echo "==> DNS"
for h in app.finedo.cn git.finedo.cn harbor.finedo.cn finedo.cn; do
  printf "%-18s %s\n" "$h" "$(dig +short "$h" | head -1)"
done

echo ""
echo "==> HTTP (看 status；SPA 未放行常见 403 / 超时 / reset)"
for u in \
  "https://app.finedo.cn/spacheck.json?_s=desktop&_t=cli" \
  "https://app.finedo.cn/" \
  "https://git.finedo.cn/" \
  "https://harbor.finedo.cn/"
do
  code="$(curl -sS -m 8 -o /tmp/finenet-h.out -w "%{http_code}" -I "$u" 2>/tmp/finenet-h.err || true)"
  err="$(tr '\n' ' ' </tmp/finenet-h.err 2>/dev/null | head -c 80)"
  printf "%-60s -> %s %s\n" "$u" "${code:-000}" "$err"
  # show server / location if any
  egrep -i '^(HTTP/|server:|location:|www-authenticate:)' /tmp/finenet-h.out 2>/dev/null | head -5 || true
  echo
done

echo "判读:"
echo "  spacheck=200           → 网络授权成功（白名单已开）"
echo "  spacheck≠200 且 git/harbor=403 → 仍未授权（网关拒访）"
echo "  spacheck=200 且 git/harbor=403 → 分服务策略或需登录；看是否有登录页/302"
echo "  下一步: finenet-auth authorize && sleep 3 && finenet-auth diagnose"
