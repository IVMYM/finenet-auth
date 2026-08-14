import { EventEmitter } from "node:events";
import { DEFAULTS } from "./config.js";
import { authorizeKnock, extractKeyFromReply } from "./knock.js";
import { checkStatus } from "./probe.js";

/**
 * Background keep-alive after first success:
 *  - silent knock (identification "1") on knockInterval
 *  - key update (identification "2") on publicKeyInterval
 * Offline: back off to ~30–61s until online again.
 */
export class KeepAlive extends EventEmitter {
  constructor(client, options = {}) {
    super();
    this.client = client;
    this.knockIntervalMs = options.knockIntervalMs ?? DEFAULTS.knockIntervalMs;
    this.publicKeyIntervalMs = options.publicKeyIntervalMs ?? DEFAULTS.publicKeyIntervalMs;
    this.offlineRetryMs = options.offlineRetryMs ?? DEFAULTS.offlineRetryMs;
    this.offlineRetryMaxMs = options.offlineRetryMaxMs ?? DEFAULTS.offlineRetryMaxMs;
    this._knockTimer = null;
    this._keyTimer = null;
    this._running = false;
    this._offlineBackoff = this.offlineRetryMs;
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.emit("start");
    this._scheduleKnock(0);
    this._scheduleKeyUpdate(this.publicKeyIntervalMs);
  }

  stop() {
    this._running = false;
    if (this._knockTimer) clearTimeout(this._knockTimer);
    if (this._keyTimer) clearTimeout(this._keyTimer);
    this._knockTimer = null;
    this._keyTimer = null;
    this.emit("stop");
  }

  updateIntervals({ knockIntervalMs, publicKeyIntervalMs } = {}) {
    if (knockIntervalMs) this.knockIntervalMs = knockIntervalMs;
    if (publicKeyIntervalMs) this.publicKeyIntervalMs = publicKeyIntervalMs;
  }

  _scheduleKnock(delay) {
    if (!this._running) return;
    if (this._knockTimer) clearTimeout(this._knockTimer);
    this._knockTimer = setTimeout(() => this._runKnock(), delay);
  }

  _scheduleKeyUpdate(delay) {
    if (!this._running) return;
    if (this._keyTimer) clearTimeout(this._keyTimer);
    this._keyTimer = setTimeout(() => this._runKeyUpdate(), delay);
  }

  async _runKnock() {
    if (!this._running) return;
    try {
      const online = this.client.state?.authorized;
      if (!online) {
        const probe = await this.client.probe();
        if (!probe.authorized) {
          this.emit("offline", { phase: "knock", backoffMs: this._offlineBackoff });
          this._scheduleKnock(this._offlineBackoff);
          this._offlineBackoff = Math.min(this._offlineBackoff + 5_000, this.offlineRetryMaxMs);
          return;
        }
      }

      this._offlineBackoff = this.offlineRetryMs;
      const result = await this.client.silentKnock();
      this.emit("knock", result);
      this._scheduleKnock(this.knockIntervalMs);
    } catch (err) {
      this.emit("error", { phase: "knock", error: err });
      this._scheduleKnock(this._offlineBackoff);
    }
  }

  async _runKeyUpdate() {
    if (!this._running) return;
    try {
      const online = this.client.state?.authorized;
      if (!online) {
        this._scheduleKeyUpdate(this._offlineBackoff);
        return;
      }

      const result = await this.client.rotateKey();
      this.emit("keyUpdate", result);
      this._scheduleKeyUpdate(this.publicKeyIntervalMs);
    } catch (err) {
      this.emit("error", { phase: "keyUpdate", error: err });
      this._scheduleKeyUpdate(this._offlineBackoff);
    }
  }
}

/**
 * Helper used by Client.rotateKey to ingest UDP reply keys.
 */
export function ingestKeyReply(store, userid, reply) {
  if (!reply?.text) return null;
  const key = extractKeyFromReply(reply.text);
  if (!key) return null;
  return store.setKey(userid, key, { source: "udp-rotate" });
}

export async function probeThenMaybeStart(client, keepAlive) {
  const status = await checkStatus({
    probeUrl: client.config.probeUrl,
    machineId: client.machineid,
  });
  client.state = status;
  if (status.authorized && !keepAlive.running) {
    keepAlive.start();
  }
  return status;
}
