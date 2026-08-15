import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";
import { isFakeIp } from "./probe.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PUBLIC_DNS = ["223.5.5.5", "8.8.8.8"];
const VERIFY_HOSTS = ["git.finedo.cn", "app.finedo.cn", "www.baidu.com"];

function backupPath() {
  return join(dataDir(), "dns-backup.json");
}

async function run(cmd, args) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
}

/** Prefer Wi-Fi; fall back to first non-disabled hardware service. */
export async function detectWifiService() {
  if (platform() !== "darwin") return null;
  const { stdout } = await run("networksetup", ["-listallnetworkservices"]);
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("asterisk"));
  const prefer = ["Wi-Fi", "Airport", "WLAN"];
  for (const name of prefer) {
    if (lines.includes(name)) return name;
  }
  const wifiLike = lines.find((l) => /wi-?fi|airport|wlan/i.test(l));
  return wifiLike || lines[0] || null;
}

export async function getDnsServers(service) {
  const { stdout } = await run("networksetup", ["-getdnsservers", service]);
  if (/there aren't any dns servers/i.test(stdout) || /aren't any/i.test(stdout)) {
    return { automatic: true, servers: [] };
  }
  const servers = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { automatic: false, servers };
}

export async function setDnsServers(service, servers) {
  if (!servers?.length) {
    await run("networksetup", ["-setdnsservers", service, "Empty"]);
    return { service, servers: [], automatic: true };
  }
  await run("networksetup", ["-setdnsservers", service, ...servers]);
  return { service, servers: [...servers], automatic: false };
}

async function flushDnsCacheBestEffort() {
  try {
    await run("dscacheutil", ["-flushcache"]);
  } catch {
    /* may need sudo */
  }
  try {
    await run("killall", ["-HUP", "mDNSResponder"]);
  } catch {
    /* may need sudo */
  }
}

function saveBackup(payload) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(backupPath(), JSON.stringify(payload, null, 2));
}

function loadBackup() {
  const p = backupPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

async function digShort(host, atServer) {
  try {
    const args = atServer ? ["@" + atServer, "+short", "+time=2", "+tries=1", host] : ["+short", "+time=2", "+tries=1", host];
    const { stdout } = await run("dig", args);
    const first = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.includes(":") && /^\d+\.\d+\.\d+\.\d+$/.test(l));
    return first || null;
  } catch {
    return null;
  }
}

async function listProxyProcesses() {
  if (platform() !== "darwin" && platform() !== "linux") return [];
  try {
    const { stdout } = await run("ps", ["aux"]);
    return stdout
      .split("\n")
      .filter((l) => /clash|surge|mihomo|quantumult|v2ray|xray|sing-box/i.test(l))
      .filter((l) => !/grep|egrep|fix-mac-dns|dns-fix/i.test(l))
      .map((l) => l.trim())
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Compare system dig vs dig @public. Fake-IP on system while public is real
 * ⇒ Clash/Surge TUN / enhanced-mode DNS hijack (Wi-Fi DNS 设置无效).
 */
export async function verifyDnsResolution(hosts = VERIFY_HOSTS) {
  const rows = [];
  for (const host of hosts) {
    const system = await digShort(host);
    const publicIp = await digShort(host, "223.5.5.5");
    rows.push({
      host,
      system,
      public: publicIp,
      systemFakeIp: isFakeIp(system),
      publicOk: Boolean(publicIp) && !isFakeIp(publicIp),
      hijacked: isFakeIp(system) && Boolean(publicIp) && !isFakeIp(publicIp),
    });
  }
  const hijacked = rows.some((r) => r.hijacked || r.systemFakeIp);
  const proxyProcesses = await listProxyProcesses();
  return {
    hijacked,
    rows,
    proxyProcesses,
    advice: hijacked
      ? [
          "Wi-Fi DNS 即使已是 223.5.5.5，系统 dig 仍返回 198.18.* → Clash/Surge **TUN/增强模式**在网卡层劫持 DNS，改系统 DNS 无效。",
          "处理：菜单栏对 Clash/Surge 选 Quit（彻底退出）；关闭 TUN / 增强模式 / fake-IP；活动监视器结束残留进程。",
          "验证：dig @223.5.5.5 +short git.finedo.cn 应为公网；dig +short git.finedo.cn 必须与之一致（不能再是 198.18.*）。",
          "Clash 规则兜底：DOMAIN-SUFFIX,finedo.cn,DIRECT，并对 fake-ip-filter 加入 +.finedo.cn",
        ]
      : [],
  };
}

/**
 * On macOS, switch Wi-Fi DNS to public resolvers before SPA apply/authorize.
 * Always verifies resolution; reports TUN hijack even when DNS servers look public.
 */
export async function ensurePublicWifiDns({
  enabled = true,
  service: serviceOpt,
  publicDns = DEFAULT_PUBLIC_DNS,
  force = false,
} = {}) {
  if (!enabled) return { ok: true, skipped: true, reason: "disabled" };
  if (platform() !== "darwin") {
    return { ok: true, skipped: true, reason: "not-darwin" };
  }
  if (process.env.FINENET_SKIP_DNS_FIX === "1") {
    return { ok: true, skipped: true, reason: "env-skip" };
  }

  const service = serviceOpt || process.env.FINENET_WIFI_SERVICE || (await detectWifiService());
  if (!service) {
    return { ok: false, skipped: false, error: "未找到网络服务（Wi-Fi）" };
  }

  const before = await getDnsServers(service);
  const alreadyPublic =
    before.servers.length > 0 &&
    before.servers.every((s) => publicDns.includes(s)) &&
    before.servers.length === publicDns.length;

  let after = before;
  let skipped = false;
  let reason = null;

  if (alreadyPublic && !force) {
    skipped = true;
    reason = "already-public";
  } else {
    const existing = loadBackup();
    if (!existing) {
      saveBackup({
        at: Date.now(),
        service,
        before,
      });
    }
    after = await setDnsServers(service, publicDns);
    await flushDnsCacheBestEffort();
  }

  const verify = await verifyDnsResolution();
  if (verify.hijacked) {
    return {
      ok: false,
      skipped,
      reason: skipped ? "already-public-but-tun-hijack" : "set-but-tun-hijack",
      service,
      before,
      after,
      verify,
      error:
        "系统 DNS 已是公共服务器，但解析仍被 Clash/Surge TUN 劫持（198.18.*）。请彻底退出代理后再 dig。",
      advice: verify.advice,
    };
  }

  return {
    ok: true,
    skipped,
    reason,
    service,
    before,
    after,
    flushed: !skipped,
    verify,
  };
}

/** Restore DNS saved by ensurePublicWifiDns. */
export async function restoreWifiDns() {
  if (platform() !== "darwin") {
    return { ok: true, skipped: true, reason: "not-darwin" };
  }
  const backup = loadBackup();
  if (!backup?.service) {
    return { ok: true, skipped: true, reason: "no-backup" };
  }

  const service = backup.service;
  if (backup.before?.automatic || !backup.before?.servers?.length) {
    await setDnsServers(service, []);
  } else {
    await setDnsServers(service, backup.before.servers);
  }
  await flushDnsCacheBestEffort();

  try {
    unlinkSync(backupPath());
  } catch {
    /* ignore */
  }

  return { ok: true, skipped: false, service, restored: backup.before };
}

export { DEFAULT_PUBLIC_DNS };
