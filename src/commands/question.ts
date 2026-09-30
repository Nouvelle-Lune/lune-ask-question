import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { questionManager } from "../core/questionManager.ts";
import { openQuestionPanel } from "../tui/question-panel.ts";

/** Reopen the panel after Esc closed it, without having to ask the model again. */
export function registerQuestionCommand(pi: ExtensionAPI): void {
    pi.registerCommand("question", {
        description: "Open the pending question panel",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("Question panel needs interactive mode", "warning");
                return;
            }

            if (questionManager.getPendingRequests().length === 0) {
                ctx.ui.notify("No pending questions", "info");
                return;
            }

            await openQuestionPanel(ctx, {
                onDeferred: () => questionManager.persist(pi),
            });
        },
    });
}
