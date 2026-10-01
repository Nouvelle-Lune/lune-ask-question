import { randomUUID } from "node:crypto";

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { QUESTION_STATE_VERSION } from "./question-types.ts";
import type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionDraft,
    AskQuestionRequest,
    AskQuestionStateSnapshot,
} from "./question-types.ts";

export { QUESTION_STATE_VERSION } from "./question-types.ts";

export type {
    AnswerMessageQuestion,
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionDraft,
    AskQuestionOption,
    AskQuestionRequest,
    AskQuestionStateSnapshot,
    AskQuestionStatus,
} from "./question-types.ts";

/**
 * Custom session entry holding the question state.
 *
 * A question outlives the turn that asked it: the user may close the panel with Esc,
 * quit Pi, and answer after a restart. The snapshot is written whenever the pending
 * set, a draft or the delivery outbox changes at a settle point, and read back from
 * the active branch.
 */
export const QUESTION_STATE_ENTRY = "lune-ask-question-state";

export type QuestionManagerEvent =
    | { type: "request-created"; id: string }
    | { type: "request-shown"; id: string }
    | { type: "request-answered"; id: string }
    | { type: "request-skipped"; id: string }
    | { type: "request-delivered"; id: string }
    | { type: "requests-restored" }
    | { type: "requests-cleared" };

export type QuestionManagerListener = (event: QuestionManagerEvent) => void;
export type QuestionManagerListenerErrorHandler = (error: unknown, event: QuestionManagerEvent) => void;

export class QuestionManager {
    private readonly pending = new Map<string, AskQuestionRequest>();
    /**
     * Settled requests whose answer message is not confirmed in the session yet.
     *
     * `pi.sendMessage()` is only an attempt: pi can queue a steered message and drop it
     * before it reaches the session. A settled request therefore stays here - durable and
     * out of the pending queue - until the branch really carries its message.
     */
    private readonly outbox = new Map<string, AskQuestionRequest>();
    private readonly listeners = new Map<QuestionManagerListener, QuestionManagerListenerErrorHandler | undefined>();
    private shownSeqCounter = 0;

    create(questions: readonly AskQuestion[]): AskQuestionRequest {
        const request: AskQuestionRequest = {
            id: randomUUID(),
            createdAt: Date.now(),
            questions: questions.map(copyQuestion),
            status: "pending",
            draft: emptyDraft(questions.length),
        };

        this.pending.set(request.id, request);
        this.emit({ type: "request-created", id: request.id });

        return request;
    }

    get(id: string): Readonly<AskQuestionRequest> | undefined {
        return this.pending.get(id) ?? this.outbox.get(id);
    }

