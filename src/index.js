#!/usr/bin/env node
import { createServer } from "./server.js";

const port = Number(process.env.PORT || 3927);
const host = process.env.HOST || "127.0.0.1";

const app = createServer({ port, host });
const info = await app.listen();

console.log(`Finedo 网络授权小程序已启动`);
console.log(`  UI     ${info.url}`);
console.log(`  UDP    finedo.cn:30982`);
console.log(`  Probe  https://app.finedo.cn/spacheck.json`);
console.log(`  Data   ~/.finenet-auth/keys.json`);

const shutdown = async () => {
  console.log("\n正在退出…");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
