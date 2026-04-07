/**
 * AwarenessSubscriptionPump — dumb tap on the awareness stream.
 *
 * Reads awareness/subscriptions.json from the workspace, watches it for
 * changes, subscribes to the AwarenessEmitter, and pushes formatted lines
 * to outbound platform adapters via postMessage.
 *
 * Each subscription has a per-subscription token bucket (1 push / 5s, burst
 * 3). Overflow is coalesced into a "+N more" followup after the cooldown.
 *
 * Loop guard: messages whose source channel matches the subscription's
 * destination are dropped, so a Telegram mirror doesn't bounce its own
 * pushes back on the next reply.
 *
 * Modes:
 *   "mirror"    — push every message line (default). Same content the web
 *                 awareness stream shows: user msgs, assistant text, thinking,
 *                 tool calls, tool results, heartbeats, emails.
 *   "responses" — push only assistant text. Quieter alternative.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "fs";
import { resolve } from "path";
import * as log from "../log.js";
import type { PlatformAdapter } from "../adapters/types.js";
import { AwarenessEmitter, type AwarenessLineListener } from "./emitter.js";
import {
	parseContextLine,
	type AwarenessEntry,
	type ContentBlock,
	type TextContent,
	type ToolCallContent,
	type ToolResultContent,
	type ThinkingContent,
} from "./parse.js";

export type SubscriptionMode = "mirror" | "responses";

export interface SubscriptionConfig {
	id: string;
	adapter: string;
	destination: string;
	mode?: SubscriptionMode;
	enabled?: boolean;
}

interface BucketState {
	tokens: number;
	lastRefill: number;
	dropped: number;
	flushTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_REFILL_INTERVAL_MS = 5_000;
const DEFAULT_BUCKET_BURST = 3;

export interface PumpOptions {
	refillIntervalMs?: number;
	bucketBurst?: number;
}

export class AwarenessSubscriptionPump {
	private workspaceDir: string;
	private emitter: AwarenessEmitter;
	private adapters: Map<string, PlatformAdapter>;
	private configPath: string;
	private subscriptions: SubscriptionConfig[] = [];
	private buckets = new Map<string, BucketState>();
	private listener: AwarenessLineListener | null = null;
	private fileWatcher: FSWatcher | null = null;
	private reloadDebounce: ReturnType<typeof setTimeout> | null = null;
	private refillIntervalMs: number;
	private bucketBurst: number;

	constructor(
		workspaceDir: string,
		emitter: AwarenessEmitter,
		adapters: PlatformAdapter[],
		options: PumpOptions = {},
	) {
		this.workspaceDir = workspaceDir;
		this.emitter = emitter;
		this.adapters = new Map(adapters.map((a) => [a.name, a]));
		this.configPath = resolve(workspaceDir, "awareness/subscriptions.json");
		this.refillIntervalMs = options.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;
		this.bucketBurst = options.bucketBurst ?? DEFAULT_BUCKET_BURST;
	}

	start(): void {
		this.loadConfig();
		this.listener = (line) => this.onLine(line);
		this.emitter.on(this.listener);
		this.watchConfig();
		log.logInfo(`[awareness-pump] started with ${this.subscriptions.length} subscription(s)`);
	}

	stop(): void {
		if (this.listener) {
			this.emitter.off(this.listener);
			this.listener = null;
		}
		if (this.fileWatcher) {
			this.fileWatcher.close();
			this.fileWatcher = null;
		}
		for (const bucket of this.buckets.values()) {
			if (bucket.flushTimer) clearTimeout(bucket.flushTimer);
		}
		this.buckets.clear();
	}

	private loadConfig(): void {
		if (!existsSync(this.configPath)) {
			this.subscriptions = [];
			return;
		}
		try {
			const raw = readFileSync(this.configPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				log.logWarning(`[awareness-pump] subscriptions.json is not an array — ignoring`);
				this.subscriptions = [];
				return;
			}
			this.subscriptions = parsed.filter(
				(s: unknown): s is SubscriptionConfig =>
					!!s &&
					typeof s === "object" &&
					typeof (s as SubscriptionConfig).id === "string" &&
					typeof (s as SubscriptionConfig).adapter === "string" &&
					typeof (s as SubscriptionConfig).destination === "string",
			);
		} catch (err) {
			log.logWarning(`[awareness-pump] failed to read subscriptions.json: ${err}`);
			this.subscriptions = [];
		}
	}

	private watchConfig(): void {
		try {
			const dir = resolve(this.workspaceDir, "awareness");
			if (!existsSync(dir)) return;
			this.fileWatcher = watch(dir, (_event, filename) => {
				if (filename !== "subscriptions.json") return;
				if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
				this.reloadDebounce = setTimeout(() => {
					this.loadConfig();
					log.logInfo(
						`[awareness-pump] reloaded config: ${this.subscriptions.length} subscription(s)`,
					);
				}, 200);
			});
		} catch (err) {
			log.logWarning(`[awareness-pump] could not watch subscriptions.json: ${err}`);
		}
	}

	private onLine(line: string): void {
		const entry = parseContextLine(line);
		if (!entry || entry.type !== "message") return;

		for (const sub of this.subscriptions) {
			if (sub.enabled === false) continue;

			// Loop guard: drop messages whose source channel is this sub's destination.
			if (entry.channel && entry.channel === sub.destination) continue;

			const mode = sub.mode || "mirror";
			if (mode === "responses" && entry.role !== "assistant") continue;

			const formatted = this.format(entry, mode);
			if (!formatted) continue;
			this.dispatch(sub, formatted);
		}
	}

	format(entry: AwarenessEntry, mode: SubscriptionMode): string | null {
		if (!entry.content || !Array.isArray(entry.content)) return null;

		const parts: string[] = [];
		for (const block of entry.content as ContentBlock[]) {
			if (mode === "responses") {
				if (entry.role !== "assistant" || block.type !== "text") continue;
			}
			const piece = this.formatBlock(entry, block);
			if (piece) parts.push(piece);
		}
		const text = parts.join("\n").trim();
		return text || null;
	}

	private formatBlock(entry: AwarenessEntry, block: ContentBlock): string | null {
		switch (block.type) {
			case "text": {
				const t = (block as TextContent).text?.trim();
				if (!t) return null;
				if (entry.role === "user") {
					const name = entry.userName || "user";
					const body = entry.strippedText || t;
					return `[${name}] ${body}`;
				}
				return t;
			}
			case "thinking": {
				const raw = (block as ThinkingContent).thinking?.trim();
				if (!raw) return null;
				const firstLine = raw.split("\n")[0];
				return `💭 ${firstLine}`;
			}
			case "toolCall": {
				const name = (block as ToolCallContent).name;
				return `→ ${name}`;
			}
			case "toolResult": {
				const tr = block as ToolResultContent;
				if (tr.isError) {
					const firstLine = (tr.result || "").split("\n")[0].trim() || "error";
					return `❌ ${firstLine}`;
				}
				return `✓`;
			}
		}
	}

	private dispatch(sub: SubscriptionConfig, text: string): void {
		const bucket = this.getBucket(sub.id);
		this.refill(bucket);

		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			this.send(sub, text);
			return;
		}

		bucket.dropped += 1;
		if (!bucket.flushTimer) {
			bucket.flushTimer = setTimeout(() => {
				bucket.flushTimer = null;
				const dropped = bucket.dropped;
				bucket.dropped = 0;
				if (dropped > 0) {
					this.refill(bucket);
					if (bucket.tokens >= 1) {
						bucket.tokens -= 1;
						this.send(sub, `+${dropped} more`);
					}
				}
			}, this.refillIntervalMs);
		}
	}

	private getBucket(id: string): BucketState {
		let b = this.buckets.get(id);
		if (!b) {
			b = { tokens: this.bucketBurst, lastRefill: Date.now(), dropped: 0, flushTimer: null };
			this.buckets.set(id, b);
		}
		return b;
	}

	private refill(bucket: BucketState): void {
		const now = Date.now();
		const elapsed = now - bucket.lastRefill;
		if (elapsed >= this.refillIntervalMs) {
			const add = Math.floor(elapsed / this.refillIntervalMs);
			bucket.tokens = Math.min(this.bucketBurst, bucket.tokens + add);
			bucket.lastRefill = now;
		}
	}

	private async send(sub: SubscriptionConfig, text: string): Promise<void> {
		const adapter = this.adapters.get(sub.adapter);
		if (!adapter) {
			log.logWarning(
				`[awareness-pump] subscription ${sub.id}: adapter "${sub.adapter}" not registered`,
			);
			return;
		}
		try {
			await adapter.postMessage(sub.destination, text);
		} catch (err) {
			log.logWarning(
				`[awareness-pump] subscription ${sub.id} postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
