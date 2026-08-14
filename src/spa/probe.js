import { DEFAULTS } from "./config.js";
import { getMachineId } from "./machine.js";

/**
 * Reachability check — "已授权" means HTTP 200 from spacheck.json,
 * NOT a cryptographic verify of the knock reply.
 */
export async function probeAuthorization({
  probeUrl = DEFAULTS.probeUrl,
  machineId,
  timeoutMs = DEFAULTS.probeTimeoutMs,
} = {}) {
  const mid = machineId || getMachineId();
  const url = new URL(probeUrl);
  url.searchParams.set("_s", "desktop");
  url.searchParams.set("_t", mid);

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
      },
    });

    const authorized = res.status === 200;
    let bodyPreview = "";
    try {
      bodyPreview = (await res.text()).slice(0, 200);
    } catch {
      bodyPreview = "";
    }

    return {
      authorized,
      status: authorized ? "已授权" : "未授权",
      httpStatus: res.status,
      ok: res.ok,
      latencyMs: Date.now() - started,
      url: url.toString(),
      bodyPreview,
      error: null,
      checkedAt: Date.now(),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    return {
      authorized: false,
      status: "未授权",
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      url: url.toString(),
      bodyPreview: "",
      error: name === "AbortError" ? "probe timeout" : message,
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper that always returns Chinese status label. */
export async function checkStatus(opts) {
  const result = await probeAuthorization(opts);
  return {
    ...result,
    status: result.authorized ? "已授权" : "未授权",
  };
}
