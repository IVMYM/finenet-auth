/**
 * Company apps typically reached after FinedoIT 网络授权 (SPA whitelist).
 * Discovered via public DNS → same VIP (120.210.159.62) as SPA entry.
 * Official FinedoIT may show a richer catalog from server; this is the
 * network-layer set we can verify without the closed-source client.
 */
export const COMPANY_APPS = [
  {
    id: "spacheck",
    name: "SPA 探测",
    url: "https://app.finedo.cn/spacheck.json",
    role: "auth-probe",
    note: "HTTP 200 = 网络授权成功",
  },
  {
    id: "app",
    name: "应用门户 app",
    url: "https://app.finedo.cn/",
    role: "portal",
    note: "Finedo 主站 / 业务入口",
  },
  {
    id: "www",
    name: "官网 www",
    url: "https://www.finedo.cn/",
    role: "portal",
  },
  {
    id: "git",
    name: "代码仓库 Git",
    url: "https://git.finedo.cn/",
    role: "dev",
    note: "需 SPA + 账号；DNS 不能是 198.18.*",
  },
  {
    id: "harbor",
    name: "镜像仓库 Harbor",
    url: "https://harbor.finedo.cn/",
    role: "dev",
  },
  {
    id: "k8s",
    name: "K8s / 容器平台",
    url: "https://k8s.finedo.cn/",
    role: "ops",
  },
  {
    id: "vpn",
    name: "VPN / 远程接入",
    url: "https://vpn.finedo.cn/",
    role: "network",
    note: "与 SPA 同 VIP；是否还需单独客户端以运维为准",
  },
];

/** Optional APIs that may return the official app catalog when authorized. */
export const APP_CATALOG_URLS = [
  "https://app.finedo.cn/spaservice/whitemng/returntime",
  "https://app.finedo.cn/spaservice/whitemng/applist",
  "https://app.finedo.cn/spaservice/app/list",
  "https://app.finedo.cn/spaservice/whitemng/getapps",
];