    /** Pending requests oldest first; this is the order they were created in. */
    getPendingRequests(): readonly AskQuestionRequest[] {
        return Array.from(this.pending.values())
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    /**
     * The pending request the panel should show next.
     *
     * Least recently shown first, with a request that was never shown ahead of all of them: a
     * question that just arrived has to surface immediately, while one the user dismissed with
     * Esc must not pop back up in front of it. Requests that were never shown fall back to the
     * order they were created in.
     */
    nextPendingRequest(): AskQuestionRequest | undefined {
        let next: AskQuestionRequest | undefined;

        for (const request of this.getPendingRequests()) {
            if (next === undefined || shownOrder(request) < shownOrder(next)) {
                next = request;
            }
        }

        return next;
    }

    /**
     * Record that the panel is showing `id`, which moves it behind the requests it passed.
     *
     * The event is what keeps every ordering reader in step: the dock names the request this
     * moved to the front, and the new `shownSeq` reaches the next snapshot with it.
     */
    markShown(id: string): void {
        const request = this.getPendingRequest(id);

        if (request) {
            request.shownSeq = ++this.shownSeqCounter;
            this.emit({ type: "request-shown", id });
        }
    }

    getPendingRequest(id: string): AskQuestionRequest | undefined {
        return this.pending.get(id);
    }

    /**
     * The panel owns the pending request's draft and mutates it in place, so a snapshot
     * always sees the latest focus and written text without a separate write path.
     */
    submit(id: string, answers: readonly AskQuestionAnswer[]): boolean {
        const request = this.getPendingRequest(id);

        // Settling is idempotent: a submit can race a skip or a shutdown, and only the
        // first one may count (or be delivered twice).
        if (!request) {
            return false;
        }

        request.status = "answered";
        request.answers = answers.map(copyAnswer);
        request.settledAt = Date.now();

        // Settling is one move: out of the pending queue, into the durable outbox. The
        // request must not be asked again, but its payload has to survive until pi's
        // session really carries the answer message. The draft stays with the panel: keeping
        // it would duplicate a written answer in the outbox and the snapshot.
        request.draft = emptyDraft(request.questions.length);
        this.pending.delete(id);
        this.outbox.set(id, request);

        this.emit({ type: "request-answered", id });

        return true;
    }

    skip(id: string): boolean {
        const request = this.getPendingRequest(id);

        if (!request) {
            return false;
        }

        request.status = "skipped";
        request.settledAt = Date.now();

        // A skip is delivered as a custom message too, so it takes the same durable path
        // as an answer: dropping it from the outbox would lose the model's only notice.
        request.draft = emptyDraft(request.questions.length);
        this.pending.delete(id);
        this.outbox.set(id, request);

        this.emit({ type: "request-skipped", id });

        return true;
    }

    /** Settled requests whose answer message is not confirmed in the session yet. */
    getUndeliveredRequests(): readonly Readonly<AskQuestionRequest>[] {
        return Array.from(this.outbox.values())
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    /**
     * Release a settled request once its message is confirmed to be on the session branch.
     *
     * The event is what makes the persistence listener write an outbox without it, so a
     * later restore cannot bring it back and deliver a second copy.
     */
    acknowledgeDelivery(id: string): boolean {
        if (!this.outbox.delete(id)) {
            return false;
        }

        this.emit({ type: "request-delivered", id });

        return true;
    }

    /** Drop every request, pending or not; a session starts from its own branch. */
    clearAll(): void {
        if (this.pending.size === 0 && this.outbox.size === 0) {
            return;
        }

        this.pending.clear();
        this.outbox.clear();
        this.emit({ type: "requests-cleared" });
    }

    /** Persist the pending requests (with drafts) and the delivery outbox into the session of `pi`. */
    persist(pi: ExtensionAPI): void {
        pi.appendEntry(QUESTION_STATE_ENTRY, this.snapshot());
    }

    snapshot(): AskQuestionStateSnapshot {
        return {
            version: QUESTION_STATE_VERSION,
            requests: this.getPendingRequests().map((request) => structuredClone(request)),
            outbox: this.getUndeliveredRequests().map((request) => structuredClone(request)),
        };
    }

    /** Restore the newest snapshot on the active branch; the newest state always wins. */
    restore(ctx: ExtensionContext): void {
        const branch = ctx.sessionManager.getBranch();

        for (let index = branch.length - 1; index >= 0; index--) {
            const entry = branch[index];

            if (!entry || entry.type !== "custom" || entry.customType !== QUESTION_STATE_ENTRY) {
                continue;
            }

            const snapshot = entry.data as Partial<AskQuestionStateSnapshot> | undefined;

            if (snapshot?.version === QUESTION_STATE_VERSION && Array.isArray(snapshot.requests)) {
                this.restoreSnapshot(snapshot as AskQuestionStateSnapshot);
            }

            return;
        }
    }

    /**
     * `onError` reports a listener that threw. Passing one is what keeps a failure visible:
     * the listener that writes the snapshot is also the one whose failure would silently
     * lose it, and the others must keep running either way.
     */
    subscribe(listener: QuestionManagerListener, onError?: QuestionManagerListenerErrorHandler): () => void {
        this.listeners.set(listener, onError);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private restoreSnapshot(snapshot: AskQuestionStateSnapshot): void {
        let restored = false;

        for (const saved of snapshot.requests) {
            // A live request with the same id is newer than the snapshot; the entry is
            // only a fallback for state this process no longer has.
            if (!isStoredRequest(saved) || this.hasRequest(saved.id)) {
                continue;
            }

            this.pending.set(saved.id, normalizePendingRequest(saved));
            this.shownSeqCounter = Math.max(this.shownSeqCounter, saved.shownSeq ?? 0);
            restored = true;
        }

        // Settled requests are restored as settled: turning them back into pending would
        // ask the user again, and dropping them would lose an answer the model never saw.
        // A snapshot that omits the outbox is still readable - it holds nothing waiting for
        // delivery - but a version this build does not know is never guessed at.
        for (const saved of Array.isArray(snapshot.outbox) ? snapshot.outbox : []) {
            if (!isStoredRequest(saved) || this.hasRequest(saved.id)) {
                continue;
            }

            const settled = normalizeSettledRequest(saved);

            if (!settled) {
                continue;
            }

            this.outbox.set(settled.id, settled);
            restored = true;
        }

        if (restored) {
            this.emit({ type: "requests-restored" });
        }
    }

    /** Whether either queue already holds `id`; a snapshot never replaces live state. */
    private hasRequest(id: string): boolean {
        return this.pending.has(id) || this.outbox.has(id);
    }

    private emit(event: QuestionManagerEvent): void {
        for (const [listener, onError] of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                // One failing listener cannot break the others, but its failure is reported
                // rather than hidden: it may be the one that persists the snapshot.
                this.reportListenerError(onError, error, event);
            }
        }
    }

    private reportListenerError(
        onError: QuestionManagerListenerErrorHandler | undefined,
        error: unknown,
        event: QuestionManagerEvent,
    ): void {
        try {
            onError?.(error, event);
        } catch {
            // The reporter is the last line of defence; its own failure must not surface as a
            // broken emit either.
        }
    }
}

function copyQuestion(question: AskQuestion): AskQuestion {
    return {
        ...question,
        // A stored entry can be malformed; `options` has to be an array before it is mapped.
        options: Array.isArray(question.options)
            ? question.options.map((option) => ({ ...option }))
            : undefined,
    };
}

function copyAnswer(answer: AskQuestionAnswer): AskQuestionAnswer {
    return createAnswer(
        Array.isArray(answer.selectedIndexes) ? [...answer.selectedIndexes] : [],
        typeof answer.customText === "string" && answer.customText.length > 0 ? answer.customText : undefined,
    );
}

/** Custom text is a separate kind of answer, so an unset one is omitted instead of `undefined`. */
function createAnswer(selectedIndexes: number[], customText: string | undefined): AskQuestionAnswer {
    return customText === undefined
        ? { selectedIndexes }
        : { selectedIndexes, customText };
}

/** A stored answer can come from an older or hand-edited session entry, so it is validated. */
function normalizeAnswer(value: unknown): AskQuestionAnswer | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const candidate = value as { selectedIndexes?: unknown; customText?: unknown };

    const selectedIndexes = Array.isArray(candidate.selectedIndexes)
        ? candidate.selectedIndexes.filter(
            (index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0,
        )
        : [];
    const customText = typeof candidate.customText === "string" && candidate.customText.length > 0
        ? candidate.customText
        : undefined;

    if (selectedIndexes.length === 0 && customText === undefined) {
        return undefined;
    }

    return createAnswer(selectedIndexes, customText);
}

function emptyDraft(questionCount: number): AskQuestionDraft {
    return {
        currentIndex: 0,
        optionIndex: 0,
        answers: new Array(questionCount).fill(undefined),
        customDrafts: new Array(questionCount).fill(undefined),
    };
}

function normalizePendingRequest(saved: AskQuestionRequest): AskQuestionRequest {
    return {
        id: saved.id,
        createdAt: typeof saved.createdAt === "number" ? saved.createdAt : Date.now(),
        shownSeq: typeof saved.shownSeq === "number" && Number.isFinite(saved.shownSeq) ? saved.shownSeq : undefined,
        questions: saved.questions.map(copyQuestion),
        status: "pending",
        draft: normalizeDraft(saved.draft, saved.questions.length),
    };
}

/**
 * A settled outbox entry read back from a snapshot.
 *
 * Only the delivery payload is kept: a settled request never reopens, so its draft is not
 * restored as panel state. An answered entry without valid answers cannot be delivered and
 * is not guessed at.
 */
function normalizeSettledRequest(saved: AskQuestionRequest): AskQuestionRequest | undefined {
    if (saved.status !== "answered" && saved.status !== "skipped") {
        return undefined;
    }

    const request: AskQuestionRequest = {
        id: saved.id,
        createdAt: typeof saved.createdAt === "number" ? saved.createdAt : Date.now(),
        questions: saved.questions.map(copyQuestion),
        status: saved.status,
        draft: emptyDraft(saved.questions.length),
        settledAt: typeof saved.settledAt === "number" ? saved.settledAt : Date.now(),
    };

    if (saved.status === "answered") {
        const answers = normalizeAnswers(saved.answers);

        if (!answers) {
            return undefined;
        }

        request.answers = answers;
    }

    return request;
}

/** A settled answer list from durable state; every entry has to be a real answer. */
function normalizeAnswers(saved: unknown): AskQuestionAnswer[] | undefined {
    if (!Array.isArray(saved) || saved.length === 0) {
        return undefined;
    }

    const answers = saved.map((answer) => normalizeAnswer(answer));

    return answers.every((answer): answer is AskQuestionAnswer => answer !== undefined) ? answers : undefined;
}

/** Requests that were never shown sort before every shown one. */
function shownOrder(request: AskQuestionRequest): number {
    return request.shownSeq ?? -1;
}

function normalizeDraft(draft: AskQuestionDraft | undefined, questionCount: number): AskQuestionDraft {
    const normalized = emptyDraft(questionCount);

    if (!draft) {
        return normalized;
    }

    normalized.currentIndex = clampIndex(draft.currentIndex, questionCount);
    normalized.optionIndex = Math.max(0, draft.optionIndex ?? 0);
    normalized.answers = normalized.answers.map((_, index) => normalizeAnswer(draft.answers?.[index]));
    normalized.customDrafts = normalized.customDrafts.map((_, index) => {
        const text = draft.customDrafts?.[index];

        return typeof text === "string" ? text : undefined;
    });

    return normalized;
}

/** The panel may have been closed on the submit tab, so the index can reach `questionCount`. */
function clampIndex(index: number, questionCount: number): number {
    if (!Number.isFinite(index)) {
        return 0;
    }

    return Math.min(questionCount, Math.max(0, Math.trunc(index)));
}

function isStoredRequest(value: unknown): value is AskQuestionRequest {
    if (!value || typeof value !== "object") {
        return false;
    }

    const request = value as Partial<AskQuestionRequest>;

    return typeof request.id === "string" && Array.isArray(request.questions);
}

// Shared singleton: its state outlives extension reloads, which is why the extension
// clears it on session start before restoring from the branch.
export const questionManager = new QuestionManager();
