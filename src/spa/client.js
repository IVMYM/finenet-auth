import { EventEmitter } from "node:events";
import { DEFAULTS, fetchReturnTime } from "./config.js";
import { getMachineId, getDeviceType } from "./machine.js";
import { KeyStore } from "./store.js";
import { normalizePublicKey } from "./crypto.js";
import { applyKey, authorizeKnock } from "./knock.js";
import { checkStatus, diagnoseHosts } from "./probe.js";
import { KeepAlive, ingestKeyReply } from "./keepalive.js";
import { ensurePublicWifiDns, restoreWifiDns } from "./dns-fix.js";

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
    this.hosts = null;
    this.lastKnock = null;
    this._knockGuard = {
      lastAt: 0,
      failCount: 0,
      cooldownUntil: 0,
    };
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

    // Also refresh host matrix (git/app) — cheap parallel diagnose
    try {
      const diag = await diagnoseHosts({
        machineId: this.machineid,
        timeoutMs: this.config.probeTimeoutMs,
        hostChecks: this.config.hostChecks,
      });
      this.hosts = diag.hosts;
      result.hosts = diag.hosts;
      result.advice = diag.advice;
    } catch {
      /* ignore host matrix errors */
    }

    this.emit("status", result);
    this._log(result.authorized ? "ok" : "warn", result.status, {
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      error: result.error,
      git: this.hosts?.find((h) => h.name === "git")?.httpStatus,
    });

    if (result.authorized) {
      this._knockGuard.failCount = 0;
      this._knockGuard.cooldownUntil = 0;
      if (!this.keepAlive.running) this.keepAlive.start();
      this.refreshTimers().catch(() => {});
    } else if (this.keepAlive.running) {
      // Never keep knocking while unauthorized
      this.keepAlive.stop();
    }
    return result;
  }

  _assertCanKnock(kind) {
    const now = Date.now();
    const g = this._knockGuard;
    if (g.cooldownUntil && now < g.cooldownUntil) {
      const mins = Math.ceil((g.cooldownUntil - now) / 60_000);
      throw new Error(
        `敲门已冷却（疑似异常上报过多）。请等待约 ${mins} 分钟，或联系运维解封 IP 后再试。`
      );
    }
    const gap = this.config.knockMinIntervalMs || 60_000;
    if (g.lastAt && now - g.lastAt < gap && kind !== "force") {
      const wait = Math.ceil((gap - (now - g.lastAt)) / 1000);
      throw new Error(`敲门过于频繁，请 ${wait}s 后再试，避免触发「异常上报封堵」。`);
    }
  }

  _noteKnockSent({ authorizedSoon } = {}) {
    const g = this._knockGuard;
    g.lastAt = Date.now();
    if (authorizedSoon) {
      g.failCount = 0;
      g.cooldownUntil = 0;
      return;
    }
    // Optimistic: count as attempt; probe later may clear
    g.failCount += 1;
    const limit = this.config.knockFailLimit || 5;
    if (g.failCount >= limit) {
      g.cooldownUntil = Date.now() + (this.config.knockCooldownMs || 30 * 60_000);
      this._log("warn", "敲门失败次数过多，进入冷却", {
        failCount: g.failCount,
        cooldownUntil: g.cooldownUntil,
      });
    }
  }

  async diagnose() {
    const diag = await diagnoseHosts({
      machineId: this.machineid,
      timeoutMs: this.config.probeTimeoutMs,
      hostChecks: this.config.hostChecks,
    });
    // Do NOT UDP-ping on every diagnose — reduces 异常上报 noise.
    diag.udp = null;
    if (!diag.authorized) {
      diag.advice.unshift(
        "若企业微信提示 IP 被封堵（异常上报达上限）：立刻停止 authorize/apply，联系运维解封；继续敲门会加重封堵。"
      );
    }

    this.hosts = diag.hosts;
    this.state = {
      authorized: diag.authorized,
      status: diag.status,
      httpStatus: diag.hosts.find((h) => h.name === "spacheck")?.httpStatus || 0,
      checkedAt: diag.checkedAt,
      hosts: diag.hosts,
      advice: diag.advice,
    };
    this._log("info", "diagnose", {
      status: diag.status,
      git: diag.hosts.find((h) => h.name === "git")?.httpStatus,
    });
    return diag;
  }

  /** Step 1 — 申请密钥 */
  async fixWifiDns(reason = "auth") {
    if (!this.config.autoFixWifiDns) {
      return { ok: true, skipped: true, reason: "disabled" };
    }
    try {
      const result = await ensurePublicWifiDns({
        enabled: true,
        publicDns: this.config.publicDns,
      });
      this.lastDnsFix = { at: Date.now(), reason, ...result };
      if (result.ok === false) {
        this._log("warn", result.error || "DNS 仍被 TUN/fake-IP 劫持", {
          reason: result.reason,
          verify: result.verify?.rows,
        });
      } else if (!result.skipped) {
        this._log("info", "已切换 Wi-Fi DNS 为公共解析", {
          service: result.service,
          after: result.after?.servers,
          before: result.before?.automatic ? "automatic" : result.before?.servers,
        });
      } else {
        this._log("info", "Wi-Fi DNS 未改动", { reason: result.reason, service: result.service });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log("warn", "自动改 Wi-Fi DNS 失败", { message });
      this.lastDnsFix = { at: Date.now(), reason, ok: false, error: message };
      return this.lastDnsFix;
    }
  }

  async restoreWifiDns() {
    try {
      const result = await restoreWifiDns();
      this._log("info", "已恢复 Wi-Fi DNS", result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log("warn", "恢复 Wi-Fi DNS 失败", { message });
      return { ok: false, error: message };
    }
  }

  async applyForKey() {
    this._assertCanKnock("apply");
    await this.fixWifiDns("apply");
    const ctx = this._ctx();
    const result = await applyKey(ctx);
    this._noteKnockSent();
    this.lastKnock = { type: "apply", at: Date.now(), result };
    this._log("info", "已发送申请密钥", { bytes: result.bytes, identification: "0" });
    return result;
  }

  /** Step 2 — 请求授权 (manual, identification "0") */
  async requestAuth() {
    this._assertCanKnock("authorize");
    await this.fixWifiDns("authorize");
    const ctx = this._ctx();
    if (!ctx.publicKey) {
      throw new Error("尚未保存公钥。请粘贴企业微信下发的 RSA 公钥后再请求授权。");
    }
    const result = await authorizeKnock(ctx, { identification: "0" });
    this._noteKnockSent();
    this.lastKnock = { type: "authorize", at: Date.now(), result };
    if (result.skipped) {
      this._log("warn", "敲门已跳过", { reason: result.reason });
    } else {
      this._log("info", "已发送请求授权", { bytes: result.bytes, identification: "0" });
    }
    // Probe shortly after fire-and-forget knock
    setTimeout(() => this.probe().catch(() => {}), 1500);
    return result;
  }

  /** Auto knock on launch when key already exists — only if not cooling down */
  async autoKnockIfPossible() {
    const profile = this.store.getProfile();
    if (!profile?.userid) return { skipped: true, reason: "no profile" };
    const key = this.store.getKey(profile.userid);
    if (!key?.publicKey) return { skipped: true, reason: "no key" };

    const probe = await this.probe();
    if (probe.authorized) {
      this._knockGuard.failCount = 0;
      return { skipped: false, alreadyAuthorized: true, probe };
    }

    // While unauthorized, do NOT auto UDP-knock on every launch (LaunchAgent 重启会刷爆上报).
    this._log("warn", "未授权：跳过自动敲门，请手动 authorize（解封后）", {
      failCount: this._knockGuard.failCount,
    });
    return { skipped: true, reason: "unauthorized-no-auto-knock", probe };
  }

  async silentKnock() {
    this._assertCanKnock("silent");
    const ctx = this._ctx();
    const result = await authorizeKnock(ctx, { identification: "1" });
    this._noteKnockSent();
    this.lastKnock = { type: "silent", at: Date.now(), result };
    return result;
  }

  async rotateKey() {
    this._assertCanKnock("rotate");
    const ctx = this._ctx();
    const result = await authorizeKnock(ctx, { identification: "2", waitReplyMs: 2_500 });
    this._noteKnockSent();
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
      hosts: this.hosts,
      keepAlive: this.keepAlive.running,
      lastDnsFix: this.lastDnsFix || null,
      config: {
        udpHost: this.config.udpHost,
        udpPort: this.config.udpPort,
        probeUrl: this.config.probeUrl,
        authValidMs: this.config.authValidMs,
        knockIntervalMs: this.config.knockIntervalMs,
        publicKeyIntervalMs: this.config.publicKeyIntervalMs,
        autoFixWifiDns: this.config.autoFixWifiDns,
        publicDns: this.config.publicDns,
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
