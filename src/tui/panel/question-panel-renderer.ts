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
/** Top border, header and the separator above the body. */
const BODY_TOP = 3;
/** Left border plus the cell's leading space. */
const CONTENT_LEFT = 2;
/** The editor is drawn one column in from the content edge. */
const EDITOR_INSET = 1;

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
    /** First body row to show; `undefined` keeps the focused row centered. */
    bodyScroll?: number;
    /** First preview content row to show. */
    previewScroll?: number;
}

/** Panel-local column span `[start, end)` on one row. */
export interface PanelSpan {
    y: number;
    start: number;
    end: number;
}

/** Panel-local rectangle; `x`/`y` is the top-left cell. */
export interface PanelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type TabTarget = { kind: "tab"; index: number } | { kind: "step"; step: number };

/**
 * Where the last frame put each interactive element. Mouse events arrive in overlay-local
 * cells, so hit-testing has to use the geometry the user actually sees.
 */
export interface QuestionPanelLayout {
    tabs: Array<PanelSpan & { target: TabTarget }>;
    /** Visible lines of each option row; `rowIndex` is its position in `questionRows`. */
    rows: Array<PanelSpan & { rowIndex: number }>;
    body: PanelRect & { offset: number; maxOffset: number };
    preview?: PanelRect & { offset: number; maxOffset: number };
    /** The editor's full extent, `y` possibly outside the body window when it is scrolled. */
    editor?: PanelRect;
}

export interface QuestionPanelFrame {
    lines: string[];
    layout: QuestionPanelLayout;
}

/** Body-relative positions collected while the body is built. */
interface BodyMarks {
    rows: Array<{ line: number; end: number; rowIndex: number }>;
    preview?: { line: number; height: number; start: number; width: number; offset: number; maxOffset: number };
    editor?: { line: number; height: number; width: number };
}

interface RenderedBody {
    lines: string[];
    focusLine: number;
    marks: BodyMarks;
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

    render(width: number, state: QuestionPanelRenderState): QuestionPanelFrame {
        const innerWidth = Math.max(PANEL_MIN_INNER_WIDTH, width - 2);
        const contentWidth = innerWidth - 2;
        // The tab strip stays put while the body scrolls. It is the only way to see which
        // questions exist and to reach the others, so it must not scroll out of view.
        const tabs = this.isMultiQuestion
            ? this.renderTabsBlock(contentWidth)
            : { lines: [], spans: [] };
        const bodyRoom = Math.max(1, state.maxBodyHeight - tabs.lines.length);
        const body = this.renderBody(contentWidth, bodyRoom, state);
        const bodyHeight = Math.min(body.lines.length, bodyRoom);
        const window = bodyWindow(body.lines.length, body.focusLine, bodyHeight, state.bodyScroll);
        const visible = [...tabs.lines, ...body.lines.slice(window.offset, window.offset + bodyHeight)];

        while (visible.length < tabs.lines.length + bodyHeight) {
            visible.push("");
        }

        const layout = this.layoutFor(tabs.spans, body.marks, {
            x: CONTENT_LEFT,
            y: BODY_TOP + tabs.lines.length,
            width: contentWidth,
            height: bodyHeight,
            ...window,
        });

        const lines = [
            this.frame(`┌${"─".repeat(innerWidth)}┐`),
            this.frame("│") + this.renderHeader(innerWidth) + this.frame("│"),
            this.frame(`├${"─".repeat(innerWidth)}┤`),
            ...visible.map((line) => this.frame("│") + this.cell(line, innerWidth) + this.frame("│")),
            this.frame(`├${"─".repeat(innerWidth)}┤`),
            this.frame("│") + this.renderFooter(innerWidth, state.inputMode) + this.frame("│"),
            this.frame(`└${"─".repeat(innerWidth)}┘`),
        ];

        return { lines, layout };
    }

