import type { Attachment, ChannelStore } from "../store.js";

// ============================================================================
// Platform-agnostic types for mom adapters
// ============================================================================

/**
 * An incoming message event from any platform.
 * Adapters translate platform-specific events into this shape.
 */
export interface MomEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logging) */
	attachments?: Attachment[];
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

/**
 * The context object passed to the agent for each run.
 * Platform-agnostic — adapters create this from their platform primitives.
 */
export interface MomContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

/**
 * Handler interface that adapters call into when messages arrive.
 */
export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: MomEvent, adapter: PlatformAdapter, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, adapter: PlatformAdapter): Promise<void>;
}

/**
 * Platform adapter interface. Each platform (Slack, Telegram, etc.)
 * implements this to connect mom to that platform.
 */
export interface PlatformAdapter {
	/** Adapter name (e.g., "slack", "telegram") */
	readonly name: string;

	/** Maximum message length for this platform */
	readonly maxMessageLength: number;

	/** Platform-specific formatting instructions for the system prompt */
	readonly formatInstructions: string;

	/** Start the adapter (connect to platform) */
	start(): Promise<void>;

	/** Stop the adapter */
	stop(): Promise<void>;

	// -- Message operations --

	postMessage(channel: string, text: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	postInThread(channel: string, threadTs: string, text: string): Promise<string>;
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;

	// -- Logging --

	logToFile(channel: string, entry: object): void;
	logBotResponse(channel: string, text: string, ts: string): void;

	// -- Metadata --

	getUser(userId: string): { id: string; userName: string; displayName: string } | undefined;
	getChannel(channelId: string): { id: string; name: string } | undefined;
	getAllUsers(): Array<{ id: string; userName: string; displayName: string }>;
	getAllChannels(): Array<{ id: string; name: string }>;

	// -- Context creation --

	createContext(event: MomEvent, store: ChannelStore, isEvent?: boolean): MomContext;

	// -- Event queue --

	enqueueEvent(event: MomEvent): boolean;
}
