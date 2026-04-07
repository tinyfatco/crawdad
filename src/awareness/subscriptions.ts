/**
 * AwarenessSubscriptionPump — dumb tap on the awareness stream.
 *
 * Reads awareness/subscriptions.json from the workspace, watches it for
 * changes, subscribes to the AwarenessEmitter, and pushes filtered+formatted
 * lines to outbound platform adapters via postMessage.
 *
 * Each subscription has a per-subscription token bucket (1 push / 5s, burst
 * 3). Overflow is coalesced into a "+N more" followup after the cooldown.
 *
 * Loop guard: a subscription's destination is auto-injected into its
 * excludeChannels filter so messages mirrored TO Telegram chat X aren't
 * mirrored back FROM Telegram chat X on the next reply.
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

export interface SubscriptionFilter {
	roles?: Array<"user" | "assistant" | "toolResult">;
	contentTypes?: Array<"text" | "thinking" | "toolCall" | "toolResult">;
	channels?: string[];
	excludeChannels?: string[];
}

export interface SubscriptionConfig {
	id: string;
	adapter: string;
	destination: string;
	filter?: SubscriptionFilter;
	enabled?: boolean;
}

interface BucketState {
	tokens: number;
	lastRefill: number;
	dropped: number;
	flushTimer: ReturnType<typeof setTimeout> | null;
}

const REFILL_INTERVAL_MS = 5_000;
const BUCKET_BURST = 3;

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

	constructor(workspaceDir: string, emitter: AwarenessEmitter, adapters: PlatformAdapter[]) {
		this.workspaceDir = workspaceDir;
		this.emitter = emitter;
		this.adapters = new Map(adapters.map((a) => [a.name, a]));
		this.configPath = resolve(workspaceDir, "awareness/subscriptions.json");
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
			// Watch the parent dir so we catch creates/deletes too
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
			if (!this.matches(entry, sub)) continue;
			const formatted = this.format(entry, sub);
			if (!formatted) continue;
			this.dispatch(sub, formatted);
		}
	}

	matches(entry: AwarenessEntry, sub: SubscriptionConfig): boolean {
		const filter = sub.filter || {};

		if (filter.roles && filter.roles.length > 0) {
			if (!entry.role || !filter.roles.includes(entry.role)) return false;
		}

		if (filter.channels && filter.channels.length > 0) {
			if (!entry.channel || !filter.channels.includes(entry.channel)) return false;
		}

		// Loop guard: auto-exclude the subscription's own destination channel.
		const excludes = new Set(filter.excludeChannels || []);
		excludes.add(sub.destination);
		if (entry.channel && excludes.has(entry.channel)) return false;

		if (filter.contentTypes && filter.contentTypes.length > 0) {
			if (!entry.content || !Array.isArray(entry.content)) return false;
			const allowed = filter.contentTypes;
			const hasMatchingType = entry.content.some((c) =>
				(allowed as string[]).includes(c.type),
			);
			if (!hasMatchingType) return false;
		}

		return true;
	}

	format(entry: AwarenessEntry, sub: SubscriptionConfig): string | null {
		if (!entry.content || !Array.isArray(entry.content)) return null;
		const allowedTypes = sub.filter?.contentTypes as string[] | undefined;

		const parts: string[] = [];
		for (const block of entry.content as ContentBlock[]) {
			if (allowedTypes && !allowedTypes.includes(block.type)) continue;
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

		// No tokens — coalesce into the dropped counter
		bucket.dropped += 1;
		if (!bucket.flushTimer) {
			const wait = REFILL_INTERVAL_MS;
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
			}, wait);
		}
	}

	private getBucket(id: string): BucketState {
		let b = this.buckets.get(id);
		if (!b) {
			b = { tokens: BUCKET_BURST, lastRefill: Date.now(), dropped: 0, flushTimer: null };
			this.buckets.set(id, b);
		}
		return b;
	}

	private refill(bucket: BucketState): void {
		const now = Date.now();
		const elapsed = now - bucket.lastRefill;
		if (elapsed >= REFILL_INTERVAL_MS) {
			const add = Math.floor(elapsed / REFILL_INTERVAL_MS);
			bucket.tokens = Math.min(BUCKET_BURST, bucket.tokens + add);
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