    /** Moves the body-relative marks into panel coordinates, keeping only what is on screen. */
    private layoutFor(
        tabs: QuestionPanelLayout["tabs"],
        marks: BodyMarks,
        body: QuestionPanelLayout["body"],
    ): QuestionPanelLayout {
        const toPanel = (line: number) => body.y + line - body.offset;
        const onScreen = (line: number) => line >= body.offset && line < body.offset + body.height;

        const rows = marks.rows
            .filter((row) => onScreen(row.line))
            .map((row) => ({
                y: toPanel(row.line),
                start: body.x,
                end: body.x + row.end,
                rowIndex: row.rowIndex,
            }));

        const layout: QuestionPanelLayout = { tabs, rows, body };

        if (marks.preview) {
            const top = Math.max(marks.preview.line, body.offset);
            const bottom = Math.min(marks.preview.line + marks.preview.height, body.offset + body.height);

            if (bottom > top) {
                layout.preview = {
                    x: body.x + marks.preview.start,
                    y: toPanel(top),
                    width: marks.preview.width,
                    height: bottom - top,
                    offset: marks.preview.offset,
                    maxOffset: marks.preview.maxOffset,
                };
            }
        }

        if (marks.editor) {
            layout.editor = {
                x: body.x + EDITOR_INSET,
                y: toPanel(marks.editor.line),
                width: marks.editor.width,
                height: marks.editor.height,
            };
        }

        return layout;
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
    ): RenderedBody {
        const lines: string[] = [];
        const marks: BodyMarks = { rows: [] };

        if (this.isSubmitTab) {
            lines.push(...this.renderSubmit(contentWidth));

            return { lines, focusLine: 0, marks };
        }

        const question = this.currentQuestion();

        if (!question) {
            return { lines, focusLine: 0, marks };
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
            state.previewScroll ?? 0,
        );
        const regionTop = lines.length;
        const focusLine = regionTop + region.focusLine;
        lines.push(...region.lines);

        marks.rows = region.rows.map((row) => ({ ...row, line: regionTop + row.line }));

        if (region.preview) {
            marks.preview = { ...region.preview, line: regionTop + region.preview.line };
        }

        if (state.inputMode && state.editor) {
            lines.push("");
            pushWrapped(lines, contentWidth, " ", this.theme.fg("muted", "Your answer:"));

            // The editor draws its own frame; one column keeps it inside the panel border.
            const editorWidth = Math.max(1, contentWidth - 2);
            const editorLines = state.editor.render(editorWidth);

            marks.editor = { line: lines.length, height: editorLines.length, width: editorWidth };

            for (const line of editorLines) {
                lines.push(truncateToWidth(`${" ".repeat(EDITOR_INSET)}${line}`, contentWidth, "…", true));
            }

            lines.push("");
            pushWrapped(lines, contentWidth, " ", this.theme.fg("dim", "Enter to submit · Esc to go back"));
        }

        return { lines, focusLine, marks };
    }

    /**
     * The option rows, plus the preview pane when the question has one and the width allows it.
     *
     * `rowsAboveRegion` counts the full-width body rows already rendered above; the preview
     * block is capped to what the window has left, because a block that overflows it would be
     * clipped at the bottom and lose its border.
     *
     * The returned `focusLine` and marks are relative to the returned lines, so the caller can
     * offset them against the full-width body above.
     */
    private renderQuestionRegion(
        question: AskQuestion,
        contentWidth: number,
        rowsAboveRegion: number,
        maxBodyHeight: number,
        inputMode: boolean,
        previewScroll: number,
    ): OptionRegion {
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
            previewScroll,
        );
        const scroll = { offset: block.offset, maxOffset: block.maxOffset };

        if (mode === "stacked") {
            return {
                lines: [...rows.lines, ...Array<string>(stackedGap).fill(""), ...block.lines],
                focusLine: rows.focusLine,
                rows: rows.rows,
                preview: {
                    line: rows.lines.length + stackedGap,
                    height: block.lines.length,
                    start: 0,
                    width: contentWidth,
                    ...scroll,
                },
            };
        }

        const previewStart = columns.leftWidth + columns.gap;

