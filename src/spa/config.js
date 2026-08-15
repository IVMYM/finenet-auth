import { homedir } from "node:os";
import { join } from "node:path";

/** Default SPA / SDP endpoints and timers (ms), matching FinedoIT tray 网络授权. */
export const DEFAULTS = {
  udpHost: "finedo.cn",
  udpPort: 30982,
  probeUrl: "https://app.finedo.cn/spacheck.json",
  returnTimeUrl: "https://app.finedo.cn/spaservice/whitemng/returntime",
  /** Extra host checks shown in diagnose / UI (403 often means SPA still closed). */
  hostChecks: [
    { name: "spacheck", url: "https://app.finedo.cn/spacheck.json", expect: 200 },
    { name: "app", url: "https://app.finedo.cn/", expectOk: true },
    { name: "git", url: "https://git.finedo.cn/", expectOk: true },
    { name: "harbor", url: "https://harbor.finedo.cn/", expectOk: true },
    { name: "k8s", url: "https://k8s.finedo.cn/", expectOk: true },
    { name: "vpn", url: "https://vpn.finedo.cn/", expectOk: true },
  ],
  /** UI-facing whitelist TTL (~20 min) */
  authValidMs: 1_200_000,
  /** Silent re-knock (~10 min) */
  knockIntervalMs: 597_000,
  /** Key rotation (~21 min) */
  publicKeyIntervalMs: 1_266_000,
  /** Offline back-off (probe only — do NOT UDP-knock while unauthorized) */
  offlineRetryMs: 60_000,
  offlineRetryMaxMs: 300_000,
  /** Min gap between manual/auto UDP knocks to avoid 异常上报封堵 */
  knockMinIntervalMs: 60_000,
  /** Max failed knocks before client refuses further UDP until cooldown */
  knockFailLimit: 5,
  knockCooldownMs: 30 * 60_000,
  /**
   * On macOS, automatically set Wi-Fi DNS to public resolvers
   * before 申请密钥 / 请求授权 (avoids Clash fake-IP 198.18/15).
   */
  autoFixWifiDns: process.env.FINENET_SKIP_DNS_FIX === "1" ? false : true,
  publicDns: (process.env.FINENET_PUBLIC_DNS || "223.5.5.5,8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Probe cadence while unauthorized */
  probeIntervalMs: 1_000,
  /** HTTP timeouts */
  probeTimeoutMs: 8_000,
  returnTimeTimeoutMs: 10_000,
  deviceType: "pc",
};

export function dataDir() {
  return process.env.FINENET_DATA_DIR || join(homedir(), ".finenet-auth");
}

export function storePath() {
  return join(dataDir(), "keys.json");
}

/**
 * Fetch optional timer overrides from spaservice.
 * Expected shape (best-effort): { knockInterval?, publicKeyInterval?, returntime? }
 */
export async function fetchReturnTime(base = DEFAULTS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), base.returnTimeTimeoutMs);
  try {
    const res = await fetch(base.returnTimeUrl, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ...base };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") return { ...base };

    const pick = (...keys) => {
      for (const k of keys) {
        const v = body[k] ?? body?.data?.[k];
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    };

    return {
      ...base,
      knockIntervalMs: pick("knockInterval", "knockinterval", "authInterval") ?? base.knockIntervalMs,
      publicKeyIntervalMs:
        pick("publicKeyInterval", "publickeyinterval", "keyInterval") ?? base.publicKeyIntervalMs,
      authValidMs: pick("returntime", "returnTime", "validTime", "whitelistTtl") ?? base.authValidMs,
    };
  } catch {
    return { ...base };
  } finally {
    clearTimeout(timer);
  }
}
