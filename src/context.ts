/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readdir, readFile, access } from "fs/promises";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * In trunk mode (channelNameMap provided), reads log.jsonl from ALL Slack channel
 * directories in the workspace and tags each message with its source channel.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl (or trunk dir)
 * @param excludeTs - Timestamp of current message (will be added via prompt(), not sync)
 * @param channelNameMap - For trunk mode: maps channel IDs to names for message tagging
 * @returns Number of messages synced
 */
export async function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeTs?: string,
	channelNameMap?: Map<string, string>,
): Promise<number> {
	const isTrunk = !!channelNameMap;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					normalized = normalized.replace(/^\[#[^\]]+\s*\|\s*[^\]]+\]\s*/, "");
					const attachmentsIdx = normalized.indexOf("\n\n<attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					const harnessIdx = normalized.indexOf("\n\n---\n[HARNESS]");
					if (harnessIdx !== -1) {
						normalized = normalized.substring(0, harnessIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							normalized = normalized.replace(/^\[#[^\]]+\s*\|\s*[^\]]+\]\s*/, "");
							const attachmentsIdx = normalized.indexOf("\n\n<attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							const harnessIdx = normalized.indexOf("\n\n---\n[HARNESS]");
							if (harnessIdx !== -1) {
								normalized = normalized.substring(0, harnessIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Collect log files to read
	const logFiles: Array<{ path: string; channelId?: string }> = [];

	if (isTrunk) {
		// Trunk mode: read log.jsonl from all Slack channel subdirectories
		// Uses async I/O to avoid blocking the event loop on s3fs mounts
		const workspaceDir = join(channelDir, "..");
		try {
			const entries = await readdir(workspaceDir, { withFileTypes: true });
			const checks = entries
				.filter((entry) => entry.isDirectory() && /^[CDG]/.test(entry.name))
				.map(async (entry) => {
					const logPath = join(workspaceDir, entry.name, "log.jsonl");
					try {
						await access(logPath);
						return { path: logPath, channelId: entry.name };
					} catch {
						return null;
					}
				});
			const results = await Promise.all(checks);
			for (const r of results) {
				if (r) logFiles.push(r);
			}
		} catch {
			// Workspace dir doesn't exist yet — no logs to sync
		}
	} else {
		// Single channel mode — sync, fine for local file
		const logFile = join(channelDir, "log.jsonl");
		if (existsSync(logFile)) {
			logFiles.push({ path: logFile });
		}
	}

	if (logFiles.length === 0) return 0;

	// Read all log files in parallel (critical for s3fs where each read is an HTTP round-trip)
	const PER_FILE_TIMEOUT = 5000;
	const fileReads = logFiles.map(async ({ path: logFile, channelId }) => {
		try {
			const content = await Promise.race([
				readFile(logFile, "utf-8"),
				new Promise<string>((_, reject) =>
					setTimeout(() => reject(new Error(`timeout reading ${logFile}`)), PER_FILE_TIMEOUT),
				),
			]);
			return { content, channelId };
		} catch {
			return null; // Skip files that fail or timeout
		}
	});
	const fileResults = await Promise.all(fileReads);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const result of fileResults) {
		if (!result) continue;
		const { content: logContent, channelId: sourceChannelId } = result;
		const logLines = logContent.trim().split("\n").filter(Boolean);

		for (const line of logLines) {
			try {
				const logMsg: LogMessage = JSON.parse(line);

				const msgTs = logMsg.ts;
				const date = logMsg.date;
				if (!msgTs || !date) continue;

				if (excludeTs && msgTs === excludeTs) continue;
				if (logMsg.isBot) continue;

				const userName = logMsg.userName || logMsg.user || "unknown";
				let messageText: string;

				if (isTrunk && sourceChannelId) {
					const channelName = channelNameMap!.get(sourceChannelId) || sourceChannelId;
					messageText = `[#${channelName} | ${sourceChannelId}] [${userName}]: ${logMsg.text || ""}`;
				} else {
					messageText = `[${userName}]: ${logMsg.text || ""}`;
				}

				const normalized = messageText.replace(/^\[#[^\]]+\s*\|\s*[^\]]+\]\s*/, "");
				if (existingMessages.has(normalized)) continue;

				const msgTime = new Date(date).getTime() || Date.now();
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: messageText }],
					timestamp: msgTime,
				};

				newMessages.push({ timestamp: msgTime, message: userMessage });
				existingMessages.add(normalized);
			} catch {
				// Skip malformed lines
			}
		}
	}

	if (newMessages.length === 0) return 0;

	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	const MAX_TRUNK_SYNC = 50;
	const toSync = isTrunk && newMessages.length > MAX_TRUNK_SYNC
		? newMessages.slice(-MAX_TRUNK_SYNC)
		: newMessages;

	for (const { message } of toSync) {
		sessionManager.appendMessage(message);
	}

	return toSync.length;
}

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
}

const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export class MomSettingsManager {
	private settingsPath: string;
	private settings: MomSettings;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): MomSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MomCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getHookPaths(): string[] {
		return []; // Mom doesn't use hooks
	}

	getHookTimeout(): number {
		return 30000;
	}

	getImageAutoResize(): boolean {
		return false; // Mom doesn't auto-resize images
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	getTheme(): string | undefined {
		return undefined;
	}

	reload(): void {
		this.settings = this.load();
	}
}
