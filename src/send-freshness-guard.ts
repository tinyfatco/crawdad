export interface SendFreshnessCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Tracks whether the current assistant turn is allowed to create visible/send
 * side effects.
 *
 * Busy inbound messages should not abort useful tool work. Instead, they mark
 * the currently-generating assistant turn stale. Tool work may continue, but
 * stale assistant text/final responses/cross-channel sends should be suppressed
 * until a fresh run starts from the newer buffered message batch.
 */
export class SendFreshnessGuard {
	private latestInboundSeq = 0;
	private incorporatedSeq = 0;
	private assistantTurnSeq = 0;

	noteRunStart(): void {
		// A freshly prompted run includes all messages known before it started.
		this.incorporatedSeq = this.latestInboundSeq;
		this.assistantTurnSeq = this.incorporatedSeq;
	}

	noteBusyInbound(): number {
		return ++this.latestInboundSeq;
	}

	noteAssistantTurnStart(): void {
		// If newer messages arrive after this point, this turn becomes stale.
		this.assistantTurnSeq = this.incorporatedSeq;
	}

	isCurrentTurnFresh(): boolean {
		return this.assistantTurnSeq >= this.latestInboundSeq;
	}

	checkCanSend(): SendFreshnessCheck {
		if (!this.isCurrentTurnFresh()) {
			return {
				ok: false,
				reason: "A newer inbound message arrived after this assistant turn began.",
			};
		}
		return { ok: true };
	}
}
