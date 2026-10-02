/**
 * Question interaction model of the panel: the rows a question offers and the draft
 * transitions that move between them.
 *
 * It works on the request's `draft` in place instead of holding state of its own, so the only
 * copy that has to be persisted is the one already on the request. Nothing here touches the
 * terminal: rendering the resulting draft is the renderer's job, and the panel is what turns a
 * transition into a render request, an editor mode change or a settle.
 */
import type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionDraft,
    AskQuestionRequest,
} from "../../core/question-types.ts";

/** One selectable line of the focused question, in panel order. */
export type QuestionRow =
    | { kind: "option"; index: number }
    | { kind: "custom" }
    | { kind: "next" };

/** Rows of one question: its options, the free-form row, and the multi-select confirm row. */
export function questionRows(question: AskQuestion): QuestionRow[] {
    const rows: QuestionRow[] = (question.options ?? []).map((_, index) => ({
        kind: "option" as const,
        index,
    }));

    rows.push({ kind: "custom" });

    // `Enter` toggles checkboxes in a multi-select question, so confirming the
    // selection needs a row of its own.
    if (question.multiSelect === true && (question.options?.length ?? 0) > 0) {
        rows.push({ kind: "next" });
    }

    return rows;
}

/** Clamped row index: a restored draft may carry an `optionIndex` past the current rows. */
export function focusedRowIndex(rows: readonly QuestionRow[], optionIndex: number): number {
    return Math.min(rows.length - 1, Math.max(0, optionIndex));
}

export function focusedQuestionRow(
    question: AskQuestion,
    optionIndex: number,
): QuestionRow | undefined {
    const rows = questionRows(question);

    return rows[focusedRowIndex(rows, optionIndex)];
}

/** True when every question has an answer; the header, the tabs and submit read it. */
export function areAllAnswered(
    questions: readonly AskQuestion[],
    draft: AskQuestionDraft,
): boolean {
    return questions.every((_, index) => draft.answers[index] !== undefined);
}

/** What a number key did, so the caller knows whether advancing has to follow. */
export type PickOptionResult = "answer" | "toggle" | "ignored";

/** What follows an answered question: advance to the next one, or settle the request. */
export type AdvanceResult = "submit" | "next";

export class QuestionPanelController {
    private readonly request: AskQuestionRequest;

    constructor(request: AskQuestionRequest) {
        this.request = request;
    }

    get draft(): AskQuestionDraft {
        return this.request.draft;
    }

    get questions(): readonly AskQuestion[] {
        return this.request.questions;
    }

    get isMultiQuestion(): boolean {
        return this.questions.length > 1;
    }

    get isSubmitTab(): boolean {
        return this.draft.currentIndex >= this.questions.length;
    }

    currentQuestion(): AskQuestion | undefined {
        return this.questions[this.draft.currentIndex];
    }

    focusedRow(): QuestionRow | undefined {
        const question = this.currentQuestion();

        return question === undefined
            ? undefined
            : focusedQuestionRow(question, this.draft.optionIndex);
    }

    /** True while the cursor sits on the "type something" row of the current question. */
    isCustomRowFocused(): boolean {
        return this.focusedRow()?.kind === "custom";
    }

    moveRow(step: number): void {
        const question = this.currentQuestion();

        if (!question) {
            return;
        }

        const rows = questionRows(question);

        this.draft.optionIndex = (focusedRowIndex(rows, this.draft.optionIndex) + step + rows.length)
            % rows.length;
    }

    /** Jump to a tab; the submit tab is `questions.length`. Returns whether the tab changed. */
    selectTab(index: number): boolean {
        if (index < 0 || index > this.questions.length || index === this.draft.currentIndex) {
            return false;
        }

        this.draft.currentIndex = index;
        this.draft.optionIndex = 0;

        return true;
    }

    moveTab(step: number): void {
        const total = this.questions.length + 1;
        const current = Math.min(total - 1, Math.max(0, this.draft.currentIndex));

        this.draft.currentIndex = (current + step + total) % total;
        this.draft.optionIndex = 0;
    }

    pickOption(index: number): PickOptionResult {
        const question = this.currentQuestion();

        if (!question?.options?.[index]) {
            return "ignored";
        }

        this.draft.optionIndex = index;

        if (question.multiSelect === true) {
            this.toggleOption(index);
            return "toggle";
        }

        this.answerWithOption(index);

        return "answer";
    }

    toggleFocusedRow(): void {
        const question = this.currentQuestion();

        if (!question || question.multiSelect !== true) {
            return;
        }

        const row = this.focusedRow();

        if (row?.kind === "option") {
            this.toggleOption(row.index);
        }
    }

    toggleOption(index: number): void {
        const question = this.currentQuestion();

        if (!question?.options?.[index]) {
            return;
        }

        const questionIndex = this.draft.currentIndex;
        const answer = this.draft.answers[questionIndex];
        const selected = new Set(answer?.selectedIndexes ?? []);

        if (selected.has(index)) {
            selected.delete(index);
        } else {
            selected.add(index);
        }

        const indexes = Array.from(selected).sort((left, right) => left - right);

        // A written answer and selected options are mutually exclusive; the written
        // draft itself stays in `customDrafts` so the editor can restore it.
        this.draft.answers[questionIndex] = indexes.length > 0
            ? { selectedIndexes: indexes }
            : undefined;
    }

    answerWithOption(index: number): void {
        this.draft.answers[this.draft.currentIndex] = { selectedIndexes: [index] };
    }

    /**
     * Move past the answered question; `"submit"` asks the caller to settle a single-question
     * request instead of advancing.
     */
    advanceAfterAnswer(): AdvanceResult {
        if (this.questions.length === 1) {
            return "submit";
        }

        const questionIndex = this.draft.currentIndex;

        this.draft.currentIndex = questionIndex < this.questions.length - 1
            ? questionIndex + 1
            : this.questions.length;
        this.draft.optionIndex = 0;

        return "next";
    }

    setCustomAnswer(text: string): void {
        const questionIndex = this.draft.currentIndex;

        this.draft.customDrafts[questionIndex] = text;
        this.draft.answers[questionIndex] = { selectedIndexes: [], customText: text };
    }

    allAnswered(): boolean {
        return areAllAnswered(this.questions, this.draft);
    }

    /**
     * True when the request can be submitted; otherwise the focus moves to the first gap and
     * the caller must not settle it. Landing on the first gap is more useful than a dead Enter
     * press.
     */
    prepareSubmit(): boolean {
        if (this.allAnswered()) {
            return true;
        }

        const missing = this.draft.answers.findIndex((answer) => answer === undefined);

        if (missing >= 0) {
            this.draft.currentIndex = missing;
            this.draft.optionIndex = 0;
        }

        return false;
    }

    /** Answers in question order for the manager; complete only after `prepareSubmit`. */
    collectAnswers(): AskQuestionAnswer[] {
        return this.draft.answers.filter(
            (answer): answer is AskQuestionAnswer => answer !== undefined,
        );
    }
}
