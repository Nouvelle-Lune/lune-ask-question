import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { questionManager } from "../core/questionManager.ts";
import { openQuestionPanel } from "../tui/panel/question-panel.ts";

/** Reopen the panel after Esc closed it, without having to ask the model again. */
export function registerQuestionCommand(pi: ExtensionAPI, persist: (ctx: ExtensionContext) => void): void {
    pi.registerCommand("question", {
        description: "Open the pending question panel",
        handler: (_args, ctx) => openPendingQuestions(ctx, persist),
    });
}

/** The dock and slash command share panel selection, draft persistence and mode checks. */
export async function openPendingQuestions(ctx: ExtensionContext, persist: (ctx: ExtensionContext) => void): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify("Question panel needs interactive mode", "warning");
        return;
    }
    if (questionManager.getPendingRequests().length === 0) {
        ctx.ui.notify("No pending questions", "info");
        return;
    }
    await openQuestionPanel(ctx, { onDeferred: () => persist(ctx) });
}
