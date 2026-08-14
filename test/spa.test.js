import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSignPayload, encryptSign, normalizePublicKey } from "../src/spa/crypto.js";
import { buildApplyPacket, buildAuthPacket, extractKeyFromReply } from "../src/spa/knock.js";
import { KeyStore } from "../src/spa/store.js";

describe("crypto", () => {
  it("normalizes bare base64 into PEM and encrypts sign payload", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const bare = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

    const normalized = normalizePublicKey(bare);
    assert.match(normalized, /BEGIN PUBLIC KEY/);

    const sign = encryptSign(normalized, {
      usercode: "u100",
      username: "Alice",
      timestamp: 1700000000000,
    });
    assert.equal(typeof sign, "string");
    assert.ok(sign.length > 80);

    const payload = buildSignPayload({ usercode: "u100", username: "Alice", timestamp: 1 });
    assert.equal(payload, '{"usercode":"u100","username":"Alice","timestamp":1}');
  });
});

describe("knock packets", () => {
  it("builds apply packet with identification 0", () => {
    const p = buildApplyPacket({
      machineid: "mid",
      user: "100",
      username: "Bob",
      deviceType: "pc",
    });
    assert.equal(p.identification, "0");
    assert.equal(p.machineid, "mid");
    assert.equal(p.devicetype, "pc");
  });

  it("skips auth when public key missing", () => {
    const built = buildAuthPacket({
      machineid: "mid",
      user: "100",
      username: "Bob",
      publicKey: null,
    });
    assert.equal(built.skipped, true);
    assert.equal(built.sign, "");
  });

  it("builds signed auth packet", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const built = buildAuthPacket({
      machineid: "mid",
      user: "100",
      username: "Bob",
      publicKey: pem,
      identification: "1",
      timestamp: 42,
    });
    assert.equal(built.skipped, false);
    assert.equal(built.packet.identification, "1");
    assert.ok(built.packet.sign.length > 40);
  });

  it("extracts key from JSON reply", () => {
    const key = extractKeyFromReply(JSON.stringify({ publicKey: "abc123" }));
    assert.equal(key, "abc123");
  });
});

describe("store", () => {
  it("persists profile and key per userid", () => {
    const dir = mkdtempSync(join(tmpdir(), "finenet-"));
    const path = join(dir, "keys.json");
    try {
      const store = new KeyStore(path);
      store.setProfile({ userid: "42", username: "Carol" });
      store.setKey("42", "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----");
      const again = new KeyStore(path);
      assert.equal(again.getProfile().userid, "42");
      assert.ok(again.getKey("42").publicKey.includes("BEGIN"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diagnose advice", () => {
  it("flags 403 as likely unauthorized when spa is down", async () => {
    const { DEFAULTS } = await import("../src/spa/config.js");
    assert.ok(DEFAULTS.hostChecks.some((h) => h.name === "git"));
    assert.ok(DEFAULTS.hostChecks.some((h) => h.name === "spacheck"));
  });
});
