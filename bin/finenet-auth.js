#!/usr/bin/env node
/**
 * FineNet Auth CLI
 *
 *   finenet-auth                 # start local UI
 *   finenet-auth status          # probe spacheck.json
 *   finenet-auth apply           # 申请密钥
 *   finenet-auth authorize       # 请求授权 (needs saved key)
 *   finenet-auth set-profile     # save userid/username
 *   finenet-auth set-key         # save public key from stdin / --key
 */
import { readFileSync } from "node:fs";
import { SpaClient } from "../src/spa/client.js";
import { createServer } from "../src/server.js";

function usage() {
  console.log(`Finedo 网络授权 (FineNet Auth)

Usage:
  finenet-auth                      Start local UI (default :3927)
  finenet-auth status               Probe 已授权 / 未授权
  finenet-auth diagnose             Check spacheck / app / git (解释 403)
  finenet-auth set-profile --user ID --name NAME
  finenet-auth set-key [--key PEM]  Save WeCom public key (or stdin)
  finenet-auth apply                Send 申请密钥 (identification=0)
  finenet-auth authorize            Send 请求授权 knock
  finenet-auth serve [--port N]     Same as default start
`);
}

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

function has(flag, argv) {
  return argv.includes(flag);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "serve" || cmd === "ui" || cmd === "start") {
    const port = Number(arg("--port", argv) || process.env.PORT || 3927);
    const host = arg("--host", argv) || process.env.HOST || "127.0.0.1";
    const app = createServer({ port, host });
    const info = await app.listen();
    console.log(`FineNet Auth UI → ${info.url}`);
    process.on("SIGINT", async () => {
      await app.close();
      process.exit(0);
    });
    return;
  }

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  const client = new SpaClient();

  if (cmd === "status") {
    const state = await client.probe();
    console.log(state.status);
    console.log(JSON.stringify(state, null, 2));
    process.exit(state.authorized ? 0 : 2);
  }

  if (cmd === "diagnose") {
    const diag = await client.diagnose();
    console.log(diag.status);
    for (const h of diag.hosts) {
      console.log(
        `- ${h.name.padEnd(9)} HTTP ${h.httpStatus || "—"}  dns=${h.dns || "—"}  public=${h.publicDns || "—"}  ${h.hint || h.error || ""}`
      );
    }
    if (diag.udp) {
      console.log(
        `- udp       ${diag.udp.host}:${diag.udp.port}  sent=${diag.udp.sent}  ${diag.udp.hint || diag.udp.error || ""}`
      );
    }
    if (diag.advice?.length) {
      console.log("\n建议:");
      for (const line of diag.advice) console.log(`  • ${line}`);
    }
    console.log("\n" + JSON.stringify(diag, null, 2));
    process.exit(diag.authorized ? 0 : 2);
  }

  if (cmd === "set-profile") {
    const userid = arg("--user", argv) || arg("--userid", argv);
    const username = arg("--name", argv) || arg("--username", argv);
    if (!userid || !username) {
      console.error("Need --user and --name");
      process.exit(1);
    }
    const profile = client.setProfile({ userid, username, usercode: userid });
    console.log(JSON.stringify(profile, null, 2));
    return;
  }

  if (cmd === "set-key") {
    let key = arg("--key", argv);
    if (!key && !process.stdin.isTTY) {
      key = readFileSync(0, "utf8");
    }
    if (!key) {
      console.error("Provide --key or pipe PEM on stdin");
      process.exit(1);
    }
    const row = client.savePublicKey(key);
    console.log(JSON.stringify({ userid: row.userid, updatedAt: row.updatedAt }, null, 2));
    return;
  }

  if (cmd === "apply") {
    const result = await client.applyForKey();
    console.log(JSON.stringify({ sent: result.sent, bytes: result.bytes }, null, 2));
    return;
  }

  if (cmd === "authorize") {
    const result = await client.requestAuth();
    console.log(
      JSON.stringify(
        { sent: result.sent, skipped: result.skipped, reason: result.reason, bytes: result.bytes },
        null,
        2
      )
    );
    // Give probe a moment
    await new Promise((r) => setTimeout(r, 1200));
    const state = await client.probe();
    console.log(state.status);
    process.exit(state.authorized ? 0 : 2);
  }

  if (has("--help", argv)) {
    usage();
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
