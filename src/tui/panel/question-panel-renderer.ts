/**
 * Terminal renderer of the question panel: frame, header/footer hints, the focused question,
 * its option rows, the submit summary and the option preview pane.
 *
 * It reads the request's `questions` and `draft` but never mutates them; the panel owns the
 * interaction, the draft and the editor, and hands the renderer the transient state it cannot
 * read from the request (`inputMode`, the editor component and the body budget).
 *
 * The renderer's own caches are render state, not session state: the Markdown parser and one
 * preview renderer per question, both dropped by `invalidate()` when the theme changes.
 */
import {
    getMarkdownTheme,
    type Theme,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
    Markdown,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
    formatAnswer,
    questionHeaderPrefix,
    questionTabLabel,
    summarizeText,
} from "../../core/question-format.ts";
import type {
    AskQuestion,
    AskQuestionAnswer,
    AskQuestionRequest,
} from "../../core/question-types.ts";
import {
    MIN_BLOCK_ROWS,
    STACKED_GAP_ROWS,
    decidePreviewLayout,
    leftColumnWidth,
    previewBlockRowBudget,
    previewColumnWidths,
} from "../preview/preview-layout.ts";
import { QuestionPreviewRenderer } from "../preview/preview-renderer.ts";
import {
    areAllAnswered,
    focusedRowIndex,
    questionRows,
    type QuestionRow,
} from "./question-panel-controller.ts";

/** Minimum inner width so the frame math never produces negative repeat counts. */
const PANEL_MIN_INNER_WIDTH = 20;

/** The editor while it owns the keys: only its rendered lines are needed here. */
export interface QuestionPanelEditor {
    render(width: number): string[];
}

export interface QuestionPanelRenderState {
    /** True while the editor owns the keys; the footer and the preview column read it. */
    inputMode: boolean;
    /** Body row budget the overlay grants this render. */
    maxBodyHeight: number;
    /** Editor to draw below the options; absent unless `inputMode` is set. */
    editor?: QuestionPanelEditor;
}

export interface QuestionPanelRendererOptions {
    request: AskQuestionRequest;
    theme: Theme;
}

export class QuestionPanelRenderer {
    private readonly request: AskQuestionRequest;
    private readonly theme: Theme;

    private markdown: Markdown | undefined;
    private markdownText: string | undefined;
    /**
     * One preview renderer per question: an option index only identifies an option inside its
     * own question, so a renderer must not be shared across tabs.
     */
    private readonly previewRenderers = new Map<number, QuestionPreviewRenderer>();

    constructor(options: QuestionPanelRendererOptions) {
        this.request = options.request;
        this.theme = options.theme;
    }

    render(width: number, state: QuestionPanelRenderState): string[] {
        const innerWidth = Math.max(PANEL_MIN_INNER_WIDTH, width - 2);
        const contentWidth = innerWidth - 2;
        // The tab strip stays put while the body scrolls. It is the only way to see which
        // questions exist and to reach the others, so it must not scroll out of view.
        const tabs = this.isMultiQuestion ? this.renderTabsBlock(contentWidth) : [];
        const bodyRoom = Math.max(1, state.maxBodyHeight - tabs.length);
        const { lines: body, focusLine } = this.renderBody(contentWidth, bodyRoom, state);
        const bodyHeight = Math.min(body.length, bodyRoom);
        const visible = [...tabs, ...sliceWindow(body, focusLine, bodyHeight)];

        while (visible.length < tabs.length + bodyHeight) {
            visible.push("");
        }

        return [
            this.frame(`┌${"─".repeat(innerWidth)}┐`),
            this.frame("│") + this.renderHeader(innerWidth) + this.frame("│"),
            this.frame(`├${"─".repeat(innerWidth)}┤`),
            ...visible.map((line) => this.frame("│") + this.cell(line, innerWidth) + this.frame("│")),
            this.frame(`├${"─".repeat(innerWidth)}┤`),
            this.frame("│") + this.renderFooter(innerWidth, state.inputMode) + this.frame("│"),
            this.frame(`└${"─".repeat(innerWidth)}┘`),
        ];
    }

    invalidate(): void {
        this.markdown = undefined;
        this.markdownText = undefined;
        // The renderers hold the markdown theme they were built with, so a theme change has
        // to rebuild them.
        this.previewRenderers.clear();
    }

    private get draft() {
        return this.request.draft;
    }

    private get questions(): readonly AskQuestion[] {
        return this.request.questions;
    }

    private get isMultiQuestion(): boolean {
        return this.questions.length > 1;
    }

    private get isSubmitTab(): boolean {
        return this.draft.currentIndex >= this.questions.length;
    }

