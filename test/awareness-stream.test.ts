/**
 * Quick non-interactive test for the awareness stream SSE endpoint.
 *
 * Spins up a Gateway with a temp workspace, writes to context.jsonl,
 * and verifies the SSE stream delivers backlog + live updates.
 *
 * Run: npx tsx test/awareness-stream.test.ts
 */

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import http from "http";

const TEMP_DIR = "/tmp/awareness-stream-test-" + Date.now();
const AWARENESS_DIR = join(TEMP_DIR, "awareness");
const CONTEXT_FILE = join(AWARENESS_DIR, "context.jsonl");
const PORT = 19876;

// Test data
const line1 = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z" });
const line2 = JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "[2026-01-01 00:01:00+00:00] [web] [testuser]: hello" }] } });
const line3 = JSON.stringify({ type: "message", id: "m2", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } });

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function run() {
  // Setup temp workspace with existing context
  mkdirSync(AWARENESS_DIR, { recursive: true });
  writeFileSync(CONTEXT_FILE, line1 + "\n" + line2 + "\n");

  // Import and start gateway
  const { Gateway } = await import("../src/gateway.js");
  const gw = new Gateway({ workspaceDir: TEMP_DIR });
  await gw.start(PORT);

  console.log("Test 1: Backlog delivery");

  // Connect to SSE and collect events
  const events = await collectEvents(2, 3000);
  assert(events.length >= 2, `got ${events.length} backlog events (expected ≥2)`);
  assert(events[0].includes('"s1"'), "first event is session s1");
  assert(events[1].includes('"m1"'), "second event is message m1");

  console.log("\nTest 2: Live update delivery");

  // Start a new SSE connection, skip backlog, then append a new line
  const livePromise = collectEvents(3, 5000); // 2 backlog + 1 new
  await sleep(200); // Let connection establish and receive backlog
  appendFileSync(CONTEXT_FILE, line3 + "\n");
  const liveEvents = await livePromise;
  assert(liveEvents.length >= 3, `got ${liveEvents.length} total events (expected ≥3)`);
  const lastEvent = liveEvents[liveEvents.length - 1];
  assert(lastEvent.includes('"m2"'), "live event contains message m2");

  // Cleanup
  await gw.stop();
  rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function collectEvents(minCount: number, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const events: string[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const req = http.get(`http://localhost:${PORT}/awareness/stream`, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const match = part.match(/^data: (.+)$/m);
          if (match) {
            events.push(match[1]);
            if (events.length >= minCount) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
            }
          }
        }
      });
    });

    timer = setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
