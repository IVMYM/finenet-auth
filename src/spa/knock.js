import dgram from "node:dgram";
import { DEFAULTS } from "./config.js";
import { encryptSignFlexible } from "./crypto.js";

/**
 * Fire-and-forget UDP SPA knock to finedo.cn:30982.
 * Success is NOT inferred from the UDP reply — the client probes spacheck.json.
 */
export function sendUdp(packet, { host = DEFAULTS.udpHost, port = DEFAULTS.udpPort, waitReplyMs = 0 } = {}) {
  const payload = typeof packet === "string" ? packet : JSON.stringify(packet);
  const buf = Buffer.from(payload, "utf8");

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    let reply = null;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    socket.on("error", (err) => done(err));

    if (waitReplyMs > 0) {
      socket.on("message", (msg, rinfo) => {
        reply = {
          text: msg.toString("utf8"),
          from: `${rinfo.address}:${rinfo.port}`,
          raw: msg,
        };
        done(null, { sent: true, bytes: buf.length, reply });
      });
    }

    socket.send(buf, port, host, (err) => {
      if (err) return done(err);
      if (waitReplyMs <= 0) {
        done(null, { sent: true, bytes: buf.length, reply: null });
      } else {
        setTimeout(() => done(null, { sent: true, bytes: buf.length, reply }), waitReplyMs);
      }
    });
  });
}

/**
 * identification:
 *  "0" — manual apply / authorize (WeCom notify)
 *  "1" — silent keep-alive knock
 *  "2" — key rotation
 */
export function buildApplyPacket({ machineid, user, username, usercode, deviceType, identification = "0" }) {
  return {
    machineid,
    user: String(user || usercode || ""),
    username: String(username || ""),
    usercode: String(usercode || user || ""),
    devicetype: deviceType || DEFAULTS.deviceType,
    identification: String(identification),
    timestamp: Date.now(),
  };
}

export function buildAuthPacket({
  machineid,
  user,
  username,
  usercode,
  deviceType,
  publicKey,
  identification = "0",
  timestamp = Date.now(),
}) {
  const uid = String(usercode || user || "");
  const uname = String(username || "");
  if (!publicKey) {
    return {
      packet: null,
      sign: "",
      skipped: true,
      reason: "无公钥，跳过敲门（sign 为空）",
    };
  }

  let sign = "";
  try {
    sign = encryptSignFlexible(publicKey, {
      usercode: uid,
      username: uname,
      timestamp,
    });
  } catch (err) {
    return {
      packet: null,
      sign: "",
      skipped: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!sign) {
    return { packet: null, sign: "", skipped: true, reason: "sign 为空，跳过敲门" };
  }

  const packet = {
    machineid,
    user: String(user || uid),
    username: uname,
    usercode: uid,
    devicetype: deviceType || DEFAULTS.deviceType,
    identification: String(identification),
    timestamp,
    sign,
  };

  return { packet, sign, skipped: false };
}

/** 申请密钥 — identification "0", no RSA sign. Ops pushes public key via 企业微信. */
export async function applyKey(ctx, opts = {}) {
  const packet = buildApplyPacket({
    machineid: ctx.machineid,
    user: ctx.userid,
    username: ctx.username,
    usercode: ctx.usercode || ctx.userid,
    deviceType: ctx.deviceType,
    identification: "0",
  });
  const result = await sendUdp(packet, {
    host: ctx.udpHost,
    port: ctx.udpPort,
    waitReplyMs: opts.waitReplyMs ?? 0,
  });
  return { packet, ...result };
}

/** 请求授权 / silent knock / key update */
export async function authorizeKnock(ctx, { identification = "0", waitReplyMs = 0 } = {}) {
  const built = buildAuthPacket({
    machineid: ctx.machineid,
    user: ctx.userid,
    username: ctx.username,
    usercode: ctx.usercode || ctx.userid,
    deviceType: ctx.deviceType,
    publicKey: ctx.publicKey,
    identification,
  });

  if (built.skipped) {
    return { ...built, sent: false };
  }

  const result = await sendUdp(built.packet, {
    host: ctx.udpHost,
    port: ctx.udpPort,
    waitReplyMs,
  });

  return { ...built, ...result };
}

/**
 * Parse a possible key-update UDP reply into a public key string.
 * Best-effort: JSON `{ publicKey|publickey|key|cipher }` or PEM body.
 */
export function extractKeyFromReply(replyText) {
  if (!replyText || typeof replyText !== "string") return null;
  const text = replyText.trim();
  if (!text) return null;

  if (text.includes("BEGIN PUBLIC KEY") || text.includes("BEGIN RSA PUBLIC KEY")) {
    return text;
  }

  try {
    const json = JSON.parse(text);
    const candidate =
      json.publicKey ||
      json.publickey ||
      json.key ||
      json.cipher ||
      json.data?.publicKey ||
      json.data?.key ||
      null;
    if (candidate && typeof candidate === "string") return candidate.trim();
  } catch {
    // plain base64 blob?
    if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s+/g, "").length > 100) {
      return text;
    }
  }
  return null;
}
