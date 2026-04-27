#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "companion/dist/mcp-stdio.cjs");

const child = spawn(process.execPath, [entry], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const got = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      got.push(JSON.parse(line));
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[child] ${c}`));

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    },
  });
  await sleep(300);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(200);
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await sleep(800);

  const init = got.find((m) => m.id === 1);
  const list = got.find((m) => m.id === 2);
  const tools = (list?.result?.tools ?? []).map((t) => t.name).sort();

  console.log("INIT.serverInfo:", init?.result?.serverInfo);
  console.log("TOOLS:", tools.join(", "));

  const expected = [
    "get_pending_session",
    "get_screenshot",
    "get_session",
    "mark_session_applying",
    "mark_session_done",
    "mark_session_error",
  ];
  const ok = JSON.stringify(tools) === JSON.stringify(expected);
  console.log(ok ? "OK" : "MISMATCH");
  child.kill();
  process.exit(ok ? 0 : 1);
})();
