import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { storePath, dataDir } from "./config.js";

/**
 * Lightweight local store mirroring FinedoIT `tb_sqlite_cipher` semantics:
 * one public key row per userid.
 */
export class KeyStore {
  constructor(path = storePath()) {
    this.path = path;
    this._ensure();
    this.data = this._load();
  }

  _ensure() {
    mkdirSync(dataDir(), { recursive: true });
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, JSON.stringify({ version: 1, keys: {} }, null, 2));
    }
  }

  _load() {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.keys || typeof parsed.keys !== "object") {
        return { version: 1, keys: {}, profile: parsed.profile || null };
      }
      return parsed;
    } catch {
      return { version: 1, keys: {}, profile: null };
    }
  }

  _save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  getProfile() {
    return this.data.profile || null;
  }

  setProfile(profile) {
    this.data.profile = {
      userid: String(profile.userid || "").trim(),
      username: String(profile.username || "").trim(),
      usercode: String(profile.usercode || profile.userid || "").trim(),
      updatedAt: Date.now(),
    };
    this._save();
    return this.data.profile;
  }

  getKey(userid) {
    const id = String(userid || "").trim();
    if (!id) return null;
    return this.data.keys[id] || null;
  }

  /**
   * @param {string} userid
   * @param {string} publicKey PEM / WeCom blob
   * @param {{ source?: string }} meta
   */
  setKey(userid, publicKey, meta = {}) {
    const id = String(userid || "").trim();
    if (!id) throw new Error("userid 不能为空");
    if (!publicKey || !String(publicKey).trim()) throw new Error("公钥不能为空");

    this.data.keys[id] = {
      userid: id,
      publicKey: String(publicKey).trim(),
      source: meta.source || "manual",
      updatedAt: Date.now(),
    };
    this._save();
    return this.data.keys[id];
  }

  clearKey(userid) {
    const id = String(userid || "").trim();
    if (this.data.keys[id]) {
      delete this.data.keys[id];
      this._save();
    }
  }

  listKeys() {
    return Object.values(this.data.keys);
  }
}
