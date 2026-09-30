import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { summarizeText } from "../core/question-format.ts";
import { questionManager } from "../core/questionManager.ts";

const WIDGET_ID = "lune-ask-question";

/** Budget for the question preview before the hint; keeps the hint visible on narrow terminals. */
const SUMMARY_MAX_WIDTH = 40;

/**
 * Persistent hint below the editor that a question is waiting.
 *
 * The panel itself is transient: Esc closes it, so without this row a closed panel
 * would be invisible until the user remembered `/question`.
 */
export class QuestionDock {
    private ctx: ExtensionContext | undefined;

    setCtx(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }

    render(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        const pending = questionManager.getPendingRequests();

        if (pending.length === 0) {
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
            return;
        }

        const theme = this.ctx.ui.theme;
        const count = `${pending.length} pending ${pending.length === 1 ? "question" : "questions"}`;
        const summary = summarizeText(pending[0]!.questions[0]?.question ?? "", SUMMARY_MAX_WIDTH);

        this.ctx.ui.setWidget(
            WIDGET_ID,
            [
                [
                    theme.fg("accent", count),
                    summary.length > 0 ? theme.fg("muted", summary) : undefined,
                    theme.fg("dim", "/question to answer"),
                ]
                    .filter((part): part is string => part !== undefined)
                    .join(theme.fg("dim", " · ")),
            ],
            {
                placement: "belowEditor",
            },
        );
    }

    clear(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        this.ctx.ui.setWidget(WIDGET_ID, undefined);
    }
}

export const questionDock = new QuestionDock();
