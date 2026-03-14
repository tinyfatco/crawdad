import { existsSync, mkdirSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string; // original filename from uploader
	local: string; // path relative to working dir (e.g., "attachments/1732531234567_file.png")
}

export interface LoggedMessage {
	date: string; // ISO 8601 date
	ts: string; // slack timestamp or epoch ms
	channel: string; // human-readable channel label (e.g., "slack:#general")
	channelId: string; // raw platform channel ID
	user: string; // user ID (or "bot" for bot responses)
	userName?: string; // handle (e.g., "mario")
	displayName?: string; // display name (e.g., "Mario Zechner")
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string; // needed for authenticated file downloads
}

interface PendingDownload {
	localPath: string; // relative path
	url: string;
}

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private isDownloading = false;
	// Track recently logged message timestamps to prevent duplicates
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Generate a unique local filename for an attachment
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// Convert slack timestamp (1234567890.123456) to milliseconds
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// Sanitize original name (remove problematic characters)
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * Process attachments from a Slack message event.
	 * Saves to shared attachments directory.
	 */
	processAttachments(
		_channelId: string,
		files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;
			if (!file.name) {
				log.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// Queue for background download
			this.pendingDownloads.push({ localPath, url });
		}

		// Trigger background download
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * Log a message to the unified workspace log.jsonl.
	 * Returns false if message was already logged (duplicate).
	 */
	async logMessage(message: LoggedMessage): Promise<boolean> {
		// Check for duplicate (same channel + timestamp)
		const dedupeKey = `${message.channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false; // Already logged
		}

		// Mark as logged and schedule cleanup after 60 seconds
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.workingDir, "log.jsonl");

		// Ensure message has a date field
		if (!message.date) {
			let date: Date;
			if (message.ts.includes(".")) {
				date = new Date(parseFloat(message.ts) * 1000);
			} else {
				date = new Date(parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * Log a bot response to the unified log.
	 */
	async logBotResponse(channel: string, channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage({
			date: new Date().toISOString(),
			ts,
			channel,
			channelId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Process the download queue in the background
	 */
	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item.localPath, item.url);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log.logWarning(`Failed to download attachment`, `${item.localPath}: ${errorMsg}`);
			}
		}

		this.isDownloading = false;
	}

	/**
	 * Download a single attachment to the shared attachments directory
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// Ensure attachments directory exists
		const dir = join(this.workingDir, "attachments");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}
