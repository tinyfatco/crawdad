/**
 * AwarenessEmitter — tails awareness/context.jsonl and emits each new line.
 *
 * Lifted from gateway.ts startAwarenessWatcher. SSE clients and the
 * subscription pump are both subscribers. Reference-counted: the underlying
 * setInterval only runs while at least one subscriber is attached.
 */

import { closeSync, openSync, readSync, statSync } from "fs";
import * as log from "../log.js";

export type AwarenessLineListener = (line: string) => void;

export class AwarenessEmitter {
	private contextFile: string;
	private listeners = new Set<AwarenessLineListener>();
	private watcher: ReturnType<typeof setInterval> | null = null;
	private fileSize = 0;
	private partial = "";
	private pollMs: number;

	constructor(contextFile: string, pollMs = 500) {
		this.contextFile = contextFile;
		this.pollMs = pollMs;
	}

	/** Add a listener. Starts the underlying poller if this is the first one. */
	on(listener: AwarenessLineListener): void {
		this.listeners.add(listener);
		if (this.listeners.size === 1) {
			this.startWatcher();
		}
	}

	/** Remove a listener. Stops the poller when the last one detaches. */
	off(listener: AwarenessLineListener): void {
		this.listeners.delete(listener);
		if (this.listeners.size === 0 && this.watcher) {
			clearInterval(this.watcher);
			this.watcher = null;
		}
	}

	/** Stop the poller and drop all listeners. */
	stop(): void {
		if (this.watcher) {
			clearInterval(this.watcher);
			this.watcher = null;
		}
		this.listeners.clear();
	}

	private startWatcher(): void {
		// Initialize fileSize to current size so we only emit *new* lines.
		try {
			this.fileSize = statSync(this.contextFile).size;
		} catch {
			this.fileSize = 0;
		}
		this.partial = "";

		this.watcher = setInterval(() => {
			try {
				const newSize = statSync(this.contextFile).size;
				if (newSize === this.fileSize) return;
				if (newSize < this.fileSize) {
					// File was truncated/rotated — reset
					this.fileSize = newSize;
					this.partial = "";
					return;
				}

				const fd = openSync(this.contextFile, "r");
				const buf = Buffer.alloc(newSize - this.fileSize);
				readSync(fd, buf, 0, buf.length, this.fileSize);
				closeSync(fd);
				this.fileSize = newSize;

				const chunk = this.partial + buf.toString("utf-8");
				const lastNewline = chunk.lastIndexOf("\n");
				if (lastNewline === -1) {
					this.partial = chunk;
					return;
				}
				this.partial = chunk.slice(lastNewline + 1);
				const complete = chunk.slice(0, lastNewline);
				const lines = complete.split("\n").filter(Boolean);

				for (const line of lines) {
					for (const listener of this.listeners) {
						try {
							listener(line);
						} catch (err) {
							log.logWarning(`[awareness-emitter] listener threw: ${err}`);
						}
					}
				}
			} catch {
				// File gone or read error — skip this tick
			}
		}, this.pollMs);
	}
}
