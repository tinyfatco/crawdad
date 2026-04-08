/**
 * Context management for mom.
 *
 * Provides:
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 *
 * The sync layer (syncLogToSessionManager) was removed in the unified awareness
 * rearchitecture. The runner is now the sole writer to context.jsonl — no sync needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * Fraction of the current model's context window at which auto-compaction
	 * should fire. 0.5 = compact when context hits 50% full. Translated to
	 * `reserveTokens` at call time using the current model's contextWindow,
	 * so a single setting works across models with different window sizes.
	 */
	thresholdPercent: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MomSpontaneitySettings {
	enabled: boolean;
	level: 1 | 2 | 3 | 4 | 5;
	spontaneity: number; // 0-1, scales jitter window
	intervalMinutes: number;
	quietHours: { start: string; end: string };
	timezone?: string; // IANA timezone, defaults to system
}

export interface MomVerboseSettings {
	default?: boolean;
	[platform: string]: boolean | Record<string, boolean> | undefined;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	verbose?: boolean | MomVerboseSettings;
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
	spontaneity?: Partial<MomSpontaneitySettings>;
}

const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	thresholdPercent: 0.5,
};

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/** Level → base interval in minutes */
const SPONTANEITY_LEVELS: Record<number, number> = {
	1: 1440,  // ~once a day
	2: 420,   // ~every 6-8 hours
	3: 180,   // ~every 2-3 hours
	4: 90,    // ~every 1-2 hours
	5: 45,    // ~every 30-60 minutes
};

const DEFAULT_SPONTANEITY: MomSpontaneitySettings = {
	enabled: true,
	level: 3,
	spontaneity: 0.3,
	intervalMinutes: 180,
	quietHours: { start: "23:00", end: "07:00" },
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

	getSpontaneitySettings(): MomSpontaneitySettings {
		const s = this.settings.spontaneity || {};
		const level = s.level ?? DEFAULT_SPONTANEITY.level;
		const intervalFromLevel = SPONTANEITY_LEVELS[level] ?? DEFAULT_SPONTANEITY.intervalMinutes;
		return {
			enabled: s.enabled ?? DEFAULT_SPONTANEITY.enabled,
			level,
			spontaneity: s.spontaneity ?? DEFAULT_SPONTANEITY.spontaneity,
			intervalMinutes: s.intervalMinutes ?? intervalFromLevel,
			quietHours: s.quietHours ?? DEFAULT_SPONTANEITY.quietHours,
			timezone: s.timezone,
		};
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

	getVerbose(channelId: string, platform?: string): boolean {
		const v = this.settings.verbose;
		// Legacy bare boolean
		if (typeof v === "boolean") return v;
		// No verbose config at all
		if (!v) return true;
		// Check platform bucket for channel override
		if (platform) {
			const bucket = v[platform];
			if (bucket && typeof bucket === "object" && channelId in bucket) {
				return (bucket as Record<string, boolean>)[channelId];
			}
		}
		// Fall back to default
		return v.default !== false; // default true
	}

	setChannelVerbose(channelId: string, platform: string, value: boolean | null): void {
		let v = this.settings.verbose;
		// Migrate bare boolean to object form
		if (typeof v === "boolean" || !v) {
			v = { default: typeof v === "boolean" ? v : true };
			this.settings.verbose = v;
		}
		if (!v[platform] || typeof v[platform] !== "object") {
			(v as any)[platform] = {};
		}
		const bucket = v[platform] as Record<string, boolean>;
		if (value === null) {
			delete bucket[channelId];
		} else {
			bucket[channelId] = value;
		}
		this.save();
	}

	setVerboseDefault(value: boolean): void {
		let v = this.settings.verbose;
		if (typeof v === "boolean" || !v) {
			v = { default: value };
			this.settings.verbose = v;
		} else {
			v.default = value;
		}
		this.save();
	}

	getVerboseDefault(): boolean {
		const v = this.settings.verbose;
		if (typeof v === "boolean") return v;
		if (!v) return true;
		return v.default !== false;
	}

	getChannelVerboseOverride(channelId: string, platform: string): boolean | null {
		const v = this.settings.verbose;
		if (typeof v === "boolean" || !v) return null;
		const bucket = v[platform];
		if (bucket && typeof bucket === "object" && channelId in bucket) {
			return (bucket as Record<string, boolean>)[channelId];
		}
		return null;
	}

	reload(): void {
		this.settings = this.load();
	}
}
