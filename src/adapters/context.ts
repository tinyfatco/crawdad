import type { VerbosityLevel } from "../context.js";
import type { MomContext, MomEvent, UserInfo, ChannelInfo } from "./types.js";

// ============================================================================
// Shared two-message context for chat adapters (Telegram, Slack)
//
// Two-message pattern:
//   Message 1 (working): Accumulates status lines (thinking, tool arrows,
//                         interim text) in chronological order. Edited in place.
//   Message 2 (final):   Final response, posted as a NEW message so the
//                         platform sends a notification.
// ============================================================================

/**
 * Platform-specific operations that the shared context delegates to.
 * Each chat adapter implements this with its own API client + formatting.
 */
export interface PlatformOps {
	/** Post a new message, return its ID */
	post(channel: string, text: string): Promise<string>;
	/** Edit an existing message in place */
	update(channel: string, id: string, text: string): Promise<void>;
	/** Delete a message */
	delete(channel: string, id: string): Promise<void>;
	/** Format a status/tool line for the working message (e.g. <i>text</i> or _text_) */
	formatStatus(text: string): string;
	/** Minimum ms between edits (300 for Telegram rate limits, 0 for Slack) */
	throttleMs: number;
	/** Max message length for the platform */
	maxLength: number;
}

export interface TwoMessageConfig {
	/** The header line shown at top of working message (e.g. "Thinking" or "Starting event: foo") */
	headerLine: string;
	/** Event metadata */
	event: MomEvent;
	/** User/channel info for context */
	user?: UserInfo;
	channels: ChannelInfo[];
	users: UserInfo[];
	channelName?: string;
	/** Whether this is a scheduled event */
	isEvent?: boolean;
	/** Verbosity: true (full), false (no working msg), "messages-only" (no harness output at all) */
	verbose?: VerbosityLevel;
}

/**
 * Create a MomContext that implements the two-message pattern.
 * Used by Telegram and Slack adapters — other adapters (Web, Email, Heartbeat)
 * have simpler contexts and don't use this.
 */
