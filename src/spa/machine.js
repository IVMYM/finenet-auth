import { createHash, randomUUID } from "node:crypto";
import { hostname, platform, arch, networkInterfaces } from "node:os";
import machineIdPkg from "node-machine-id";

const { machineIdSync } = machineIdPkg;

/**
 * Stable machine fingerprint — prefers node-machine-id, falls back to hashed host info.
 */
export function getMachineId() {
  try {
    return machineIdSync(true);
  } catch {
    const nic = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && !n.internal && n.mac && n.mac !== "00:00:00:00:00:00");
    const seed = [hostname(), platform(), arch(), nic?.mac || "nomac"].join("|");
    return createHash("sha256").update(seed).digest("hex");
  }
}

export function getDeviceType(override) {
  if (override) return override;
  if (platform() === "darwin") return "mac";
  if (platform() === "win32") return "pc";
  return "linux";
}

/** Session id for local UI / logs only. */
export function newSessionId() {
  return randomUUID();
}
