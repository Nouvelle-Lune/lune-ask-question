import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerQuestionCommand } from "./commands/question.ts";
import { ASK_QUESTION_ANSWER_MESSAGE, registerQuestionAnswerNotifications } from "./core/question-notification.ts";
import { questionManager } from "./core/questionManager.ts";
import { askUserQuestions } from "./tools/ask-user-questions.ts";
import {
    renderQuestionAnswerMessage,
    type AskQuestionAnswerMessageDetails,
} from "./tui/question-answer-message.ts";
import { questionDock } from "./tui/question-dock.ts";
import { resetQuestionPanelState } from "./tui/question-panel.ts";

export default function (pi: ExtensionAPI): void {
    const persist = () => questionManager.persist(pi);

    let unsubscribeManager: (() => void) | undefined;
    let unsubscribeNotifications: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
        // Module state may survive extension reloads, so a session starts from its own
        // branch: clear first, then restore the pending questions recorded there.
        resetQuestionPanelState();
        questionManager.clearAll();
        questionManager.restore(ctx);
        questionDock.setCtx(ctx);

        // Drop the previous session's listener first: it closes over a stale ctx, and a
        // duplicate subscription would render and persist twice per event.
        unsubscribeManager?.();

        unsubscribeManager = questionManager.subscribe((event) => {
            // `requests-cleared` is the session-boundary reset, not a state change; writing
            // an empty snapshot there would shadow the pending questions of the branch
            // being restored.
            if (event.type !== "requests-cleared") {
                persist();
            }

            questionDock.render();
        });

        // Registered after the persist listener: the snapshot has to exist before the
        // answer message resumes the model.
        unsubscribeNotifications?.();
        unsubscribeNotifications = registerQuestionAnswerNotifications(pi, {
            onError: (error) => {
                ctx.ui.notify(
                    `Question answers could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            },
        });

        questionDock.render();
    });

    pi.on("session_shutdown", () => {
        // Drafts change without a manager event, so the final snapshot is written here.
        persist();
        unsubscribeManager?.();
        unsubscribeManager = undefined;
        unsubscribeNotifications?.();
        unsubscribeNotifications = undefined;
        questionDock.clear();
        questionManager.clearAll();
    });

    pi.on("session_before_tree", () => {
        persist();
    });

    pi.on("session_tree", (_event, ctx) => {
        questionManager.clearAll();
        questionManager.restore(ctx);
        questionDock.render();
    });

    pi.registerTool(askUserQuestions(persist));
    registerQuestionCommand(pi);

    pi.registerMessageRenderer<AskQuestionAnswerMessageDetails>(
        ASK_QUESTION_ANSWER_MESSAGE,
        (message, _options, theme) => renderQuestionAnswerMessage(message.details, theme),
    );
}
