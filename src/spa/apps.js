import { lookup } from "node:dns/promises";
import { COMPANY_APPS, APP_CATALOG_URLS } from "./apps-catalog.js";
import { isFakeIp, isLoopbackIp } from "./probe.js";
import { DEFAULTS } from "./config.js";

async function resolveHost(hostname) {
  try {
    const r = await lookup(hostname, { all: false });
    return r.address;
  } catch {
    return null;
  }
}

async function headUrl(url, timeoutMs) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "manual",
      headers: { Accept: "*/*", "Cache-Control": "no-cache" },
    });
    return {
      httpStatus: res.status,
      ok: res.status >= 200 && res.status < 400,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function verdict({ dns, httpStatus, ok }) {
  if (isFakeIp(dns)) return { reachable: false, label: "假IP/代理劫持", tone: "bad" };
  if (isLoopbackIp(dns)) return { reachable: false, label: "本地SDP占位", tone: "warn" };
  if (!dns) return { reachable: false, label: "无DNS", tone: "bad" };
  if (httpStatus === 200) return { reachable: true, label: "可达", tone: "ok" };
  if (httpStatus >= 300 && httpStatus < 400) return { reachable: true, label: "可达(重定向)", tone: "ok" };
  if (httpStatus === 401 || httpStatus === 403) {
    // With real DNS: 401/403 often means TCP/TLS reached the edge (or app gate)
    return { reachable: true, label: `边缘可达 HTTP ${httpStatus}`, tone: "warn" };
  }
  if (!httpStatus) return { reachable: false, label: "连接失败", tone: "bad" };
  return { reachable: ok, label: `HTTP ${httpStatus}`, tone: ok ? "ok" : "warn" };
}

/**
 * Probe company apps that FinedoIT SPA typically fronts.
 */
export async function listCompanyApps({
  timeoutMs = DEFAULTS.probeTimeoutMs,
  apps = COMPANY_APPS,
  fetchCatalog = true,
} = {}) {
  const results = [];
  for (const app of apps) {
    const host = new URL(app.url).hostname;
    const dns = await resolveHost(host);
    const http = await headUrl(app.url, timeoutMs);
    const v = verdict({ dns, ...http });
    results.push({
      ...app,
      host,
      dns,
      fakeIp: isFakeIp(dns),
      ...http,
      ...v,
    });
  }

  let catalog = null;
  if (fetchCatalog) {
    for (const url of APP_CATALOG_URLS) {
      const http = await headUrl(url, timeoutMs);
      if (http.httpStatus === 200) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: "application/json" },
          });
          const body = await res.json().catch(() => null);
          catalog = { url, httpStatus: res.status, body };
          break;
        } catch {
          catalog = { url, httpStatus: http.httpStatus, body: null };
        }
      }
    }
  }

  const spaOk = results.find((r) => r.id === "spacheck")?.httpStatus === 200;
  const advice = [];
  if (!spaOk) {
    advice.push("spacheck 未 200 → 先完成网络授权；下列「公司应用」此时的状态不可靠。");
  }
  if (results.some((r) => r.fakeIp)) {
    advice.push("存在 198.18.* fake-IP → 先退出 Clash TUN / DIRECT *.finedo.cn，再看应用是否真通。");
  }
  if (spaOk) {
    const down = results.filter((r) => r.id !== "spacheck" && !r.reachable);
    if (down.length) {
      advice.push(
        `已授权但仍不通: ${down.map((r) => r.id).join(", ")} — 可能分服务策略或需官方 FinedoIT 本地 SDP。`
      );
    }
  }

  return {
    checkedAt: Date.now(),
    spaAuthorized: Boolean(spaOk),
    apps: results,
    catalog,
    advice,
    note:
      "列表来自公开 DNS 指向同一 SPA VIP 的主机；官方客户端内「应用列表」可能由服务端下发，不一定完全一致。",
  };
}
