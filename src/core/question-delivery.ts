import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatAnswerMessage } from "./question-format.ts";
import { questionManager } from "./questionManager.ts";
import type { AnswerMessageQuestion, AskQuestion, AskQuestionRequest } from "./question-types.ts";

/** Custom message type carrying answers (or a skip) back to the model. */
export const ASK_QUESTION_ANSWER_MESSAGE = "lune-ask-question-answer";

export interface QuestionDeliveryOptions {
    /**
     * Called when the answer could not be handed to pi at all.
     *
     * The request stays in the durable outbox either way; without this notice the user would
     * never learn that the model never received the answer.
     */
    onError?: (error: unknown) => void;
}

/**
 * Attempt delivery of one settled request.
 *
 * A normal return is not an acknowledgement: pi can queue a steered message and drop it
 * before it reaches the session. The caller keeps the request in the durable outbox until
 * the branch really contains its message, so this function never mutates the outbox.
 */
export function deliverQuestionResult(
    pi: ExtensionAPI,
    request: Readonly<AskQuestionRequest>,
    options: QuestionDeliveryOptions = {},
): void {
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
}

/**
 * Reconcile the durable outbox against the session branch of `ctx`.
 *
 * The branch is the only acknowledgement: a settled request whose answer message is really
 * there is released, and the release is persisted; one whose message is missing - never
 * sent, or dropped by pi's queue - is attempted again. Matching is by requestId, so one
 * request's message says nothing about another's.
 */
export function reconcileQuestionDeliveries(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    options: QuestionDeliveryOptions = {},
): void {
    for (const request of questionManager.getUndeliveredRequests()) {
        if (hasCommittedAnswerMessage(ctx, request.id)) {
            questionManager.acknowledgeDelivery(request.id);
            continue;
        }

        deliverQuestionResult(pi, request, options);
    }
}

/** Whether the active branch really holds this request's answer message. */
function hasCommittedAnswerMessage(ctx: ExtensionContext, requestId: string): boolean {
    for (const entry of ctx.sessionManager.getBranch()) {
        if (
            entry.type === "custom_message"
            && entry.customType === ASK_QUESTION_ANSWER_MESSAGE
            && matchesRequestId(entry.details, requestId)
        ) {
            return true;
        }
    }

    return false;
}

/** The stable identity of an answer message; details without a string requestId never match. */
function matchesRequestId(details: unknown, requestId: string): boolean {
    if (details === null || typeof details !== "object") {
        return false;
    }

    const candidate = details as { requestId?: unknown };

    return typeof candidate.requestId === "string" && candidate.requestId === requestId;
}

/** The answer row reads the label, the prompt and the option names; previews stay in the panel. */
function toAnswerMessageQuestion(question: AskQuestion): AnswerMessageQuestion {
    return {
        header: question.header,
        question: question.question,
        options: question.options?.map((option) => ({ label: option.label })),
    };
}
