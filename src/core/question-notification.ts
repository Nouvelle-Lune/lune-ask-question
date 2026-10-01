import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { deliverQuestionResult, type QuestionDeliveryOptions } from "./question-delivery.ts";
import { questionManager } from "./questionManager.ts";

export { ASK_QUESTION_ANSWER_MESSAGE } from "./question-delivery.ts";

export type QuestionAnswerNotificationOptions = QuestionDeliveryOptions;

/**
 * Attempt delivery as soon as a request settles.
 *
 * This is the initial attempt only. The persistence listener runs first, so the settled
 * request is already in the durable outbox when this send happens; if pi drops the message,
 * reconciliation recovers it instead of the answer being lost with the call.
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

        deliverQuestionResult(pi, request, options);
    });
}
