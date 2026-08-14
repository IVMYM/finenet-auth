import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { SpaClient } from "./spa/client.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let path = req.url?.split("?")[0] || "/";
  if (path === "/") path = "/index.html";
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(file));
}

export function createServer(options = {}) {
  const client = options.client || new SpaClient(options);
  const port = options.port ?? Number(process.env.PORT || 3927);
  const host = options.host || "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const { pathname } = url;

      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname, client);
        return;
      }
      serveStatic(req, res);
    } catch (err) {
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return {
    client,
    server,
    port,
    host,
    async listen() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      // Startup probe + auto knock when key exists
      client.autoKnockIfPossible().catch(() => client.probe().catch(() => {}));
      return { host, port, url: `http://${host}:${port}` };
    },
    close() {
      client.stop();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleApi(req, res, pathname, client) {
  const method = req.method || "GET";

  if (pathname === "/api/status" && method === "GET") {
    return json(res, 200, { ok: true, ...client.snapshot() });
  }

  if (pathname === "/api/probe" && method === "POST") {
    const state = await client.probe();
    return json(res, 200, { ok: true, state, snapshot: client.snapshot() });
  }

  if (pathname === "/api/profile" && method === "POST") {
    const body = await readBody(req);
    const profile = client.setProfile(body);
    return json(res, 200, { ok: true, profile, snapshot: client.snapshot() });
  }

  if (pathname === "/api/key" && method === "POST") {
    const body = await readBody(req);
    const row = client.savePublicKey(body.publicKey || body.key || "");
    return json(res, 200, { ok: true, key: { userid: row.userid, updatedAt: row.updatedAt }, snapshot: client.snapshot() });
  }

  if (pathname === "/api/apply" && method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (body.userid || body.username) {
      client.setProfile({
        userid: body.userid || client.getProfile()?.userid,
        username: body.username || client.getProfile()?.username,
        usercode: body.usercode,
      });
    }
    const result = await client.applyForKey();
    return json(res, 200, { ok: true, result: { sent: result.sent, bytes: result.bytes }, snapshot: client.snapshot() });
  }

  if (pathname === "/api/authorize" && method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (body.publicKey || body.key) {
      client.savePublicKey(body.publicKey || body.key);
    }
    if (body.userid || body.username) {
      client.setProfile({
        userid: body.userid || client.getProfile()?.userid,
        username: body.username || client.getProfile()?.username,
        usercode: body.usercode,
      });
    }
    const result = await client.requestAuth();
    return json(res, 200, {
      ok: !result.skipped,
      result: {
        sent: result.sent,
        skipped: result.skipped,
        reason: result.reason,
        bytes: result.bytes,
      },
      snapshot: client.snapshot(),
    });
  }

  if (pathname === "/api/keepalive" && method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (body.action === "stop") client.keepAlive.stop();
    else client.keepAlive.start();
    return json(res, 200, { ok: true, snapshot: client.snapshot() });
  }

  json(res, 404, { ok: false, error: "unknown api" });
}
