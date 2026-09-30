/**
 * Pure layout decisions for the option preview column: whether a question has previews at
 * all, how wide the option column has to be, and how the content width is split.
 *
 * Everything here is a function of data the caller passes in — no session, no manager, no
 * per-render state — so the panel always renders the layout it just measured.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AskQuestion, AskQuestionOption } from "../core/question-types.ts";
import { BORDER_VERTICAL_OVERHEAD } from "./preview-box.ts";

/**
 * Columns between the option list and the preview box: two blank columns plus one inset so
 * the box border is not glued to the labels.
 */
export const PREVIEW_COLUMN_GAP = 3;
/** Minimum width of the preview box itself; below this the layout stacks. */
export const MIN_PREVIEW_WIDTH = 45;
/** Floor for the option column: it fits the "Type something" row and a short label. */
export const MIN_LEFT_WIDTH = 30;
/** The option column never takes more than this share of the content width. */
export const MAX_LEFT_RATIO = 0.5;
/** Preview block height cap when the columns sit side by side. */
export const PREVIEW_MAX_BLOCK_ROWS_SIDE_BY_SIDE = 14;
/** Preview block height cap when the preview sits under the options. */
export const PREVIEW_MAX_BLOCK_ROWS_STACKED = 10;
/** Blank rows between the option list and a stacked preview block. */
export const STACKED_GAP_ROWS = 1;
/** Smallest block worth drawing: two borders and one content row. */
export const MIN_BLOCK_ROWS = BORDER_VERTICAL_OVERHEAD + 1;

export type PreviewLayoutMode = "side-by-side" | "stacked";

/** Whitespace-only previews would render as an empty box, so they count as absent. */
export function optionHasPreview(option: AskQuestionOption): boolean {
    return typeof option.preview === "string" && option.preview.trim().length > 0;
}

export function questionHasPreview(question: AskQuestion): boolean {
    return (question.options ?? []).some((option) => optionHasPreview(option));
}

/**
 * Width of an option row as the panel draws it: cursor column, selection marker, numbering
 * and label. Measuring the label alone would under-reserve every row that carries a marker.
 */
function optionRowWidth(question: AskQuestion, option: AskQuestionOption): number {
    const markerWidth = question.multiSelect === true ? 3 : 1; // "[x]" vs "●"
    const numberingWidth = String(Math.max(1, question.options?.length ?? 0)).length + 2; // "1. "

    return 2 + markerWidth + 1 + numberingWidth + visibleWidth(option.label);
}

/**
 * Width of the option column for the whole request.
 *
 * It stays the same for every question of the request — the panel switches tabs without the
 * columns moving — so the widest row of the widest question wins.
 */
export function leftColumnWidth(questions: readonly AskQuestion[], contentWidth: number): number {
    let desired = 0;

    for (const question of questions) {
        for (const option of question.options ?? []) {
            desired = Math.max(desired, optionRowWidth(question, option));
        }
    }

    const ceiling = Math.max(
        1,
        Math.min(
            Math.floor(contentWidth * MAX_LEFT_RATIO),
            contentWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH,
        ),
    );

    return Math.max(MIN_LEFT_WIDTH, Math.min(desired, ceiling));
}

/**
 * Side by side only when the measured option column, the gap and a usable preview box fit:
 * a fixed threshold would either stack usable widths or squeeze the box into unusable ones.
 */
export function decidePreviewLayout(contentWidth: number, leftWidth: number): PreviewLayoutMode {
    return contentWidth >= leftWidth + PREVIEW_COLUMN_GAP + MIN_PREVIEW_WIDTH ? "side-by-side" : "stacked";
}

export function previewColumnWidths(
    contentWidth: number,
    leftWidth: number,
    mode: PreviewLayoutMode,
): { leftWidth: number; rightWidth: number; gap: number } {
    if (mode === "stacked") {
        return { leftWidth: contentWidth, rightWidth: contentWidth, gap: 0 };
    }

    const gap = PREVIEW_COLUMN_GAP;
    const fittedLeft = Math.min(leftWidth, Math.max(1, contentWidth - gap - 1));

    return { leftWidth: fittedLeft, rightWidth: Math.max(1, contentWidth - fittedLeft - gap), gap };
}

/**
 * Row budget for the preview block: the rows the caller can spare, capped per layout.
 *
 * The caller subtracts what already occupies the body (header, option rows, gap); a block
 * taller than that would be clipped by the panel window and lose its bottom border.
 */
export function previewBlockRowBudget(mode: PreviewLayoutMode, availableRows: number): number {
    const cap = mode === "side-by-side"
        ? PREVIEW_MAX_BLOCK_ROWS_SIDE_BY_SIDE
        : PREVIEW_MAX_BLOCK_ROWS_STACKED;

    return Math.max(MIN_BLOCK_ROWS, Math.min(cap, availableRows));
}