    private currentQuestion(): AskQuestion | undefined {
        return this.questions[this.draft.currentIndex];
    }

    private allAnswered(): boolean {
        return areAllAnswered(this.questions, this.draft);
    }

    private renderHeader(width: number): string {
        const contentWidth = width - 2;
        const title = this.theme.bold("Questions");
        const answered = this.draft.answers.filter((answer) => answer !== undefined).length;
        const status = `${answered}/${this.questions.length} answered`;
        const gap = Math.max(1, contentWidth - visibleWidth(title) - visibleWidth(status));

        return this.cell(`${title}${" ".repeat(gap)}${this.theme.fg("muted", status)}`, width);
    }

    private renderFooter(width: number, inputMode: boolean): string {
        const question = this.currentQuestion();

        let hints: string;

        if (inputMode) {
            // Shift+S belongs to the editor while it owns the keys, so the footer must not
            // advertise skip here; Esc leaves the editor and skips from the options.
            hints = "Enter submit · Esc back to options";
        } else if (this.isSubmitTab) {
            hints = `${this.isMultiQuestion ? "Tab/←→ switch · " : ""}Enter submit · ⇧S skip · Esc close`;
        } else if (question?.multiSelect === true) {
            hints = "↑↓ move · Space/Enter toggle · Tab next · ⇧S skip · Esc close";
        } else {
            hints = `↑↓ select · Enter confirm${this.isMultiQuestion ? " · Tab/←→ switch" : ""} · ⇧S skip · Esc close`;
        }

        return this.cell(this.theme.fg("dim", hints), width);
    }

    private renderBody(
        contentWidth: number,
        maxBodyHeight: number,
        state: QuestionPanelRenderState,
    ): { lines: string[]; focusLine: number } {
        const lines: string[] = [];

        if (this.isSubmitTab) {
            lines.push(...this.renderSubmit(contentWidth));

            return { lines, focusLine: 0 };
        }

        const question = this.currentQuestion();

        if (!question) {
            return { lines, focusLine: 0 };
        }

        // One question needs no label at all: the tab strip is what names the questions, and
        // the question text already says what is being asked.
        pushWrapped(
            lines,
            contentWidth,
            "",
            this.theme.fg("text", this.theme.bold(question.question)),
        );

        if (question.displayText) {
            lines.push("");

            for (const line of this.markdownFor(question.displayText).render(contentWidth)) {
                lines.push(line);
            }
        }

        lines.push("");

        const region = this.renderQuestionRegion(
            question,
            contentWidth,
            lines.length,
            maxBodyHeight,
            state.inputMode,
        );
        const focusLine = lines.length + region.focusLine;
        lines.push(...region.lines);

        if (state.inputMode && state.editor) {
            lines.push("");
            pushWrapped(lines, contentWidth, " ", this.theme.fg("muted", "Your answer:"));

            // The editor draws its own frame; one column keeps it inside the panel border.
            for (const line of state.editor.render(Math.max(1, contentWidth - 2))) {
                lines.push(truncateToWidth(` ${line}`, contentWidth, "…", true));
            }

            lines.push("");
            pushWrapped(lines, contentWidth, " ", this.theme.fg("dim", "Enter to submit · Esc to go back"));
        }

        return { lines, focusLine };
    }

    /**
     * The option rows, plus the preview pane when the question has one and the width allows it.
     *
     * `rowsAboveRegion` counts the full-width body rows already rendered above; the preview
     * block is capped to what the window has left, because a block that overflows it would be
     * clipped at the bottom and lose its border.
     *
     * The returned `focusLine` is relative to the returned lines, so the caller can offset it
     * against the full-width body above.
     */
    private renderQuestionRegion(
        question: AskQuestion,
        contentWidth: number,
        rowsAboveRegion: number,
        maxBodyHeight: number,
        inputMode: boolean,
    ): { lines: string[]; focusLine: number } {
        const renderer = this.previewRendererFor(this.draft.currentIndex, question);

        // While the editor is open the focused row is the custom row, which has no preview of
        // its own, and the editor below needs the full width more than a preview does.
        if (inputMode || !renderer.hasAnyPreview()) {
            return this.renderOptionRows(question, contentWidth);
        }

        const leftWidth = leftColumnWidth(this.questions, contentWidth);
        const mode = decidePreviewLayout(contentWidth, leftWidth);
        const columns = previewColumnWidths(contentWidth, leftWidth, mode);
        const rows = this.renderOptionRows(question, columns.leftWidth);
        const stackedGap = mode === "stacked" ? STACKED_GAP_ROWS : 0;
        const rowsAboveBlock = rowsAboveRegion
            + (mode === "stacked" ? rows.lines.length + stackedGap : 0);
        const available = maxBodyHeight - rowsAboveBlock;

        // Too little room left for even a bordered placeholder: the option list keeps the full
        // width instead of showing a clipped box.
        if (available < MIN_BLOCK_ROWS) {
            return this.renderOptionRows(question, contentWidth);
        }

        const block = renderer.render(
            this.draft.optionIndex,
            columns.rightWidth,
            previewBlockRowBudget(mode, available),
        );

        if (mode === "stacked") {
            return {
                lines: [...rows.lines, ...Array<string>(stackedGap).fill(""), ...block.lines],
                focusLine: rows.focusLine,
            };
        }

        return composeColumns(rows, block.lines, columns, contentWidth);
    }