export function createTwoMessageContext(
	ops: PlatformOps,
	config: TwoMessageConfig,
	callbacks?: {
		/** Called when working message is posted/updated (for adapter-specific side effects) */
		onWorkingUpdate?: (id: string) => void;
		/** Post to thread (Slack only — Telegram swallows these) */
		respondInThread?: (text: string) => Promise<void>;
		/** Log the bot's final response */
		logBotResponse?: (channel: string, text: string, ts: string) => void;
		/** Platform-specific typing indicator */
		sendTyping?: () => Promise<void>;
		/** Upload a file */
		uploadFile?: (filePath: string, title?: string) => Promise<void>;
		/** Delete the working + final messages (for [SILENT] handling) */
		deleteMessages?: (workingId: string | null, finalId: string | null) => Promise<void>;
	},
): MomContext {
	const { event, channels, users, channelName } = config;

	let workingMessageId: string | null = null;
	let finalMessageId: string | null = null;
	let isWorking = true;
	let updatePromise = Promise.resolve();

	// Chronological entries for the working message
	const workingEntries: string[] = [];

	// Pending text buffer: holds the latest shouldLog=true text until we know
	// whether it's interim (next event arrives → flush to working) or final
	// (sendFinalResponse arrives → send as Message 2, skip working entirely).
	let pendingText: string | null = null;

	// Throttle state (for Telegram rate limits)
	let lastEditTime = 0;
	let editTimer: ReturnType<typeof setTimeout> | null = null;
	let editDirty = false;

	// Build the working message display from all accumulated entries
	const buildWorkingDisplay = (): string => {
		const lines = [config.headerLine, ...workingEntries];
		let display = lines.join("\n");

		// Trim oldest entries if message exceeds platform limit
		const limit = ops.maxLength - 100;
		while (display.length > limit && workingEntries.length > 1) {
			workingEntries.shift();
			display = `${ops.formatStatus("... trimmed")}\n${[config.headerLine, ...workingEntries].join("\n")}`;
		}

		return isWorking ? display + " ..." : display;
	};

	const verbose = config.verbose !== false && config.verbose !== "messages-only"; // default true
	const messagesOnly = config.verbose === "messages-only";

	// Send or edit the working message (Message 1)
	const flushWorkingMessage = async () => {
		if (!verbose) return; // silent/messages-only mode — skip working message entirely
		const display = buildWorkingDisplay();
		if (workingMessageId) {
			await ops.update(event.channel, workingMessageId, display);
		} else {
			workingMessageId = await ops.post(event.channel, display);
		}
		lastEditTime = Date.now();
		editDirty = false;
		if (workingMessageId) callbacks?.onWorkingUpdate?.(workingMessageId);
	};

	const scheduleWorkingUpdate = async () => {
		if (ops.throttleMs === 0) {
			await flushWorkingMessage();
			return;
		}

		const elapsed = Date.now() - lastEditTime;
		if (elapsed >= ops.throttleMs) {
			if (editTimer) {
				clearTimeout(editTimer);
				editTimer = null;
			}
			await flushWorkingMessage();
		} else {
			editDirty = true;
			if (!editTimer) {
				editTimer = setTimeout(() => {
					editTimer = null;
					if (editDirty) {
						updatePromise = updatePromise.then(() => flushWorkingMessage());
					}
				}, ops.throttleMs - elapsed);
			}
		}
	};

	// Commit pendingText to the working message (proves it was interim, not final)
	const flushPendingText = async () => {
		if (pendingText !== null) {
			workingEntries.push(pendingText);
			pendingText = null;
			await scheduleWorkingUpdate();
		}
	};

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: config.user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName,
		channels: channels.map((c) => ({ id: c.id, name: c.name })),
		users: users.map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				// Tool labels (shouldLog=false, starts with _→) — append to working message
				if (!shouldLog && text.startsWith("_→")) {
					await flushPendingText();
					const label = text.replace(/^_/, "").replace(/_$/, "");
					workingEntries.push(ops.formatStatus(label));
					await scheduleWorkingUpdate();
					return;
				}

				// Status messages (shouldLog=false) — flush pending, refresh working message
				if (!shouldLog) {
					await flushPendingText();
					await scheduleWorkingUpdate();
					return;
				}

				// Real content (shouldLog=true) — buffer it. If something else arrives
				// before sendFinalResponse, flushPendingText proves it was interim.
				if (text.trim()) {
					await flushPendingText();
					pendingText = text;
				}
			});
			await updatePromise;
		},

		sendFinalResponse: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (!text.trim()) return;

				// messages-only: suppress harness-driven final response entirely.
				// Agent communicates only via send_message_to_channel.
				if (messagesOnly) {
					pendingText = null;
					return;
				}

				// Discard pendingText (it's the same text about to be sent as Message 2)
				pendingText = null;

				// Finalize the working message (remove spinner)
				if (workingMessageId) {
					if (editTimer) {
						clearTimeout(editTimer);
						editTimer = null;
					}
					await flushWorkingMessage();
				}

				// Post final response as a NEW message (Message 2) for notification
				finalMessageId = await ops.post(event.channel, text);
				callbacks?.logBotResponse?.(event.channel, text, finalMessageId);
			});
			await updatePromise;
		},

		respondInThread: callbacks?.respondInThread
			? async (text: string) => {
					updatePromise = updatePromise.then(async () => {
						await callbacks.respondInThread!(text);
					});
					await updatePromise;
				}
			: async () => {
					// No-op (Telegram swallows thread messages)
				},

		setTyping: async (isTyping: boolean) => {
			if (messagesOnly) return; // no harness-driven UI in messages-only
			if (isTyping && !workingMessageId) {
				updatePromise = updatePromise.then(async () => {
					if (!workingMessageId) {
						await callbacks?.sendTyping?.();
						await flushWorkingMessage();
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await callbacks?.uploadFile?.(filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (!working) {
					await flushPendingText();

					if (editTimer) {
						clearTimeout(editTimer);
						editTimer = null;
					}

					// Finalize working message — never delete, because on Slack
					// thread replies become orphaned tombstones if parent is deleted
					if (workingMessageId) {
						await flushWorkingMessage();
					}
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				if (editTimer) {
					clearTimeout(editTimer);
					editTimer = null;
				}
				if (callbacks?.deleteMessages) {
					await callbacks.deleteMessages(workingMessageId, finalMessageId);
				} else {
					if (workingMessageId) await ops.delete(event.channel, workingMessageId);
					if (finalMessageId) await ops.delete(event.channel, finalMessageId);
				}
				workingMessageId = null;
				finalMessageId = null;
			});
			await updatePromise;
		},

		restartWorking: async (newHeaderLine?: string) => {
			updatePromise = updatePromise.then(async () => {
				// Finalize the current working message
				await flushPendingText();
				if (editTimer) {
					clearTimeout(editTimer);
					editTimer = null;
				}
				isWorking = false;
				if (workingMessageId) {
					await flushWorkingMessage();
				}

				// Reset state for fresh working message
				workingMessageId = null;
				finalMessageId = null;
				workingEntries.length = 0;
				pendingText = null;
				isWorking = true;
				lastEditTime = 0;
				editDirty = false;

				// Update header if provided
				if (newHeaderLine) {
					config.headerLine = newHeaderLine;
				}
			});
			await updatePromise;
		},
	};
}
