import { lookup } from "node:dns/promises";
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

async function probeOne(url, { timeoutMs = DEFAULTS.probeTimeoutMs, machineId } = {}) {
  const started = Date.now();
  const u = new URL(url);
  if (u.pathname.endsWith("spacheck.json")) {
    u.searchParams.set("_s", "desktop");
    u.searchParams.set("_t", machineId || getMachineId());
  }

  let dns = null;
  try {
    const r = await lookup(u.hostname, { all: false });
    dns = r.address;
  } catch (err) {
    dns = null;
    return {
      url: u.toString(),
      host: u.hostname,
      dns,
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      hint: "DNS 失败",
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      signal: ctrl.signal,
      redirect: "manual",
      headers: { Accept: "*/*", "Cache-Control": "no-cache" },
    });
    const status = res.status;
    let hint = null;
    if (status === 403) {
      hint =
        dns === "127.0.0.1" || dns === "::1"
          ? "解析到本机 — 本地 SDP 重定向，SPA 未打通时常返回 403"
          : "HTTP 403 — 常见于 SPA 未放行（网关拒访），或 Git 服务层拒绝未登录访问";
    } else if (status === 200 || (status >= 300 && status < 400)) {
      hint = "可达";
    } else if (status === 401) {
      hint = "可达但需登录";
    }
    return {
      url: u.toString(),
      host: u.hostname,
      dns,
      httpStatus: status,
      ok: status >= 200 && status < 400,
      latencyMs: Date.now() - started,
      error: null,
      hint,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url: u.toString(),
      host: u.hostname,
      dns,
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: message.includes("abort") ? "timeout / connection reset" : message,
      hint: "连接失败 — SPA 默认拒绝时常表现为超时/重置（比 403 更“隐形”）",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Multi-host diagnose: spacheck + app + git.
 * Helps explain "spacheck 已授权但 git 403" / "全程 403" cases.
 */
export async function diagnoseHosts({
  machineId,
  timeoutMs = DEFAULTS.probeTimeoutMs,
  hostChecks = DEFAULTS.hostChecks,
} = {}) {
  const mid = machineId || getMachineId();
  const hosts = [];
  for (const item of hostChecks) {
    const result = await probeOne(item.url, { timeoutMs, machineId: mid });
    hosts.push({ name: item.name, ...result });
  }

  const spa = hosts.find((h) => h.name === "spacheck");
  const git = hosts.find((h) => h.name === "git");
  const authorized = spa?.httpStatus === 200;

  const advice = [];
  if (!authorized) {
    advice.push("spacheck.json 不是 200 → 本机公网 IP 尚未进入 SPA 白名单。");
    advice.push("请完成：申请密钥 → 企业微信粘贴公钥 → 请求授权，并确认 UDP 30982 未被拦截。");
    if (git?.httpStatus === 403) {
      advice.push(
        "git.finedo.cn 返回 403 不等于已授权：不少网关在未敲门时直接回 403（而不是超时）。"
      );
    }
  } else if (git && git.httpStatus === 403) {
    advice.push("SPA 探测已通过，但 git 仍 403：可能是分服务白名单，或 Git 需要登录会话。");
    advice.push("尝试再点一次「请求授权」/ `finenet-auth authorize`，等待数秒后重试 git。");
    advice.push("浏览器无登录态访问 git；用 git clone 时确认账号权限。");
  } else if (authorized) {
    advice.push("SPA 已放行。若个别页面仍异常，多半是应用层权限，而非网络授权。");
  }

  return {
    authorized,
    status: authorized ? "已授权" : "未授权",
    checkedAt: Date.now(),
    machineId: mid,
    hosts,
    advice,
  };
}