    /** One option row block, wrapped to `contentWidth`. */
    private renderOptionRows(
        question: AskQuestion,
        contentWidth: number,
    ): { lines: string[]; focusLine: number } {
        const lines: string[] = [];
        const rows = questionRows(question);
        const focusedIndex = focusedRowIndex(rows, this.draft.optionIndex);
        const answer = this.draft.answers[this.draft.currentIndex];
        let focusLine = 0;

        for (const [rowIndex, row] of rows.entries()) {
            const focused = rowIndex === focusedIndex;

            if (focused) {
                focusLine = lines.length;
            }

            lines.push(...this.renderRow(question, row, focused, answer, contentWidth));
        }

        return { lines, focusLine };
    }

    private previewRendererFor(questionIndex: number, question: AskQuestion): QuestionPreviewRenderer {
        const cached = this.previewRenderers.get(questionIndex);

        if (cached) {
            return cached;
        }

        const renderer = new QuestionPreviewRenderer({
            question,
            theme: this.theme,
            markdownTheme: getMarkdownTheme(),
        });

        this.previewRenderers.set(questionIndex, renderer);

        return renderer;
    }

    /** Tab strip plus the blank row that separates it from the body below. */
    private renderTabsBlock(contentWidth: number): string[] {
        const lines: string[] = [];

        pushWrapped(lines, contentWidth, "", this.renderTabs());
        lines.push("");

        return lines;
    }

    private renderTabs(): string {
        const parts: string[] = ["← "];

        for (const [index, question] of this.questions.entries()) {
            const answered = this.draft.answers[index] !== undefined;
            const active = !this.isSubmitTab && index === this.draft.currentIndex;
            const text = ` ${answered ? "■" : "□"} ${questionTabLabel(question)} `;

            parts.push(active
                ? this.theme.bg("selectedBg", this.theme.fg("text", text))
                : this.theme.fg(answered ? "success" : "muted", text));
            parts.push(" ");
        }

        const submitActive = this.isSubmitTab;
        const submit = " ✓ Submit ";

        parts.push(submitActive
            ? this.theme.bg("selectedBg", this.theme.fg("text", submit))
            : this.theme.fg(this.allAnswered() ? "success" : "dim", submit));
        parts.push("→");

        return parts.join("");
    }

    private renderRow(
        question: AskQuestion,
        row: QuestionRow,
        focused: boolean,
        answer: AskQuestionAnswer | undefined,
        contentWidth: number,
    ): string[] {
        const lines: string[] = [];

        if (row.kind === "option") {
            const option = question.options?.[row.index];

            if (!option) {
                return lines;
            }

            const chosen = answer?.selectedIndexes.includes(row.index) ?? false;
            const cursor = focused ? this.theme.fg("accent", "›") : " ";
            const marker = question.multiSelect === true
                ? this.theme.fg(chosen ? "success" : "dim", chosen ? "[x]" : "[ ]")
                : this.theme.fg(chosen ? "success" : "dim", chosen ? "●" : "○");
            const label = `${row.index + 1}. ${option.label}`;
            const labelColor: ThemeColor = focused || chosen ? "accent" : "text";

            pushWrapped(
                lines,
                contentWidth,
                `${cursor} ${marker} `,
                this.theme.fg(labelColor, focused ? this.theme.bold(label) : label),
            );

            if (option.description) {
                pushWrapped(lines, contentWidth, "      ", this.theme.fg("muted", option.description));
            }

            return lines;
        }

        if (row.kind === "custom") {
            const questionIndex = this.draft.currentIndex;
            // Only a committed answer is shown here. Mirroring the draft would make the row
            // rewrite itself on every keystroke while the editor below shows the same text,
            // and it would follow edits to an answer that was already written.
            const written = this.draft.answers[questionIndex]?.customText;

            if (written !== undefined && written.length > 0) {
                pushWrapped(
                    lines,
                    contentWidth,
                    `${focused ? this.theme.fg("accent", "›") : " "} ${this.theme.fg("dim", "✎")} `,
                    this.theme.fg(focused ? "accent" : "text", summarizeText(written, Math.max(4, contentWidth - 8))),
                );
            } else {
                pushWrapped(
                    lines,
                    contentWidth,
                    `${focused ? this.theme.fg("accent", "›") : " "} ${this.theme.fg("dim", "✎")} `,
                    this.theme.fg(focused ? "accent" : "text", "Type something"),
                );
                pushWrapped(lines, contentWidth, "      ", this.theme.fg("muted", "write your own answer"));
            }

            return lines;
        }

        pushWrapped(
            lines,
            contentWidth,
            `${focused ? this.theme.fg("accent", "›") : " "} ${this.theme.fg("dim", "→")} `,
            this.theme.fg(focused ? "accent" : "text", "Next"),
        );
        pushWrapped(lines, contentWidth, "      ", this.theme.fg("muted", "confirm the selection"));

        return lines;
    }

