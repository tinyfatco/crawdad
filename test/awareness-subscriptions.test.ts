/**
 * Tests for the AwarenessSubscriptionPump.
 *
 * Run: npx tsx test/awareness-subscriptions.test.ts
 *
 * Covers: mode=mirror (default) covers all message types, mode=responses
 * filters to assistant text only, formatter cases, rate limiter burst+
 * coalesce, loop guard, malformed JSON, disabled, unknown adapter.
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

function assistantThinkingLine(text: string): string {
	return JSON.stringify({
		type: "message",
		id: "th-" + Math.random(),
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
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

function setup(opts: { bucketBurst?: number; refillIntervalMs?: number } = {}): {
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
	// Default to a huge burst so non-rate-limit tests aren't perturbed by it.
	const pump = new AwarenessSubscriptionPump(TEMP_DIR, emitter, [adapter], {
		bucketBurst: opts.bucketBurst ?? 1000,
		refillIntervalMs: opts.refillIntervalMs ?? 5_000,
	});
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
	console.log("mode=mirror (default): covers user, assistant text, thinking, tool call, tool result");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		await appendAndWait(userLine("web", "alex", "hi"));
		await appendAndWait(assistantThinkingLine("let me think about this\nmultiline reasoning"));
		await appendAndWait(assistantToolCallLine("bash"));
		await appendAndWait(toolResultLine(false, "done"));
		await appendAndWait(assistantTextLine("hello"));

		assertEq(calls.length, 5, "all 5 message types dispatched in mirror mode");
		assertEq(calls[0].text, "[alex] hi", "user");
		assertEq(calls[1].text, "💭 let me think about this", "thinking (first line)");
		assertEq(calls[2].text, "→ bash", "tool call");
		assertEq(calls[3].text, "✓", "tool result success");
		assertEq(calls[4].text, "hello", "assistant text");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nmode=responses: only assistant text dispatched");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([
			{ id: "s1", adapter: "telegram", destination: "chat-A", mode: "responses" },
		]);
		pump.start();

		await appendAndWait(userLine("web", "alex", "hi"));
		await appendAndWait(assistantThinkingLine("thinking..."));
		await appendAndWait(assistantToolCallLine("bash"));
		await appendAndWait(assistantTextLine("hello"));

		assertEq(calls.length, 1, "only assistant text dispatched");
		assertEq(calls[0].text, "hello", "got assistant text");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nformatter: error tool result shows first line");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		await appendAndWait(toolResultLine(true, "permission denied\nstack trace..."));

		assertEq(calls.length, 1, "one message");
		assertEq(calls[0].text, "❌ permission denied", "error → first line");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nloop guard: messages from destination channel are excluded");
	{
		const { emitter, calls, pump } = setup();
		writeSubs([{ id: "s1", adapter: "telegram", destination: "telegram:123" }]);
		pump.start();

		await appendAndWait(userLine("telegram:123", "alex", "hi from dest"));
		await appendAndWait(userLine("web", "alex", "hello from elsewhere"));

		assertEq(calls.length, 1, "only the non-destination message dispatched");
		assertEq(calls[0].text, "[alex] hello from elsewhere", "from web");
		pump.stop();
		emitter.stop();
	}

	// ----------------------------------------------------------------
	console.log("\nrate limiter: burst then coalesce");
	{
		// Use real-ish defaults: burst=3, but refill shortened to 500ms for fast tests.
		const { emitter, calls, pump } = setup({ bucketBurst: 3, refillIntervalMs: 500 });
		writeSubs([{ id: "s1", adapter: "telegram", destination: "chat-A" }]);
		pump.start();

		for (let i = 0; i < 6; i++) {
			appendFileSync(CONTEXT_FILE, assistantTextLine("msg" + i) + "\n");
		}
		await sleep(200);

		assertEq(calls.length, 3, "burst of 3 dispatched immediately");
		assertEq(calls[0].text, "msg0", "first message");
		assertEq(calls[2].text, "msg2", "third message");

		await sleep(700);
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
