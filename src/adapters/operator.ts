/**
 * OperatorAdapter — headless inbound adapter for the Agency MCP.
 *
 * This is the container-side twin of the Agency MCP dispatcher on crawdad-cf.
 * The worker authenticates operator requests and proxies them to four
 * internal HTTP endpoints on the container gateway (port 3002):
 *
 *   GET  /operator/read       — proxies to /awareness/backlog
 *   POST /operator/message    — appends awareness line, triggers heartbeat-style run
 *   POST /operator/assign     — writes BRIEF.md, appends awareness, triggers run
 *   POST /operator/configure  — edits settings.json for whitelisted targets
 *
 * Auth: none at the container level. crawdad-cf is the only ingress and it
 * authenticates everything upstream. Matches the pattern used by /mcp today.
 *
 * Awareness semantics: operator writes a durable entry to
 * `awareness/context.jsonl` tagged with channel `operator:control`, role
 * `user`, speaker `operator`, so the entry is visible to `read` and the
 * runner picks it up as part of the transcript. The triggered run gets a
 * short prompt telling the agent the operator channel has new content.
 *
 * Steering: if a run is active when an operator message arrives, we steer
 * into the current run instead of queueing. Assign/configure still trigger
 * a fresh heartbeat-style run (they're not conversational).
 *
 * Shape: modeled after HeartbeatAdapter (headless, no outbound). No post/
 * update/delete methods do anything — replies happen via the agent's
 * send_message_to_channel tool routing to whatever real adapter the operator
 * is watching from.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	UserInfo,
} from "./types.js";

export const OPERATOR_CHANNEL_ID = "operator";
const OPERATOR_CHANNEL_LABEL = "operator:control";
const OPERATOR_USER = "operator";

const CONTAINER_CONFIGURE_TARGETS = new Set([
	"model",
	"thinking_level",
	"heartbeat.interval",
	"heartbeat.enabled",
]);

interface AssignBody {
	title: string;
	spec: string;
	rubric: string;
	skill_packs?: string[];
	deadline?: string;
}

interface MessageBody {
	text: string;
}

interface ConfigureBody {
	target: string;
	value: unknown;
}

function nowIso(): string {
	return new Date().toISOString();
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw) return {} as T;
	return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string, description?: string): void {
	sendJson(res, status, { error, error_description: description ?? error });
}

export class OperatorAdapter implements PlatformAdapter {
	readonly name = "operator";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Operator Channel
You are receiving a message from the **operator channel**. Entries tagged \`operator\` in your awareness stream are principal instructions from the human or agent running your fleet — not user requests.

Treat operator messages with appropriate weight:
- A \`[operator message]\` is a direct instruction to you. Read it, decide, act.
- A \`[operator assigned brief: ...]\` entry means a new \`BRIEF.md\` has been written to your workspace. Read it and begin work.
- A \`[operator configured ...]\` entry means one of your settings changed. Usually you can just continue.

Replies to the operator happen through whatever channel you were already using with your principal (Telegram, Slack, email, etc.) via \`send_message_to_channel\`. The operator channel itself has no outbound path.`;

	private workingDir: string;
	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;

	constructor(config: { workingDir: string }) {
		this.workingDir = config.workingDir;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Operator adapter ready");
	}

	async stop(): Promise<void> {}

	// ========================================================================
	// Awareness write — durable entry in context.jsonl tagged as operator input
	// ========================================================================

	/**
	 * Append a durable entry to awareness/context.jsonl so `read` sees it and
	 * the runner picks it up on the next turn. Schema mirrors the helper used
	 * by slash commands (commands.ts:logSystemAction) so the transcript shape
	 * stays consistent.
	 */
	private writeAwareness(text: string): void {
		const contextFile = join(this.workingDir, "awareness", "context.jsonl");
		const entry = {
			type: "message",
			id: randomUUID().substring(0, 8),
			parentId: null,
			timestamp: nowIso(),
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: `[${nowIso()}] [${OPERATOR_CHANNEL_LABEL}] [${OPERATOR_USER}]: ${text}`,
					},
				],
			},
		};
		try {
			appendFileSync(contextFile, JSON.stringify(entry) + "\n");
		} catch (err) {
			log.logWarning(
				"[operator] Failed to append awareness entry",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// ========================================================================
	// Run trigger — steer if running, otherwise fire a fresh heartbeat-style run
	// ========================================================================

	private triggerRun(runPrompt: string): void {
		const event: MomEvent = {
			type: "dm",
			channel: OPERATOR_CHANNEL_ID,
			ts: String(Date.now()),
			user: OPERATOR_USER,
			text: runPrompt,
			attachments: [],
		};

		if (this.handler.isRunning(OPERATOR_CHANNEL_ID)) {
			// Already in the operator channel; steer into it.
			this.handler.handleSteer(event, this);
			return;
		}

		// If an unrelated channel is running, still steer into that run — the
		// operator is principal, and they should be able to break in.
		// handleSteer is a no-op unless a run is active, so we check first.
		const anyRunning = this.anyRunRunning();
		if (anyRunning) {
			this.handler.handleSteer(event, this);
			return;
		}

		this.enqueueEvent(event);
	}

	/**
	 * Best-effort check for any active run. The handler only exposes a
	 * channel-scoped isRunning, so we fall through to that for the operator
	 * channel and let handleSteer be a safe no-op if nothing is live.
	 */
	private anyRunRunning(): boolean {
		return this.handler.isRunning(OPERATOR_CHANNEL_ID);
	}

	// ========================================================================
	// HTTP dispatch — routed from the gateway
	// ========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const pathname = url.pathname;
		const method = req.method?.toUpperCase() ?? "GET";

		(async () => {
			try {
				if (pathname === "/operator/read" && method === "GET") {
					return this.handleRead(url, res);
				}
				if (pathname === "/operator/message" && method === "POST") {
					return this.handleMessage(req, res);
				}
				if (pathname === "/operator/assign" && method === "POST") {
					return this.handleAssign(req, res);
				}
				if (pathname === "/operator/configure" && method === "POST") {
					return this.handleConfigure(req, res);
				}
				sendError(res, 404, "not_found", `No operator route for ${method} ${pathname}`);
			} catch (err) {
				log.logWarning(
					"[operator] dispatch error",
					err instanceof Error ? err.message : String(err),
				);
				sendError(res, 500, "internal_error", err instanceof Error ? err.message : "unknown");
			}
		})();
	}

	// ------------------------------------------------------------------------
	// /operator/read
	// ------------------------------------------------------------------------

	private handleRead(url: URL, res: ServerResponse): void {
		const contextFile = join(this.workingDir, "awareness", "context.jsonl");
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
		const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;

		let allLines: string[] = [];
		try {
			if (existsSync(contextFile)) {
				allLines = readFileSync(contextFile, "utf-8").split("\n").filter(Boolean);
			}
		} catch (err) {
			log.logWarning(
				"[operator] read error",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "read_failed");
		}

		const total = allLines.length;
		const endIndex = before > 0 ? Math.min(before, total) : total;
		const startIndex = Math.max(0, endIndex - limit);
		const slice = allLines.slice(startIndex, endIndex);

		sendJson(res, 200, { lines: slice, total, offset: startIndex });
	}

	// ------------------------------------------------------------------------
	// /operator/message
	// ------------------------------------------------------------------------

	private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: MessageBody;
		try {
			body = await readJsonBody<MessageBody>(req);
		} catch {
			return sendError(res, 400, "invalid_request", "Body must be JSON");
		}

		if (!body.text || typeof body.text !== "string") {
			return sendError(res, 400, "invalid_request", "text is required");
		}

		this.writeAwareness(`[operator message] ${body.text}`);
		this.triggerRun(
			`The operator just sent you a message through the operator channel. Check your awareness stream for the latest \`[operator message]\` entry and respond or act on it.`,
		);

		sendJson(res, 200, {
			delivered_at: nowIso(),
			channel: OPERATOR_CHANNEL_ID,
			will_steer: true,
		});
	}

	// ------------------------------------------------------------------------
	// /operator/assign
	// ------------------------------------------------------------------------

	private async handleAssign(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: AssignBody;
		try {
			body = await readJsonBody<AssignBody>(req);
		} catch {
			return sendError(res, 400, "invalid_request", "Body must be JSON");
		}

		if (!body.title || !body.spec || !body.rubric) {
			return sendError(
				res,
				400,
				"invalid_request",
				"title, spec, and rubric are required",
			);
		}

		const briefPath = join(this.workingDir, "BRIEF.md");
		const briefMarkdown = this.renderBrief(body);
		try {
			writeFileSync(briefPath, briefMarkdown, "utf-8");
		} catch (err) {
			log.logWarning(
				"[operator] BRIEF.md write failed",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "write_failed");
		}

		this.writeAwareness(
			`[operator assigned brief: ${body.title}] BRIEF.md has been written to your workspace root.`,
		);
		this.triggerRun(
			`The operator just assigned you a new brief titled "${body.title}". BRIEF.md has been written to your workspace root. Read it and begin work.`,
		);

		sendJson(res, 200, {
			accepted_at: nowIso(),
			brief_path: "BRIEF.md",
			title: body.title,
		});
	}

	private renderBrief(body: AssignBody): string {
		const lines: string[] = [];
		lines.push(`# ${body.title}`);
		lines.push("");
		lines.push(`_Assigned by operator at ${nowIso()}_`);
		lines.push("");
		lines.push("## Spec");
		lines.push(body.spec.trim());
		lines.push("");
		lines.push("## Rubric");
		lines.push(body.rubric.trim());
		if (body.skill_packs && body.skill_packs.length > 0) {
			lines.push("");
			lines.push("## Skill Packs");
			for (const pack of body.skill_packs) lines.push(`- ${pack}`);
		}
		if (body.deadline) {
			lines.push("");
			lines.push("## Deadline");
			lines.push(body.deadline);
		}
		lines.push("");
		return lines.join("\n");
	}

	// ------------------------------------------------------------------------
	// /operator/configure
	// ------------------------------------------------------------------------

	private async handleConfigure(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: ConfigureBody;
		try {
			body = await readJsonBody<ConfigureBody>(req);
		} catch {
			return sendError(res, 400, "invalid_request", "Body must be JSON");
		}

		if (!body.target || typeof body.target !== "string") {
			return sendError(res, 400, "invalid_request", "target is required");
		}
		if (!("value" in body)) {
			return sendError(res, 400, "invalid_request", "value is required");
		}
		if (!CONTAINER_CONFIGURE_TARGETS.has(body.target)) {
			return sendError(
				res,
				400,
				"invalid_target",
				`target must be one of: ${Array.from(CONTAINER_CONFIGURE_TARGETS).join(", ")}`,
			);
		}

		const settingsPath = join(this.workingDir, "settings.json");
		let settings: Record<string, unknown> = {};
		try {
			if (existsSync(settingsPath)) {
				settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			}
		} catch (err) {
			log.logWarning(
				"[operator] settings.json read failed",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "settings_read_failed");
		}

		const previousValue = this.getNestedSetting(settings, body.target);
		this.setNestedSetting(settings, body.target, body.value);

		try {
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		} catch (err) {
			log.logWarning(
				"[operator] settings.json write failed",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "settings_write_failed");
		}

		this.writeAwareness(
			`[operator configured ${body.target} = ${JSON.stringify(body.value)}] (previously ${JSON.stringify(previousValue)})`,
		);

		// Settings changes take effect on next wake. Trigger a short
		// acknowledgement run so the agent notices the change without fully
		// restarting. For model changes, the new model won't be used until
		// the runner rebuilds — the operator should know that.
		this.triggerRun(
			`The operator just changed your \`${body.target}\` setting. The new value will take effect on your next wake. You may acknowledge briefly or carry on.`,
		);

		sendJson(res, 200, {
			edited: true,
			target: body.target,
			tier: "container",
			previous_value: previousValue,
			new_value: body.value,
			applied_at: nowIso(),
			note: "Settings changes take effect on next wake.",
		});
	}

	private getNestedSetting(
		settings: Record<string, unknown>,
		target: string,
	): unknown {
		const parts = target.split(".");
		let cursor: unknown = settings;
		for (const part of parts) {
			if (cursor && typeof cursor === "object" && part in (cursor as Record<string, unknown>)) {
				cursor = (cursor as Record<string, unknown>)[part];
			} else {
				return null;
			}
		}
		return cursor;
	}

	private setNestedSetting(
		settings: Record<string, unknown>,
		target: string,
		value: unknown,
	): void {
		const parts = target.split(".");
		let cursor: Record<string, unknown> = settings;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			const next = cursor[part];
			if (!next || typeof next !== "object") {
				cursor[part] = {};
			}
			cursor = cursor[part] as Record<string, unknown>;
		}
		cursor[parts[parts.length - 1]] = value;
	}

	// ========================================================================
	// PlatformAdapter interface — mostly no-ops (headless, no outbound)
	// ========================================================================

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		appendFileSync(
			join(this.workingDir, "log.jsonl"),
			`${JSON.stringify(entry)}\n`,
		);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: nowIso(),
			ts,
			channel: `${OPERATOR_CHANNEL_LABEL}:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getUser(_userId: string): UserInfo | undefined {
		return { id: OPERATOR_USER, userName: OPERATOR_USER, displayName: "Operator" };
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		if (channelId === OPERATOR_CHANNEL_ID) {
			return { id: OPERATOR_CHANNEL_ID, name: OPERATOR_CHANNEL_LABEL };
		}
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [{ id: OPERATOR_USER, userName: OPERATOR_USER, displayName: "Operator" }];
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: OPERATOR_CHANNEL_ID, name: OPERATOR_CHANNEL_LABEL }];
	}

	enqueueEvent(event: MomEvent): boolean {
		if (event.channel !== OPERATOR_CHANNEL_ID) return false;

		if (this.queue.length >= 8) {
			log.logWarning(
				`Operator queue full, discarding: ${event.text.substring(0, 50)}`,
			);
			return false;
		}

		this.queue.push(event);
		this.processQueue();
		return true;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				try {
					await this.handler.handleEvent(event, this, true);
				} catch (err) {
					log.logWarning(
						"Operator run failed",
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: OPERATOR_USER,
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: OPERATOR_CHANNEL_LABEL,
			channels: this.getAllChannels(),
			users: this.getAllUsers(),
			respond: async () => {},
			sendFinalResponse: async () => {},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			restartWorking: async () => {},
		};
	}
}
