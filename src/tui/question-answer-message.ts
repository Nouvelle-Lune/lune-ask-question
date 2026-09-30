import type { Theme } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { formatAnswer, questionHeaderPrefix, summarizeText } from "../core/question-format.ts";
import type { AskQuestion, AskQuestionAnswer } from "../core/questionManager.ts";

export interface AskQuestionAnswerMessageDetails {
    requestId?: string;
    status?: "answered" | "skipped";
    questions?: AskQuestion[];
    answers?: AskQuestionAnswer[];
}

/** Transcript row for the follow-up message that carries answers or a skip. */
export function renderQuestionAnswerMessage(
    details: AskQuestionAnswerMessageDetails | undefined,
    theme: Theme,
): Text {
    const questions = details?.questions ?? [];
    const skipped = details?.status === "skipped";

    const lines: string[] = [
        theme.bold(skipped
            ? theme.fg("warning", "Questions skipped")
            : theme.fg("success", "Questions answered")),
    ];

    for (const [index, question] of questions.entries()) {
        lines.push(
            `${theme.fg("muted", questionHeaderPrefix(question))}${theme.fg("text", summarizeText(question.question, 60))}`,
        );

        const answer = formatAnswer(question, details?.answers?.[index]);

        if (answer !== undefined) {
            lines.push(`    ${theme.fg("accent", answer)}`);
        }
    }

    return new Text(lines.join("\n"), 0, 0);
}