    private renderSubmit(contentWidth: number): string[] {
        const lines: string[] = [];

        pushWrapped(lines, contentWidth, "", this.theme.fg("accent", this.theme.bold("Ready to submit")));
        lines.push("");

        for (const [index, question] of this.questions.entries()) {
            const answer = this.draft.answers[index];

            pushWrapped(
                lines,
                contentWidth,
                "",
                `${this.theme.fg("muted", questionHeaderPrefix(question))}${this.theme.fg("text", summarizeText(question.question, 48))}`,
            );

            const summary = formatAnswer(question, answer);

            pushWrapped(
                lines,
                contentWidth,
                "    ",
                summary === undefined
                    ? this.theme.fg("warning", "unanswered")
                    : this.theme.fg("text", summary),
            );
        }

        lines.push("");

        if (this.allAnswered()) {
            pushWrapped(lines, contentWidth, "", this.theme.fg("success", "Press Enter to submit"));
        } else {
            const missing = this.questions
                .filter((_, index) => this.draft.answers[index] === undefined)
                .map((question) => questionTabLabel(question))
                .join(", ");

            pushWrapped(lines, contentWidth, "", this.theme.fg("warning", `Unanswered: ${missing}`));
        }

        return lines;
    }

    private markdownFor(text: string): Markdown {
        if (!this.markdown || this.markdownText !== text) {
            this.markdown = new Markdown(text, 0, 0, getMarkdownTheme());
            this.markdownText = text;
        }

        return this.markdown;
    }

    private frame(text: string): string {
        return this.theme.fg("border", text);
    }

    private cell(text: string, width: number): string {
        return ` ${truncateToWidth(text, Math.max(0, width - 2), "…", true)} `;
    }
}

/** Window over the body that keeps the focused row visible without following the tail. */
function sliceWindow(lines: readonly string[], focusLine: number, height: number): string[] {
    const maxOffset = Math.max(0, lines.length - height);
    const offset = Math.min(maxOffset, Math.max(0, focusLine - Math.floor(height / 2)));

    return lines.slice(offset, offset + height);
}

/**
 * Join the option column and the preview box row by row.
 *
 * The box is right-aligned inside its column so its border lines up with the panel border
 * instead of leaving an invisible tail of blank columns.
 */
function composeColumns(
    left: { lines: readonly string[]; focusLine: number },
    right: readonly string[],
    columns: { leftWidth: number; rightWidth: number; gap: number },
    contentWidth: number,
): { lines: string[]; focusLine: number } {
    const gap = " ".repeat(columns.gap);
    const rows = Math.max(left.lines.length, right.length);
    const lines: string[] = [];

    for (let index = 0; index < rows; index++) {
        const leftCell = padEndCell(left.lines[index] ?? "", columns.leftWidth);
        const rightCell = padStartCell(right[index] ?? "", columns.rightWidth);

        lines.push(truncateToWidth(`${leftCell}${gap}${rightCell}`, contentWidth, "…", true));
    }

    return { lines, focusLine: left.focusLine };
}

function padEndCell(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "…");

    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function padStartCell(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "…");

    return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

function pushWrapped(
    lines: string[],
    contentWidth: number,
    prefix: string,
    text: string,
): void {
    const prefixWidth = visibleWidth(prefix);
    const available = Math.max(1, contentWidth - prefixWidth);
    const wrapped = wrapTextWithAnsi(text, available);
    const continuation = " ".repeat(prefixWidth);

    for (const [index, line] of wrapped.entries()) {
        lines.push(truncateToWidth(`${index === 0 ? prefix : continuation}${line}`, contentWidth, "…", true));
    }
}
