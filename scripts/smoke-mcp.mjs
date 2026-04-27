#!/usr/bin/env node
// Smoke-test the pinta-mcp stdio server: initialize → tools/list → call
// get_pending_session (which long-polls but should return null fast since
// no session is queued for the current test).
//
// Usage: node scripts/smoke-mcp.mjs

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "companion/src/mcp-stdio.ts");

const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const child = spawn(process.execPath, [tsxCli, entry], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        responses.push(msg);
        process.stderr.write(`<- ${JSON.stringify(msg).slice(0, 200)}\n`);
      } catch (e) {
        process.stderr.write(`<- raw: ${line}\n`);
      }
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[child] ${c}`));

function send(obj) {
  const line = JSON.stringify(obj) + "\n";
  process.stderr.write(`-> ${line}`);
  child.stdin.write(line);
}

async function waitFor(predicate, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const m = responses.find(predicate);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for response`);
}

(async () => {
  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pinta-smoke", version: "0.0.1" },
    },
  });
  await waitFor((m) => m.id === 1);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await waitFor((m) => m.id === 2);
  const toolNames = (list.result?.tools ?? []).map((t) => t.name).sort();
  console.log("\n[smoke] tools:", JSON.stringify(toolNames));

  const expected = [
    "get_pending_session",
    "get_screenshot",
    "get_session",
    "mark_session_applying",
    "mark_session_done",
    "mark_session_error",
  ];
  const ok = JSON.stringify(toolNames) === JSON.stringify(expected);
  console.log(`[smoke] expected ${expected.length} tools: ${ok ? "OK" : "MISMATCH"}`);

  // 3. tools/call get_pending_session — should long-poll and return null
  // (no session queued). We pass through quickly to avoid the 25s wait.
  // Don't actually wait for the response; we just confirm the call doesn't
  // crash the server.
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_pending_session", arguments: {} },
  });

  // Give it a beat to send anything, then exit.
  await new Promise((r) => setTimeout(r, 1000));

  child.kill();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error("[smoke] error:", err.message);
  child.kill();
  process.exit(1);
});
