# FineNet Auth · Finedo 网络授权小程序

轻量 SPA / SDP 敲门客户端：向 `finedo.cn:30982` 发送 UDP 授权包，并通过 `https://app.finedo.cn/spacheck.json` 判断本机公网 IP 是否已在白名单（**已授权**）。

## 它做什么

| 步骤 | 行为 |
|------|------|
| **申请密钥** | UDP `{ machineid, user, devicetype, identification: "0" }`，运维经企业微信推送 RSA 公钥 |
| **请求授权** | 用公钥 RSA 加密 `{ usercode, username, timestamp }` 得到 `sign`，再敲门 |
| **探测** | `GET spacheck.json?_s=desktop&_t={machineId}` → HTTP 200 = 已授权 |
| **保活** | `identification: "1"` 约每 10 分钟静默续期；`"2"` 约每 21 分钟轮换公钥 |

> 已授权 ≠ 登录令牌。UDP 为 fire-and-forget；UI 只根据 `spacheck.json` 可达性判定。

## 本地部署

前置：本机已装 **Node.js ≥ 18**（Mac 可用 `brew install node`）。

### Mac（安装 + 登录自启）

云端无法直接写入你的 Mac，请在 **本机 Terminal** 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/IVMYM/finenet-auth/cursor/finenet-auth-miniapp-5029/scripts/install-mac.sh | bash
```

效果：
- 安装到 `~/Applications/finenet-auth`
- 注册 LaunchAgent（登录自动启动）
- 打开 `http://127.0.0.1:3927`

自启文件：`~/Library/LaunchAgents/cn.finedo.finenet-auth.plist`  
卸载：`bash ~/Applications/finenet-auth/scripts/uninstall-local.sh`

### 通用（Linux / macOS）

```bash
git clone https://github.com/IVMYM/finenet-auth.git
cd finenet-auth
git checkout cursor/finenet-auth-miniapp-5029
bash scripts/install-local.sh --service
```

```bash
npm run install:local     # 只安装命令
finenet-auth              # 手动启动 UI
finenet-auth status
npm run uninstall:local   # 卸载命令与自启
```

Windows（PowerShell）：`npm install && npm start` → `http://127.0.0.1:3927`

CLI：

```bash
finenet-auth set-profile --user 10086 --name 张三
finenet-auth set-key --key "$(cat wecom.pem)"
finenet-auth apply && finenet-auth authorize && finenet-auth status
```

本地数据：`~/.finenet-auth/keys.json`。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` / `HOST` | UI 监听地址，默认 `127.0.0.1:3927` |
| `FINENET_DATA_DIR` | 覆盖密钥存储目录 |
| `FINENET_SKIP_DNS_FIX=1` | 关闭申请/授权时自动改 Wi‑Fi DNS（仅 macOS） |
| `FINENET_PUBLIC_DNS` | 公共 DNS，默认 `223.5.5.5,8.8.8.8` |
| `FINENET_WIFI_SERVICE` | 网络服务名，默认自动检测 `Wi-Fi` |

## 说明

- 申请密钥 / 请求授权时（macOS）会自动把 Wi‑Fi DNS 改为 `223.5.5.5` / `8.8.8.8`，避免 Clash fake-IP；可用 `finenet-auth dns-restore` 恢复。
- 防火墙放行的是**公网源 IP**，不是进程级 VPN。换 Wi‑Fi / 休眠超时后会回到未授权。
- 若 UDP `30982` 被酒店/家用 NAT 拦截，敲门无法到达。
- 本工具协议字段按 FinedoIT 终端「终端安全 → 网络授权」行为对齐；若网关字段有定制差异，可在 `src/spa/knock.js` 调整包体。

## 开发

```bash
npm test
npm run dev
```
