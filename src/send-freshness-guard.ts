interface PendingMessageSeq {
	text: string;
	seq: number;
}

export interface SendFreshnessCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Tracks whether the current assistant turn has incorporated busy inbound
 * messages before allowing cross-channel send side effects.
 *
 * Busy messages should keep the agent in the flow via soft steering, not abort
 * ongoing work. But if the assistant tries to send to another channel from a
 * stale turn, suppress that send until the queued message is incorporated and a
 * fresh assistant turn starts.
 */
export class SendFreshnessGuard {
	private latestInboundSeq = 0;
	private incorporatedSeq = 0;
	private assistantTurnSeq = 0;
	private pending: PendingMessageSeq[] = [];

	noteRunStart(): void {
		// A freshly prompted run includes all messages known before it started.
		this.incorporatedSeq = this.latestInboundSeq;
		this.assistantTurnSeq = this.incorporatedSeq;
		this.pending = [];
	}

	noteBusyInbound(text: string): number {
		const seq = ++this.latestInboundSeq;
		this.pending.push({ text, seq });
		return seq;
	}

	noteUserMessageIncorporated(text: string): void {
		const idx = this.pending.findIndex((item) => item.text === text);
		if (idx !== -1) {
			const [item] = this.pending.splice(idx, 1);
			this.incorporatedSeq = Math.max(this.incorporatedSeq, item.seq);
			return;
		}

		// Fallback for transformed/expanded text: incorporation happens in FIFO
		// order, and exact matching can fail if an extension/template changes text.
		const [item] = this.pending.splice(0, 1);
		if (item) {
			this.incorporatedSeq = Math.max(this.incorporatedSeq, item.seq);
		}
	}

	noteAssistantTurnStart(): void {
		// The assistant response starting now sees whatever queued user messages
		// were incorporated immediately before this turn.
		this.assistantTurnSeq = this.incorporatedSeq;
	}

	checkCanSend(): SendFreshnessCheck {
		if (this.assistantTurnSeq < this.latestInboundSeq) {
			return {
				ok: false,
				reason: "A newer inbound message arrived after this assistant turn began.",
			};
		}
		return { ok: true };
	}
}
