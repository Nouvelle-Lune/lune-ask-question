import { randomUUID } from "node:crypto";

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionDraft,
    AskQuestionRequest,
    AskQuestionStateSnapshot,
} from "./question-types.ts";

export type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionDraft,
    AskQuestionOption,
    AskQuestionRequest,
    AskQuestionStateSnapshot,
    AskQuestionStatus,
} from "./question-types.ts";

/**
 * Custom session entry holding the pending questions.
 *
 * A question outlives the turn that asked it: the user may close the panel with Esc,
 * quit Pi, and answer after a restart. The snapshot is written whenever the pending
 * set or a draft changes at a settle point, and read back from the active branch.
 */
export const QUESTION_STATE_ENTRY = "lune-ask-question-state";

export type QuestionManagerEvent =
    | { type: "request-created"; id: string }
    | { type: "request-answered"; id: string }
    | { type: "request-skipped"; id: string }
    | { type: "requests-restored" }
    | { type: "requests-cleared" };

export type QuestionManagerListener = (event: QuestionManagerEvent) => void;

export class QuestionManager {
    private readonly requests = new Map<string, AskQuestionRequest>();
    private readonly listeners = new Set<QuestionManagerListener>();

    create(questions: readonly AskQuestion[]): AskQuestionRequest {
        const request: AskQuestionRequest = {
            id: randomUUID(),
            createdAt: Date.now(),
            questions: questions.map(copyQuestion),
            status: "pending",
            draft: emptyDraft(questions.length),
        };

        this.requests.set(request.id, request);
        this.emit({ type: "request-created", id: request.id });

        return request;
    }

    get(id: string): Readonly<AskQuestionRequest> | undefined {
        return this.requests.get(id);
    }

    /** Pending requests oldest first; this is the order `/question` walks through. */
    getPendingRequests(): readonly AskQuestionRequest[] {
        return Array.from(this.requests.values())
            .filter((request) => request.status === "pending")
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    getPendingRequest(id: string): AskQuestionRequest | undefined {
        const request = this.requests.get(id);

        return request?.status === "pending" ? request : undefined;
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

        this.emit({ type: "request-skipped", id });

        return true;
    }

    /** Drop every request, including settled ones; a session starts from its own branch. */
    clearAll(): void {
        if (this.requests.size === 0) {
            return;
        }

        this.requests.clear();
        this.emit({ type: "requests-cleared" });
    }

    /** Persist the pending requests (with drafts) into the session of `pi`. */
    persist(pi: ExtensionAPI): void {
        pi.appendEntry(QUESTION_STATE_ENTRY, this.snapshot());
    }

    snapshot(): AskQuestionStateSnapshot {
        return {
            requests: this.getPendingRequests().map((request) => structuredClone(request)),
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

            const snapshot = entry.data as AskQuestionStateSnapshot | undefined;

            if (snapshot && Array.isArray(snapshot.requests)) {
                this.restoreSnapshot(snapshot);
            }

            return;
        }
    }

    subscribe(listener: QuestionManagerListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private restoreSnapshot(snapshot: AskQuestionStateSnapshot): void {
        let restored = false;

        for (const saved of snapshot.requests) {
            // A live request with the same id is newer than the snapshot; the entry is
            // only a fallback for state this process no longer has.
            if (!isStoredRequest(saved) || this.requests.has(saved.id)) {
                continue;
            }

            this.requests.set(saved.id, normalizeRequest(saved));
            restored = true;
        }

        if (restored) {
            this.emit({ type: "requests-restored" });
        }
    }

    private emit(event: QuestionManagerEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                // Ignore listener errors so one failing listener cannot break the others.
            }
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

function normalizeRequest(saved: AskQuestionRequest): AskQuestionRequest {
    return {
        id: saved.id,
        createdAt: typeof saved.createdAt === "number" ? saved.createdAt : Date.now(),
        questions: saved.questions.map(copyQuestion),
        status: "pending",
        draft: normalizeDraft(saved.draft, saved.questions.length),
    };
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
