import { lookup, Resolver } from "node:dns/promises";
import { DEFAULTS } from "./config.js";
import { getMachineId } from "./machine.js";

/** Clash / Surge / QuantumultX fake-IP pool (RFC 2544 benchmark range). */
export function isFakeIp(addr) {
  if (!addr || typeof addr !== "string") return false;
  // 198.18.0.0 – 198.19.255.255
  return /^198\.1[89]\.\d+\.\d+$/.test(addr);
}

export function isLoopbackIp(addr) {
  return addr === "127.0.0.1" || addr === "::1" || Boolean(addr?.startsWith("127."));
}

/** Resolve via a public DNS (bypass local stub / fake-IP). */
export async function lookupPublic(hostname, servers = ["223.5.5.5", "8.8.8.8"]) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  try {
    const v4 = await resolver.resolve4(hostname);
    return { address: v4[0] || null, all: v4, error: null };
  } catch (err) {
    return {
      address: null,
      all: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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

function dnsHint(dns, { httpStatus, error, publicDns } = {}) {
  if (isFakeIp(dns)) {
    const pub = publicDns?.address;
    if (pub && !isFakeIp(pub)) {
      return `系统DNS=fake-IP(${dns})，公共DNS=${pub} → 代理已关但本机DNS仍被劫持`;
    }
    return "DNS=198.18.x.x → Clash/Surge fake-IP，流量被本地代理劫持，不是真实 SPA 地址";
  }
  if (isLoopbackIp(dns)) {
    return "解析到本机 — 本地 SDP 重定向，SPA 未打通时常失败/403";
  }
  if (httpStatus === 403) {
    return "HTTP 403 — 常见于 SPA 未放行（网关拒访），或 Git 服务层拒绝未登录访问";
  }
  if (httpStatus === 200 || (httpStatus >= 300 && httpStatus < 400)) return "可达";
  if (httpStatus === 401) return "可达但需登录";
  if (error) return "连接失败 — SPA 默认拒绝时常表现为超时/重置（比 403 更“隐形”）";
  return null;
}

async function probeOne(url, { timeoutMs = DEFAULTS.probeTimeoutMs, machineId } = {}) {
  const started = Date.now();
  const u = new URL(url);
  if (u.pathname.endsWith("spacheck.json")) {
    u.searchParams.set("_s", "desktop");
    u.searchParams.set("_t", machineId || getMachineId());
  }

  let dns = null;
  let publicDns = null;
  try {
    const r = await lookup(u.hostname, { all: false });
    dns = r.address;
  } catch (err) {
    publicDns = await lookupPublic(u.hostname);
    return {
      url: u.toString(),
      host: u.hostname,
      dns: null,
      publicDns: publicDns.address,
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      hint: "DNS 失败",
      fakeIp: false,
    };
  }

  publicDns = await lookupPublic(u.hostname);

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
    return {
      url: u.toString(),
      host: u.hostname,
      dns,
      publicDns: publicDns.address,
      httpStatus: status,
      ok: status >= 200 && status < 400,
      latencyMs: Date.now() - started,
      error: null,
      hint: dnsHint(dns, { httpStatus: status, publicDns }),
      fakeIp: isFakeIp(dns),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url: u.toString(),
      host: u.hostname,
      dns,
      publicDns: publicDns.address,
      httpStatus: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: message.includes("abort") ? "timeout / connection reset" : message,
      hint: dnsHint(dns, { error: message, publicDns }),
      fakeIp: isFakeIp(dns),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Multi-host diagnose: spacheck + app + git.
 * Helps explain fake-IP / residual DNS hijack / 403 / SPA-closed cases.
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
  const harbor = hosts.find((h) => h.name === "harbor");
  const authorized = spa?.httpStatus === 200;
  const fakeIpHit = hosts.some((h) => h.fakeIp || isFakeIp(h.dns));
  const loopbackHit = hosts.some((h) => isLoopbackIp(h.dns));
  const publicOk = hosts.some((h) => h.publicDns && !isFakeIp(h.publicDns));
  const service403 = [git, harbor].filter((h) => h && h.httpStatus === 403);

  const advice = [];

  if (fakeIpHit) {
    advice.push(
      "关键：系统 DNS 仍返回 198.18.x.x（Clash/Surge fake-IP）。连 baidu 也是这个段 = 代理进程/DNS 残留，不是“规则没写 DIRECT”。"
    );
    if (publicOk) {
      advice.push(
        `公共 DNS 能解析到真实 IP（例如 ${hosts.find((h) => h.publicDns)?.publicDns}），说明网络正常，只需清掉本机 DNS 劫持。`
      );
    }
    advice.push(
      "Mac 排查：1) 完全退出 Clash/Surge（菜单栏 Quit，不要只关“系统代理”） 2) dig @223.5.5.5 app.finedo.cn 应变公网 3) 系统设置→DNS 改回自动或 223.5.5.5 4) sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder"
    );
    advice.push("也可运行: bash scripts/fix-mac-dns.sh");
  } else if (loopbackHit && !authorized) {
    advice.push("域名解析到 127.0.0.1 — 本地 SDP 占位。需先成功敲门，解析才会切到真实入口。");
  }

  if (!authorized) {
    if (!fakeIpHit) {
      const connFail = hosts.some((h) => !h.httpStatus && h.error);
      if (connFail) {
        advice.push(
          "443 连接失败（Couldn't connect）= SPA 默认拒绝，白名单未打开。这比 403 更“隐形”。"
        );
      }
      advice.push("spacheck.json 不是 200 → 本机公网 IP 尚未进入 SPA 白名单。");
      advice.push("请先：finenet-auth authorize，等 2–3 秒再 diagnose；UDP 30982 必须直连可达。");
      if (service403.length) {
        advice.push(
          `${service403.map((h) => h.name).join("/")} 返回 403 仍属未授权常见表现（网关拒访页），不要当成“已经进站了”。`
        );
      }
    } else {
      advice.push(
        "DNS 未恢复前不要判断敲门成败：Node/浏览器都走假 IP，authorize sent=true 也不能当已授权。"
      );
    }
  } else if (service403.length) {
    advice.push(
      `SPA(spacheck) 已通过，但 ${service403.map((h) => h.name).join("/")} 仍 403：可能是分服务白名单，或 Git/Harbor 应用层未登录。`
    );
    advice.push("对比：curl -sI https://app.finedo.cn/ 与 git/harbor；若 app 正常而 git/harbor 403，优先找运维确认 SPA 策略是否包含这两台。");
    advice.push("Harbor/Git 浏览器无 Cookie 时也可能 401/403；能打开登录页或返回 302→login 通常算网络已通。");
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
    flags: { fakeIpHit, loopbackHit, publicOk },
  };
}
