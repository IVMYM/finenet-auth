import { EventEmitter } from "node:events";
import { DEFAULTS, fetchReturnTime } from "./config.js";
import { getMachineId, getDeviceType } from "./machine.js";
import { KeyStore } from "./store.js";
import { normalizePublicKey } from "./crypto.js";
import { applyKey, authorizeKnock } from "./knock.js";
import { checkStatus } from "./probe.js";
import { KeepAlive, ingestKeyReply } from "./keepalive.js";

/**
 * Orchestrates 申请密钥 → 请求授权 → probe → keep-alive.
 */
export class SpaClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = { ...DEFAULTS, ...options };
    this.store = options.store || new KeyStore(options.storePath);
    this.machineid = options.machineid || getMachineId();
    this.deviceType = options.deviceType || getDeviceType();
    this.state = null;
    this.lastKnock = null;
    this.logs = [];
    this.keepAlive = new KeepAlive(this, {
      knockIntervalMs: this.config.knockIntervalMs,
      publicKeyIntervalMs: this.config.publicKeyIntervalMs,
      offlineRetryMs: this.config.offlineRetryMs,
      offlineRetryMaxMs: this.config.offlineRetryMaxMs,
    });

    this.keepAlive.on("knock", (r) => this._log("keepalive", "silent knock", r));
    this.keepAlive.on("keyUpdate", (r) => this._log("keepalive", "key update", r));
    this.keepAlive.on("offline", (r) => this._log("keepalive", "offline backoff", r));
    this.keepAlive.on("error", (r) => this._log("error", "keepalive", r));
  }

  _log(level, message, detail) {
    const entry = { at: Date.now(), level, message, detail: summarize(detail) };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.length = 100;
    this.emit("log", entry);
  }

  getProfile() {
    return this.store.getProfile();
  }

  setProfile({ userid, username, usercode }) {
    const profile = this.store.setProfile({ userid, username, usercode });
    this._log("info", "profile saved", profile);
    return profile;
  }

  getPublicKey(userid) {
    const id = userid || this.store.getProfile()?.userid;
    if (!id) return null;
    return this.store.getKey(id);
  }

  savePublicKey(rawKey, userid) {
    const profile = this.store.getProfile();
    const id = userid || profile?.userid;
    if (!id) throw new Error("请先填写工号 / userid");
    const pem = normalizePublicKey(rawKey);
    const row = this.store.setKey(id, pem, { source: "wecom-paste" });
    this._log("info", "公钥已保存", { userid: id });
    return row;
  }

  _ctx() {
    const profile = this.store.getProfile();
    if (!profile?.userid) throw new Error("请先填写工号与姓名");
    const keyRow = this.store.getKey(profile.userid);
    return {
      machineid: this.machineid,
      userid: profile.userid,
      username: profile.username,
      usercode: profile.usercode || profile.userid,
      deviceType: this.deviceType,
      publicKey: keyRow?.publicKey || null,
      udpHost: this.config.udpHost,
      udpPort: this.config.udpPort,
    };
  }

  async refreshTimers() {
    const next = await fetchReturnTime(this.config);
    this.config.knockIntervalMs = next.knockIntervalMs;
    this.config.publicKeyIntervalMs = next.publicKeyIntervalMs;
    this.config.authValidMs = next.authValidMs;
    this.keepAlive.updateIntervals({
      knockIntervalMs: next.knockIntervalMs,
      publicKeyIntervalMs: next.publicKeyIntervalMs,
    });
    this._log("info", "timers refreshed", {
      knockIntervalMs: next.knockIntervalMs,
      publicKeyIntervalMs: next.publicKeyIntervalMs,
      authValidMs: next.authValidMs,
    });
    return next;
  }

  async probe() {
    const result = await checkStatus({
      probeUrl: this.config.probeUrl,
      machineId: this.machineid,
      timeoutMs: this.config.probeTimeoutMs,
    });
    this.state = result;
    this.emit("status", result);
    this._log(result.authorized ? "ok" : "warn", result.status, {
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      error: result.error,
    });

    if (result.authorized) {
      if (!this.keepAlive.running) this.keepAlive.start();
      // Try remote timer overrides once online
      this.refreshTimers().catch(() => {});
    }
    return result;
  }

  /** Step 1 — 申请密钥 */
  async applyForKey() {
    const ctx = this._ctx();
    const result = await applyKey(ctx);
    this.lastKnock = { type: "apply", at: Date.now(), result };
    this._log("info", "已发送申请密钥", { bytes: result.bytes, identification: "0" });
    return result;
  }

  /** Step 2 — 请求授权 (manual, identification "0") */
  async requestAuth() {
    const ctx = this._ctx();
    if (!ctx.publicKey) {
      throw new Error("尚未保存公钥。请粘贴企业微信下发的 RSA 公钥后再请求授权。");
    }
    const result = await authorizeKnock(ctx, { identification: "0" });
    this.lastKnock = { type: "authorize", at: Date.now(), result };
    if (result.skipped) {
      this._log("warn", "敲门已跳过", { reason: result.reason });
    } else {
      this._log("info", "已发送请求授权", { bytes: result.bytes, identification: "0" });
    }
    // Probe shortly after fire-and-forget knock
    setTimeout(() => this.probe().catch(() => {}), 800);
    return result;
  }

  /** Auto knock on launch when key already exists */
  async autoKnockIfPossible() {
    const profile = this.store.getProfile();
    if (!profile?.userid) return { skipped: true, reason: "no profile" };
    const key = this.store.getKey(profile.userid);
    if (!key?.publicKey) return { skipped: true, reason: "no key" };

    const probe = await this.probe();
    if (probe.authorized) {
      return { skipped: false, alreadyAuthorized: true, probe };
    }

    const result = await this.silentKnock();
    setTimeout(() => this.probe().catch(() => {}), 800);
    return { skipped: false, result, probe };
  }

  async silentKnock() {
    const ctx = this._ctx();
    const result = await authorizeKnock(ctx, { identification: "1" });
    this.lastKnock = { type: "silent", at: Date.now(), result };
    return result;
  }

  async rotateKey() {
    const ctx = this._ctx();
    const result = await authorizeKnock(ctx, { identification: "2", waitReplyMs: 2_500 });
    this.lastKnock = { type: "rotate", at: Date.now(), result };
    if (result.reply) {
      const saved = ingestKeyReply(this.store, ctx.userid, result.reply);
      if (saved) this._log("info", "公钥已轮换写入本地", { userid: ctx.userid });
    }
    return result;
  }

  snapshot() {
    const profile = this.store.getProfile();
    const key = profile ? this.store.getKey(profile.userid) : null;
    return {
      machineid: this.machineid,
      deviceType: this.deviceType,
      profile,
      hasKey: Boolean(key?.publicKey),
      keyUpdatedAt: key?.updatedAt || null,
      state: this.state,
      keepAlive: this.keepAlive.running,
      config: {
        udpHost: this.config.udpHost,
        udpPort: this.config.udpPort,
        probeUrl: this.config.probeUrl,
        authValidMs: this.config.authValidMs,
        knockIntervalMs: this.config.knockIntervalMs,
        publicKeyIntervalMs: this.config.publicKeyIntervalMs,
      },
      lastKnock: this.lastKnock
        ? {
            type: this.lastKnock.type,
            at: this.lastKnock.at,
            sent: this.lastKnock.result?.sent,
            skipped: this.lastKnock.result?.skipped,
            reason: this.lastKnock.result?.reason,
          }
        : null,
      logs: this.logs.slice(0, 30),
    };
  }

  stop() {
    this.keepAlive.stop();
  }
}

function summarize(detail) {
  if (detail == null) return null;
  if (detail instanceof Error) return { message: detail.message };
  if (typeof detail !== "object") return detail;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k === "packet" || k === "sign" || k === "publicKey" || k === "raw") continue;
    if (typeof v === "string" && v.length > 180) out[k] = `${v.slice(0, 180)}…`;
    else out[k] = v;
  }
  return out;
}
