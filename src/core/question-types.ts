/**
 * Data shapes shared by the question state, the tools, the panel and the preview pane.
 *
 * They live apart from `questionManager.ts` so a pure renderer can describe a question
 * without importing the state singleton: the preview pane is a function of the question
 * data it is handed, never of what happens to be pending.
 */

export interface AskQuestionOption {
    label: string;
    description?: string;
    /** Markdown shown in the preview pane while this option is focused. */
    preview?: string;
}

export interface AskQuestion {
    /**
     * Short label for the panel tabs, so several questions can be told apart without an
     * invented "Q1"/"Q2" numbering. The panel falls back to the question text when absent.
     */
    header?: string;
    /** The question text shown to the user and sent back to the model. */
    question: string;
    /** Optional user-visible content above the answer controls, such as a preview or snippet. */
    displayText?: string;
    /** Predefined choices; omitted for a free-form question. */
    options?: AskQuestionOption[];
    multiSelect?: boolean;
}

/**
 * The question fields an answer row, a tab label or a model-facing answer reads.
 *
 * `displayText` and `option.preview` are panel display input: copying them into the delivered
 * message would keep every preview in the transcript for good.
 */
export interface AnswerMessageQuestion {
    header?: string;
    question: string;
    options?: Array<{ label: string }>;
}

/** One answered question: either option indexes or the custom text the user wrote. */
export interface AskQuestionAnswer {
    selectedIndexes: number[];
    customText?: string;
}

/**
 * Panel state that must survive an Esc close and a restart.
 *
 * The panel component is recreated on every open, so it is restored from here instead
 * of holding long-lived state of its own. Indexes line up with `questions`.
 */
export interface AskQuestionDraft {
    /** Focused tab: a question index, or `questions.length` for the submit tab. */
    currentIndex: number;
    /** Focused row inside the focused question: an option index, the custom row, or the next row. */
    optionIndex: number;
    answers: (AskQuestionAnswer | undefined)[];
    /** Text written but not committed yet, so a deferred close does not lose it. */
    customDrafts: (string | undefined)[];
}

export type AskQuestionStatus = "pending" | "answered" | "skipped";

export interface AskQuestionRequest {
    id: string;
    createdAt: number;
    questions: AskQuestion[];
    /**
     * Order in which the panel showed this request, used to pick which one to show next: a
     * request that was never shown comes first, otherwise the least recently shown one does.
     */
    shownSeq?: number;
    status: AskQuestionStatus;
    draft: AskQuestionDraft;
    answers?: AskQuestionAnswer[];
    settledAt?: number;
}

export interface AskQuestionStateSnapshot {
    requests: AskQuestionRequest[];
    /**
     * Settled requests whose answer message is not confirmed in the session yet.
     *
     * `pi.sendMessage()` only attempts delivery, so these stay durable until the active
     * branch really contains their message; a request is never moved back to `requests`.
     */
    outbox: AskQuestionRequest[];
}
