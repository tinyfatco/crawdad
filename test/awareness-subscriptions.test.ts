/**
 * Tests for the AwarenessSubscriptionPump.
 *
 * Run: npx tsx test/awareness-subscriptions.test.ts
 *
 * Covers: filter wildcard behavior, formatter cases, rate limiter
 * burst+coalesce, loop-guard auto-exclusion, malformed JSON ignored,
 * disabled subscription skipped.
 */

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { AwarenessEmitter } from "../src/awareness/emitter.js";
import {
	AwarenessSubscriptionPump,
	type SubscriptionConfig,
} from "../src/awareness/subscriptions.js";
import type { PlatformAdapter } from "../src/adapters/types.js";

const TEMP_DIR = "/tmp/awareness-subs-test-" + Date.now();
const AWARENESS_DIR = join(TEMP_DIR, "awareness");
const CONTEXT_FILE = join(AWARENESS_DIR, "context.jsonl");
const SUBS_FILE = join(AWARENESS_DIR, "subscriptions.json");

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.log(`  ✗ ${msg}`);
	}
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.log(`  ✗ ${msg}\n     expected: ${e}\n     actual:   ${a}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface FakeCall {
	channel: string;
	text: string;
}

function makeFakeAdapter(name: string, calls: FakeCall[]): PlatformAdapter {
	return {
		name,
		maxMessageLength: 4000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async (channel: string, text: string) => {
			calls.push({ channel, text });
			return "ts-" + Date.now();
		},
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => "ts",
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createContext: (() => ({})) as any,
		enqueueEvent: () => true,
	} as PlatformAdapter;
}

function userLine(channel: string, user: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id: "u-" + Math.random(),
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: [
				{
					type: "text",
					text: `[2026-01-01 00:00:00+00:00] [${channel}] [${user}]: ${text}`,
				},
			],
		},
	});
}

function assistantTextLine(text: string): string {
	return JSON.stringify({
		type: "message",
		id: "a-" + Math.random(),
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

function assistantToolCallLine(name: string): string {
	return JSON.stringify({
		type: "message",
		id: "tc-" + Math.random(),
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
		},
	});
}

function toolResultLine(isError: boolean, result: string): string {
	return JSON.stringify({
		type: "message",
		id: "tr-" + Math.random(),
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			content: [{ type: "toolResult", toolCallId: "tc1", result, isError }],
		},
	});
}

function setup(): {
	emitter: AwarenessEmitter;
	calls: FakeCall[];
	pump: AwarenessSubscriptionPump;
} {
	rmSync(TEMP_DIR, { recursive: true, force: true });
	mkdirSync(AWARENESS_DIR, { recursive: true });
	writeFileSync(CONTEXT_FILE, "");
	const emitter = new AwarenessEmitter(CONTEXT_FILE, 50);
	const calls: FakeCall[] = [];
	const adapter = makeFakeAdapter("telegram", calls);
	const pump = new AwarenessSubscriptionPump(TEMP_DIR, emitter, [adapter]);
	return { emitter, calls, pump };
}

function writeSubs(subs: SubscriptionConfig[]): void {
	writeFileSync(SUBS_FILE, JSON.stringify(subs));
}

async function appendAndWait(line: string, ms = 200): Promise<void> {
	appendFileSync(CONTEXT_FILE, line + "\n");
	await sleep(ms);
}

async function run(): Promise<void> {
	console.log(`\nawareness subscription pump tests (workspace: ${TEMP_DIR})\n`);

	// ----------------------------------------------------------------
	console.log("filter: wildcard (no filter) matches everything");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		await appendAndWait(assistantTextLine("hello"));
		await appendAndWait(userLine("web", "alex", "hi"));

		assertEq(calls.length, 2, "two messages dispatched");
		assertEq(calls[0].channel, "chat-A", "destination correct");
		assertEq(calls[0].text, "hello", "assistant text formatted as-is");
		assertEq(calls[1].text, "[alex] hi", "user text formatted with name prefix");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nfilter: roles=[assistant] excludes user messages");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([
			{
				id: "s1",
				adapter: "telegram",
				destination: "chat-A",
				filter: { roles: ["assistant"] },
			},
		]);
		pump.start();

		await appendAndWait(userLine("web", "alex", "hi"));
		await appendAndWait(assistantTextLine("hello"));

		assertEq(calls.length, 1, "only assistant dispatched");
		assertEq(calls[0].text, "hello", "got assistant text");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nfilter: contentTypes=[text] excludes toolCall");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([
			{
				id: "s1",
				adapter: "telegram",
				destination: "chat-A",
				filter: { contentTypes: ["text"] },
			},
		]);
		pump.start();

		await appendAndWait(assistantToolCallLine("bash"));
		await appendAndWait(assistantTextLine("done"));

		assertEq(calls.length, 1, "only text dispatched");
		assertEq(calls[0].text, "done", "got text content");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nformatter: each content type formats correctly");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		await appendAndWait(assistantToolCallLine("bash"));
		await appendAndWait(toolResultLine(false, "ok output"));
		await appendAndWait(toolResultLine(true, "permission denied\nstack..."));

		assertEq(calls.length, 3, "three messages");
		assertEq(calls[0].text, "→ bash", "tool call → arrow + name");
		assertEq(calls[1].text, "✓", "successful tool result → check");
		assertEq(calls[2].text, "❌ permission denied", "error tool result → first line");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nloop guard: messages from destination channel are excluded");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "telegram:123" }]);
		pump.start();

		// User message FROM the destination channel — should NOT be mirrored back
		await appendAndWait(userLine("telegram:123", "alex", "hi"));
		// User message from a different channel — should be mirrored
		await appendAndWait(userLine("web", "alex", "hello"));

		assertEq(calls.length, 1, "only the non-destination message dispatched");
		assertEq(calls[0].text, "[alex] hello", "from web channel");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nrate limiter: burst then coalesce");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		// Burst is 3 — fire 6 quickly. First 3 should pass, next 3 coalesce.
		for (let i = 0; i < 6; i++) {
			appendFileSync(CONTEXT_FILE, assistantTextLine("msg" + i) + "\n");
		}
		await sleep(300);

		assertEq(calls.length, 3, "burst of 3 dispatched immediately");
		assertEq(calls[0].text, "msg0", "first message");
		assertEq(calls[2].text, "msg2", "third message");

		// Wait for the coalesce flush (REFILL_INTERVAL_MS = 5000)
		await sleep(5200);
		assertEq(calls.length, 4, "coalesced overflow flushed as one message");
		assertEq(calls[3].text, "+3 more", "coalesce message format");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\ndisabled subscription is skipped");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([
			{ id: "s1", adapter: "telegram", destination: "chat-A", enabled: false },
		]);
		pump.start();

		await appendAndWait(assistantTextLine("hello"));
		assertEq(calls.length, 0, "nothing dispatched when disabled");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nmalformed JSON line is ignored");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		await appendAndWait("this is not json");
		await appendAndWait(assistantTextLine("after garbage"));

		assertEq(calls.length, 1, "garbage skipped, valid line dispatched");
		assertEq(calls[0].text, "after garbage", "valid line content");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nunknown adapter logs warning, doesn't crash");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "nonexistent", destination: "chat-A" }]);
		pump.start();
		await appendAndWait(assistantTextLine("hello"));
		assertEq(calls.length, 0, "no telegram calls (adapter not found)");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	rmSync(TEMP_DIR, { recursive: true, force: true });
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
