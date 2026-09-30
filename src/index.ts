import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    /**
     * Write the pending questions, and report a failure instead of throwing it.
     *
     * Everything that persists does a lifecycle step right after - the overlay closes, the
     * session shuts down, the branch switches - and a throw from `appendEntry` would leave
     * that step half done. The user still has to learn that the state will not survive a
     * restart, so the failure is shown rather than dropped.
     */
    const persist = (ctx: ExtensionContext): void => {
        try {
            questionManager.persist(pi);
        } catch (error) {
            ctx.ui.notify(
                `Question state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }
    };

    let unsubscribeManager: (() => void) | undefined;
    let unsubscribeNotifications: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
        // The previous session's listeners close over its ctx and a duplicate subscription
        // would render and persist twice per event, so they go first - before the state
        // changes below would wake them.
        unsubscribeManager?.();
        unsubscribeManager = undefined;
        unsubscribeNotifications?.();
        unsubscribeNotifications = undefined;

        // Module state may survive extension reloads, so a session starts from its own
        // branch: clear first, then restore the pending questions recorded there.
        resetQuestionPanelState();
        questionManager.clearAll();
        questionDock.setCtx(ctx);
        questionManager.restore(ctx);

        unsubscribeManager = questionManager.subscribe(
            (event) => {
                try {
                    // `requests-cleared` is the session-boundary reset, not a state change;
                    // writing an empty snapshot there would shadow the pending questions of
                    // the branch being restored.
                    if (event.type !== "requests-cleared") {
                        persist(ctx);
                    }
                } finally {
                    // A snapshot that failed must not also leave the dock showing stale order.
                    questionDock.render();
                }
            },
            (error) => {
                // Persistence reports its own failures; this is for a listener that threw for
                // another reason, such as the dock render.
                ctx.ui.notify(
                    `Question dock could not be updated: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            },
        );

        // Registered after the persist listener: the snapshot has to exist before the
        // answer message resumes the model.
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

    pi.on("session_shutdown", (_event, ctx) => {
        // Drafts change without a manager event, so the final snapshot is written here.
        persist(ctx);
        unsubscribeManager?.();
        unsubscribeManager = undefined;
        unsubscribeNotifications?.();
        unsubscribeNotifications = undefined;
        questionDock.clear();
        questionManager.clearAll();
    });

    pi.on("session_before_tree", (_event, ctx) => {
        persist(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
        // The branch changed under the overlay, so a panel that is still up belongs to the
        // branch being left; the reset stops it from continuing into this one.
        resetQuestionPanelState();
        questionManager.clearAll();
        questionManager.restore(ctx);
        questionDock.render();
    });

    pi.registerTool(askUserQuestions(persist));
    registerQuestionCommand(pi, persist);

    pi.registerMessageRenderer<AskQuestionAnswerMessageDetails>(
        ASK_QUESTION_ANSWER_MESSAGE,
        (message, _options, theme) => renderQuestionAnswerMessage(message.details, theme),
    );
}
