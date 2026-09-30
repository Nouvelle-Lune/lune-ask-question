import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatAnswerMessage } from "./question-format.ts";
import { questionManager } from "./questionManager.ts";
import type { AnswerMessageQuestion, AskQuestion } from "./questionManager.ts";

/** Custom message type carrying answers (or a skip) back to the model. */
export const ASK_QUESTION_ANSWER_MESSAGE = "lune-ask-question-answer";

export interface QuestionAnswerNotificationOptions {
    /**
     * Called when the answer could not be handed to pi at all.
     *
     * The request stays settled either way; without this notice the user would never learn
     * that the model never received the answer.
     */
    onError?: (error: unknown) => void;
}

/**
 * Deliver settled questions to the model as a follow-up message.
 *
 * The tool returned before the user answered, so this message is what resumes the agent.
 * `steer` delivers to a model that kept working after asking (pi queues it for the end of
 * the current turn); `triggerTurn` starts a run when the agent already ended its turn.
 *
 * pi handles the async half itself (it reports a rejected send as an extension error), so
 * only a synchronous throw can escape here - and that one has to be reported, not swallowed.
 */
export function registerQuestionAnswerNotifications(
    pi: ExtensionAPI,
    options: QuestionAnswerNotificationOptions = {},
): () => void {
    return questionManager.subscribe((event) => {
        if (event.type !== "request-answered" && event.type !== "request-skipped") {
            return;
        }

        const request = questionManager.get(event.id);

        if (!request) {
            return;
        }

        try {
            pi.sendMessage(
                {
                    customType: ASK_QUESTION_ANSWER_MESSAGE,
                    content: formatAnswerMessage(request),
                    display: true,
                    details: {
                        requestId: request.id,
                        status: request.status,
                        questions: request.questions.map(toAnswerMessageQuestion),
                        answers: request.answers,
                    },
                },
                {
                    triggerTurn: true,
                    deliverAs: "steer",
                },
            );
        } catch (error) {
            options.onError?.(error);
        }
    });
}

/** The answer row reads the label, the prompt and the option names; previews stay in the panel. */
function toAnswerMessageQuestion(question: AskQuestion): AnswerMessageQuestion {
    return {
        header: question.header,
        question: question.question,
        options: question.options?.map((option) => ({ label: option.label })),
    };
}
