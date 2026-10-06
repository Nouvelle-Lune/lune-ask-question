import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { createDockContribution, type LuneDockSnapshot } from "@nouvelle-lune/lune-dock-protocol";
import { openPendingQuestions } from "../commands/question.ts";
import { questionManager } from "../core/questionManager.ts";
import { questionDock } from "./question-dock.ts";

export const QUESTION_CONTRIBUTION_ID = "ask-question";

export function getQuestionDockSnapshot(ctx: ExtensionContext): LuneDockSnapshot {
    const count = questionManager.getPendingRequests().length;
    const next = questionManager.nextPendingRequest();
    const title = stripTerminalSequences(next?.questions[0]?.header ?? next?.questions[0]?.question ?? "").replace(/[\r\n\t]+/g, " ");
    const summary = count === 0 ? "idle" : `${count} pending ${count === 1 ? "request" : "requests"}`;
    const component = (suffix: string): Component => ({
        render: (width) => [truncateToWidth(
            `${ctx.ui.theme.fg(count > 0 ? "warning" : "dim", count > 0 ? "●" : "○")} Ask${suffix ? ctx.ui.theme.fg("muted", ` · ${suffix}`) : ""}`,
            width,
        )],
        invalidate() {},
    });
    return {
        base: component(""),
        detail: component(summary),
        full: component([summary, title].filter(Boolean).join(" · ")),
    };
}

export function createQuestionDockContribution(persist: (ctx: ExtensionContext) => void) {
    return createDockContribution({
        id: QUESTION_CONTRIBUTION_ID,
        getSnapshot: getQuestionDockSnapshot,
        activate: (ctx) => openPendingQuestions(ctx, persist),
        standalone: questionDock,
    });
}