        return {
            ...composeColumns(rows, block.lines, columns, contentWidth),
            rows: rows.rows,
            preview: {
                line: 0,
                height: block.lines.length,
                start: previewStart,
                width: contentWidth - previewStart,
                ...scroll,
            },
        };
    }

    /** One option row block, wrapped to `contentWidth`. */
    private renderOptionRows(question: AskQuestion, contentWidth: number): OptionRegion {
        const lines: string[] = [];
        const rows = questionRows(question);
        const focusedIndex = focusedRowIndex(rows, this.draft.optionIndex);
        const answer = this.draft.answers[this.draft.currentIndex];
        const marks: OptionRegion["rows"] = [];
        let focusLine = 0;

        for (const [rowIndex, row] of rows.entries()) {
            const focused = rowIndex === focusedIndex;

            if (focused) {
                focusLine = lines.length;
            }

            for (const line of this.renderRow(question, row, focused, answer, contentWidth)) {
                marks.push({ line: lines.length, end: contentWidth, rowIndex });
                lines.push(line);
            }
        }

        return { lines, focusLine, rows: marks };
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

    /**
     * Tab strip plus the blank row that separates it from the body below.
     *
     * The strip wraps between tabs, never inside one, so every tab stays one clickable span.
     */
    private renderTabsBlock(contentWidth: number): { lines: string[]; spans: QuestionPanelLayout["tabs"] } {
        const lines: string[] = [];
        const spans: QuestionPanelLayout["tabs"] = [];
        let line = "";
        let column = 0;

        for (const segment of this.tabSegments()) {
            const text = truncateToWidth(segment.text, contentWidth, "…");
            const width = visibleWidth(text);

            if (column > 0 && column + width > contentWidth) {
                if (segment.target === undefined) {
                    // A separator space must not start the next line.
                    continue;
                }

                lines.push(line);
                line = "";
                column = 0;
            }

            if (segment.target) {
                spans.push({
                    y: BODY_TOP + lines.length,
                    start: CONTENT_LEFT + column,
                    end: CONTENT_LEFT + column + width,
                    target: segment.target,
                });
            }

            line += segment.style(text);
            column += width;
        }

        lines.push(line, "");

        return { lines, spans };
    }

    private tabSegments(): Array<{ text: string; style: (text: string) => string; target?: TabTarget }> {
        const plain = (text: string) => text;
        const segments: ReturnType<QuestionPanelRenderer["tabSegments"]> = [
            { text: "←", style: plain, target: { kind: "step", step: -1 } },
            { text: " ", style: plain },
        ];

        for (const [index, question] of this.questions.entries()) {
            const answered = this.draft.answers[index] !== undefined;
            const active = !this.isSubmitTab && index === this.draft.currentIndex;

            segments.push({
                text: ` ${answered ? "■" : "□"} ${questionTabLabel(question)} `,
                style: (text) => active
                    ? this.theme.bg("selectedBg", this.theme.fg("text", text))
                    : this.theme.fg(answered ? "success" : "muted", text),
                target: { kind: "tab", index },
            });
            segments.push({ text: " ", style: plain });
        }

        segments.push(
            {
                text: " ✓ Submit ",
                style: (text) => this.isSubmitTab
                    ? this.theme.bg("selectedBg", this.theme.fg("text", text))
                    : this.theme.fg(this.allAnswered() ? "success" : "dim", text),
                target: { kind: "tab", index: this.questions.length },
            },
            { text: "→", style: plain, target: { kind: "step", step: 1 } },
        );

        return segments;
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

/** Option rows, optionally with the preview block, and where each part landed. */
interface OptionRegion {
    lines: string[];
    focusLine: number;
    rows: Array<{ line: number; end: number; rowIndex: number }>;
    preview?: NonNullable<BodyMarks["preview"]>;
}

/**
 * Window over the body. Without an explicit scroll it keeps the focused row visible without
 * following the tail; a wheel scroll pins it wherever the user left it.
 */
function bodyWindow(
    length: number,
    focusLine: number,
    height: number,
    scroll: number | undefined,
): { offset: number; maxOffset: number } {
    const maxOffset = Math.max(0, length - height);
    const wanted = scroll ?? focusLine - Math.floor(height / 2);

    return { offset: Math.min(maxOffset, Math.max(0, wanted)), maxOffset };
}

/**
 * Join the option column and the preview box row by row.
 *
 * The box is right-aligned inside its column so its border lines up with the panel border
 * instead of leaving an invisible tail of blank columns.
 */
function composeColumns(
    left: { lines: readonly string[]; focusLine: number; rows: OptionRegion["rows"] },
    right: readonly string[],
    columns: { leftWidth: number; rightWidth: number; gap: number },
    contentWidth: number,
): { lines: string[]; focusLine: number; rows: OptionRegion["rows"] } {
    const gap = " ".repeat(columns.gap);
    const height = Math.max(left.lines.length, right.length);
    const lines: string[] = [];

    for (let index = 0; index < height; index++) {
        const leftCell = padEndCell(left.lines[index] ?? "", columns.leftWidth);
        const rightCell = padStartCell(right[index] ?? "", columns.rightWidth);

        lines.push(truncateToWidth(`${leftCell}${gap}${rightCell}`, contentWidth, "…", true));
    }

    // A click on the gap or the preview must not pick the option on the same row.
    const rows = left.rows.map((row) => ({ ...row, end: Math.min(row.end, columns.leftWidth) }));

    return { lines, focusLine: left.focusLine, rows };
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
