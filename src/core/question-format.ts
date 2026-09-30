import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionRequest,
} from "./questionManager.ts";

/** Widest a tab label gets before it is cut, so several tabs still fit one row. */
export const TAB_LABEL_MAX_WIDTH = 16;

/**
 * Tab label of a question: the header the model writes for it.
 *
 * There is deliberately no fallback. Truncating the question would put a sentence in the tab,
 * and a generated "Q1" would carry no information the user can use, so the tool schema requires
 * a header instead. The width cut is only a guard: a CJK header is wider than its code units.
 */
export function questionTabLabel(question: AskQuestion): string {
    return truncateToWidth(question.header?.trim() ?? "", TAB_LABEL_MAX_WIDTH, "…");
}

/**
 * `<header>: ` prefix of a question, empty only for a restored snapshot without a header.
 *
 * Callers show the question text after this, so falling back to the question text here would
 * print the same sentence twice.
 */
export function questionHeaderPrefix(question: AskQuestion): string {
    const label = questionTabLabel(question);

    return label.length === 0 ? "" : `${label}: `;
}

/** Collapse a question (or option text) onto one row for a dock or a header. */
export function summarizeText(text: string, maxWidth: number): string {
    const singleLine = stripTerminalSequences(text)
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();

    if (maxWidth <= 0) {
        return "";
    }

    // The budget is terminal columns: a CJK question is longer on screen than in code units.
    return visibleWidth(singleLine) <= maxWidth
        ? singleLine
        : truncateToWidth(singleLine, maxWidth, "…");
}

/** Numbered label of one option as the panel shows it: `2. Name`. */
export function optionLabel(question: AskQuestion, index: number): string {
    const label = question.options?.[index]?.label ?? `option ${index + 1}`;

    return `${index + 1}. ${label}`;
}

/** Model-facing summary of one answer; undefined while the question is unanswered. */
export function formatAnswer(
    question: AskQuestion,
    answer: AskQuestionAnswer | undefined,
): string | undefined {
    if (!answer) {
        return undefined;
    }

    if (answer.customText !== undefined && answer.customText.length > 0) {
        return `wrote: ${answer.customText}`;
    }

    if (answer.selectedIndexes.length === 0) {
        return undefined;
    }

    return `selected: ${answer.selectedIndexes.map((index) => optionLabel(question, index)).join(", ")}`;
}

/** Model-facing text of the follow-up message that carries answered or skipped questions. */
export function formatAnswerMessage(request: AskQuestionRequest): string {
    if (request.status === "skipped") {
        return [
            "The user skipped these questions without answering.",
            "",
            ...request.questions.map((question) => question.question),
        ].join("\n");
    }

    const lines: string[] = ["The user answered these questions.", ""];

    for (const [index, question] of request.questions.entries()) {
        lines.push(question.question, `answer: ${formatAnswer(question, request.answers?.[index]) ?? "unanswered"}`, "");
    }

    return lines.join("\n").trimEnd();
}

/** Model-facing text of the tool result, which returns before any answer exists. */
export function formatPendingMessage(request: AskQuestionRequest): string {
    return [
        `Asked the user ${request.questions.length} question${request.questions.length === 1 ? "" : "s"}; the interactive panel is open (request ${request.id}).`,
        "The answers will arrive as a follow-up message. Continue with work that does not depend on them, then end your turn to wait.",
        "",
        ...request.questions.map((question) => question.question),
    ].join("\n");
}
