import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PUBLIC_DNS = ["223.5.5.5", "8.8.8.8"];

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
  const prefer = ["Wi-Fi", "Wi-Fi", "Airport", "WLAN"];
  for (const name of prefer) {
    if (lines.includes(name)) return name;
  }
  // Thunderbolt / USB bridges often not Wi-Fi; pick first that looks wireless-ish
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

/**
 * On macOS, switch Wi-Fi DNS to public resolvers before SPA apply/authorize.
 * Saves previous DNS for later restore.
 *
 * @returns {Promise<object>} result summary (skipped on non-mac)
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

  if (alreadyPublic && !force) {
    return {
      ok: true,
      skipped: true,
      reason: "already-public",
      service,
      before,
      after: before,
    };
  }

  // Only overwrite backup if we don't already have one from this session
  const existing = loadBackup();
  if (!existing) {
    saveBackup({
      at: Date.now(),
      service,
      before,
    });
  }

  const after = await setDnsServers(service, publicDns);
  await flushDnsCacheBestEffort();

  return {
    ok: true,
    skipped: false,
    service,
    before,
    after,
    flushed: true,
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
    const { unlinkSync } = await import("node:fs");
    unlinkSync(backupPath());
  } catch {
    /* ignore */
  }

  return { ok: true, skipped: false, service, restored: backup.before };
}

export { DEFAULT_PUBLIC_DNS };
