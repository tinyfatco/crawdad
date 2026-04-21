import { EventEmitter } from "events";

/**
 * AwarenessBus — in-process pub/sub for awareness entries.
 *
 * Replaces the 500ms file-poll SSE watcher. Any code that appends to
 * awareness/context.jsonl should also call bus.publish(line). The gateway's
 * /awareness/stream subscribes and forwards to SSE clients with zero disk
 * involvement.
 *
 * A file watcher (fs.watch) provides a backstop for writers we don't control
 * (e.g., pi-coding-agent's SessionManager) — it reads delta bytes and
 * publishes them through the same bus.
 */
class AwarenessBus {
	private emitter = new EventEmitter();

	constructor() {
		this.emitter.setMaxListeners(0);
	}

	publish(line: string): void {
		if (!line) return;
		this.emitter.emit("line", line);
	}

	subscribe(fn: (line: string) => void): () => void {
		this.emitter.on("line", fn);
		return () => this.emitter.off("line", fn);
	}
}

export const awarenessBus = new AwarenessBus();
