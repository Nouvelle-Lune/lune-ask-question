/**
 * Pure layout decisions for the option preview column: availability, left column width,
 * side-by-side vs stacked, and the row budget handed to the preview renderer.
 *
 * The left column is measured from the option rows as they are actually drawn — cursor,
 * selection marker and numbering included — so a wider marker (multi-select checkboxes) or
 * a two-digit number cannot push the label into a wrap.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { AskQuestion } from "../../src/core/questionManager.ts";
import {
    BORDER_VERTICAL_OVERHEAD,
    MIN_BOX_INNER_WIDTH,
} from "../../src/tui/preview-box.ts";
import {
    MAX_LEFT_RATIO,
    MIN_LEFT_WIDTH,
    MIN_PREVIEW_WIDTH,
    PREVIEW_COLUMN_GAP,
    PREVIEW_MAX_BLOCK_ROWS_SIDE_BY_SIDE,
    PREVIEW_MAX_BLOCK_ROWS_STACKED,
    decidePreviewLayout,
    leftColumnWidth,
    optionHasPreview,
    previewBlockRowBudget,
    previewColumnWidths,
    questionHasPreview,
} from "../../src/tui/preview-layout.ts";

function singleSelect(label: string): AskQuestion {
    return { question: "Q?", options: [{ label: "a" }, { label }] };
}

describe("preview layout", () => {
    describe("availability", () => {
        it("treats a missing, empty or whitespace-only preview as absent", () => {
            assert.equal(optionHasPreview({ label: "a" }), false);
            assert.equal(optionHasPreview({ label: "a", preview: "" }), false);
            assert.equal(optionHasPreview({ label: "a", preview: "   \n " }), false);
            assert.equal(optionHasPreview({ label: "a", preview: "x" }), true);
        });

        it("enables the preview column when one option carries a preview", () => {
            assert.equal(
                questionHasPreview({ question: "Q?", options: [{ label: "a" }, { label: "b" }] }),
                false,
            );
            assert.equal(
                questionHasPreview({ question: "Q?", options: [{ label: "a" }, { label: "b", preview: "x" }] }),
                true,
            );
        });
    });

    describe("leftColumnWidth", () => {
        it("counts the cursor, the marker and the numbering", () => {
            // "› ● 1. " = 7 columns, so a 30 column label needs 37.
            assert.equal(leftColumnWidth([singleSelect("x".repeat(30))], 200), 37);
        });

        it("reserves the wider checkbox marker for multi-select questions", () => {
            const single = singleSelect("y".repeat(40));
            const multi: AskQuestion = {
                question: "Multi?",
                multiSelect: true,
                options: [{ label: "a" }, { label: "y".repeat(40) }],
            };

            assert.equal(leftColumnWidth([single], 200), 47);
            assert.equal(leftColumnWidth([multi], 200), 49);
            assert.equal(leftColumnWidth([single, multi], 200), 49);
            assert.equal(leftColumnWidth([multi, single], 200), 49);
        });

        it("is driven by the widest option of the whole request", () => {
            const short: AskQuestion = { question: "Q1?", options: [{ label: "a" }, { label: "b" }] };
            const long = singleSelect("z".repeat(60));

            assert.equal(leftColumnWidth([short, long], 200), leftColumnWidth([long, short], 200));
            assert.equal(leftColumnWidth([short, long], 200), 67);
            assert.equal(leftColumnWidth([short], 200), MIN_LEFT_WIDTH);
        });

        it("keeps room for the free-form row", () => {
            assert.equal(MIN_LEFT_WIDTH >= visibleWidth("› ✎ Type something"), true);
            assert.equal(leftColumnWidth([singleSelect("a")], 200), MIN_LEFT_WIDTH);
        });

        it("measures columns, not code units", () => {
            // 20 CJK characters are 40 columns wide.
            assert.equal(leftColumnWidth([singleSelect("测".repeat(20))], 200), 47);
        });

        it("never takes more than half of the content width", () => {
            const wide = singleSelect("w".repeat(400));
            const contentWidth = 100;

            assert.equal(leftColumnWidth([wide], contentWidth), Math.floor(contentWidth * MAX_LEFT_RATIO));
        });

        it("leaves the preview its minimum width whenever the layout splits", () => {
            const wide = singleSelect("w".repeat(400));

            for (const contentWidth of [78, 100, 160]) {
                const leftWidth = leftColumnWidth([wide], contentWidth);

                assert.equal(decidePreviewLayout(contentWidth, leftWidth), "side-by-side");
                assert.ok(
                    leftWidth <= contentWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH,
                    `left column leaves less than MIN_PREVIEW_WIDTH at ${contentWidth}`,
                );
            }
        });
    });

    describe("decidePreviewLayout", () => {
        it("needs room for the left column, the gap and the preview column", () => {
            const leftWidth = 30;
            const minimum = leftWidth + PREVIEW_COLUMN_GAP + MIN_PREVIEW_WIDTH;

            assert.equal(decidePreviewLayout(minimum, leftWidth), "side-by-side");
            assert.equal(decidePreviewLayout(minimum - 1, leftWidth), "stacked");
        });

        it("stacks when the panel is too narrow for any useful preview", () => {
            assert.equal(decidePreviewLayout(76, leftColumnWidth([singleSelect("a")], 76)), "stacked");
        });
    });

    describe("previewColumnWidths", () => {
        it("splits the content width without losing a column", () => {
            const { leftWidth, rightWidth, gap } = previewColumnWidths(116, 30, "side-by-side");

            assert.equal(leftWidth, 30);
            assert.equal(gap, PREVIEW_COLUMN_GAP);
            assert.equal(rightWidth, 116 - 30 - PREVIEW_COLUMN_GAP);
            assert.ok(rightWidth >= MIN_PREVIEW_WIDTH);
        });

        it("gives both columns the full width when stacked", () => {
            assert.deepEqual(previewColumnWidths(76, 30, "stacked"), { leftWidth: 76, rightWidth: 76, gap: 0 });
        });
    });

    describe("previewBlockRowBudget", () => {
        it("caps the preview height per layout", () => {
            assert.equal(previewBlockRowBudget("side-by-side", 40), PREVIEW_MAX_BLOCK_ROWS_SIDE_BY_SIDE);
            assert.equal(previewBlockRowBudget("stacked", 40), PREVIEW_MAX_BLOCK_ROWS_STACKED);
        });

        it("never exceeds the body height", () => {
            assert.equal(previewBlockRowBudget("side-by-side", 6), 6);
        });

        it("always leaves room for the borders and one content row", () => {
            assert.equal(previewBlockRowBudget("stacked", 0), BORDER_VERTICAL_OVERHEAD + 1);
            assert.equal(previewBlockRowBudget("stacked", 1), BORDER_VERTICAL_OVERHEAD + 1);
        });
    });

    describe("budget sanity", () => {
        it("can fit the minimum preview box inside the preview column", () => {
            assert.ok(MIN_PREVIEW_WIDTH >= MIN_BOX_INNER_WIDTH + 4);
        });
    });
});
