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

前置：本机已装 **Node.js ≥ 18**。

```bash
git clone https://github.com/IVMYM/finenet-auth.git
cd finenet-auth
# 若用本 PR 分支：
# git checkout cursor/finenet-auth-miniapp-5029

bash scripts/install-local.sh
# 浏览器打开 http://127.0.0.1:3927
```

只安装、不立刻启动：

```bash
npm run install:local
finenet-auth          # 启动 UI
finenet-auth status   # 探测 已授权/未授权
```

Linux 开机自启（systemd 用户服务）：

```bash
npm run install:service
systemctl --user status finenet-auth
# 卸载：npm run uninstall:local
```

Windows（PowerShell）：

```powershell
git clone https://github.com/IVMYM/finenet-auth.git
cd finenet-auth
npm install
npm start
# 浏览器打开 http://127.0.0.1:3927
```

CLI：

```bash
finenet-auth set-profile --user 10086 --name 张三
finenet-auth set-key --key "$(cat wecom.pem)"
finenet-auth apply
finenet-auth authorize
finenet-auth status
```

本地数据：`~/.finenet-auth/keys.json`（按 userid 存公钥，对应原客户端 `tb_sqlite_cipher`）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` / `HOST` | UI 监听地址，默认 `127.0.0.1:3927` |
| `FINENET_DATA_DIR` | 覆盖密钥存储目录 |

## 说明

- 防火墙放行的是**公网源 IP**，不是进程级 VPN。换 Wi‑Fi / 休眠超时后会回到未授权。
- 若 UDP `30982` 被酒店/家用 NAT 拦截，敲门无法到达。
- 本工具协议字段按 FinedoIT 终端「终端安全 → 网络授权」行为对齐；若网关字段有定制差异，可在 `src/spa/knock.js` 调整包体。

## 开发

```bash
npm test
npm run dev
```
