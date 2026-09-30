import {
    getMarkdownTheme,
    type ExtensionContext,
    type Theme,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";

import {
    Editor,
    Key,
    Markdown,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type EditorTheme,
    type Focusable,
    type KeybindingsManager,
    type TUI,
} from "@earendil-works/pi-tui";

import { formatAnswer, questionHeaderPrefix, questionTabLabel, summarizeText } from "../core/question-format.ts";
import {
    questionManager,
    type AskQuestion,
    type AskQuestionAnswer,
    type AskQuestionDraft,
    type AskQuestionRequest,
} from "../core/questionManager.ts";
import {
    MIN_BLOCK_ROWS,
    STACKED_GAP_ROWS,
    decidePreviewLayout,
    leftColumnWidth,
    previewBlockRowBudget,
    previewColumnWidths,
} from "./preview-layout.ts";
import { QuestionPreviewRenderer } from "./preview-renderer.ts";

const OVERLAY_WIDTH = "80%";
const OVERLAY_MIN_WIDTH = 70;
/**
 * The overlay is clamped to the terminal minus its margins, so a taller share than this buys
 * nothing; 90% is what a short terminal needs for the preview block to fit at all.
 */
const OVERLAY_MAX_HEIGHT = "90%";
const OVERLAY_HEIGHT_RATIO = 0.9;
const OVERLAY_MARGIN = 2;

/** Frame rows: top border, header, two separators, footer, bottom border. */
const FRAME_HEIGHT = 6;

/** One selectable line of the focused question, in panel order. */
type QuestionRow =
    | { kind: "option"; index: number }
    | { kind: "custom" }
    | { kind: "next" };

/** Minimum inner width so the frame math never produces negative repeat counts. */
const PANEL_MIN_INNER_WIDTH = 20;

export interface OpenQuestionPanelOptions {
    /**
     * Persist the pending questions after a deferred (Esc) close.
     *
     * Only the extension knows `pi`, and without this hook the answers written before
     * the close would not survive a restart.
     */
    onDeferred?: () => void;
}

/**
 * Why a panel closed: a settled one hands over to the next pending request, while a deferred
 * one (Esc) leaves its request pending and only closes the overlay.
 */
export type PanelCloseReason = "settled" | "deferred";

/**
 * Ownership of the single overlay.
 *
 * A panel is a long-lived async operation and a session boundary resets module state, so a
 * flag is not enough: a panel that resolves after the reset would clear the ownership of the
 * panel that replaced it. The generation is bumped on every reset, and the owner symbol
 * identifies one invocation, so a stale continuation can neither release nor continue the
 * new panel.
 */
let panelGeneration = 0;
let panelOwner: symbol | undefined;

/**
 * A session boundary disposes overlays without resolving their custom() promise in some
 * cases, so the ownership must not survive into the next session and block `/question`.
 */
export function resetQuestionPanelState(): void {
    panelGeneration++;
    panelOwner = undefined;
}

/**
 * Show pending requests, least recently shown first, until there is nothing left to answer.
 *
 * Called immediately after a request is created, and again from `/question`. A request that
 * arrives while a panel is open does not have to wait for `/question`: it is already pending,
 * so the loop picks it up as soon as the current panel settles - and because it was never
 * shown, it comes before a request the user only deferred. Deferring (Esc) ends the loop on
 * purpose - the user asked for quiet, not for the next question - and the request stays pending
 * for `/question`.
 *
 * The panel never settles the request when Esc closes it, so the promise completing only
 * means the overlay is gone, not that the questions were answered.
 */
export async function openQuestionPanel(
    ctx: ExtensionContext,
    options: OpenQuestionPanelOptions = {},
): Promise<void> {
    if (ctx.mode !== "tui" || panelOwner !== undefined) {
        return;
    }

    const generation = panelGeneration;
    const owner = Symbol("question-panel");

    panelOwner = owner;

    try {
        let reason: PanelCloseReason | undefined;

        do {
            const request = questionManager.nextPendingRequest();

            if (!request) {
                break;
            }

            // Claim it before showing it, so a request the user defers does not outrank one
            // that has never been shown.
            questionManager.markShown(request.id);

            reason = await showQuestionPanel(ctx, request, options);

            // The session may have been replaced while the overlay was up; that session owns
            // its own panel now, and this one must not continue into its queue.
            if (panelGeneration !== generation || panelOwner !== owner) {
                return;
            }
        } while (reason === "settled" && questionManager.getPendingRequests().length > 0);
    } finally {
        if (panelGeneration === generation && panelOwner === owner) {
            panelOwner = undefined;
        }
    }
}

/** One overlay for one request; `undefined` when it could not be opened at all. */
async function showQuestionPanel(
    ctx: ExtensionContext,
    request: AskQuestionRequest,
    options: OpenQuestionPanelOptions,
): Promise<PanelCloseReason | undefined> {
    try {
        return await ctx.ui.custom<PanelCloseReason>(
            (tui, theme, keybindings, done) =>
                new QuestionPanel({
                    request,
                    tui,
                    theme,
                    keybindings,
                    close: (reason) => done(reason),
                    onDeferred: options.onDeferred,
                }),
            {
                overlay: true,
                overlayOptions: {
                    anchor: "center",
                    width: OVERLAY_WIDTH,
                    minWidth: OVERLAY_MIN_WIDTH,
                    maxHeight: OVERLAY_MAX_HEIGHT,
                    margin: OVERLAY_MARGIN,
                },
            },
        );
    } catch (error) {
        // Opening failed: stop instead of retrying into the same error.
        ctx.ui.notify(
            `Question panel failed to open: ${error instanceof Error ? error.message : String(error)}`,
            "error",
        );

        return undefined;
    }
}

export interface QuestionPanelOptions {
    request: AskQuestionRequest;
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    close: (reason: PanelCloseReason) => void;
    onDeferred?: () => void;
}

export class QuestionPanel implements Component, Focusable {
    /** Set by the TUI when this overlay owns input. */
    focused = false;

    private readonly request: AskQuestionRequest;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly requestRender: () => void;
    private readonly terminalRows: () => number;
    private readonly close: (reason: PanelCloseReason) => void;
    private readonly onDeferred: (() => void) | undefined;

    private readonly editor: Editor;
    private inputMode = false;

    private markdown: Markdown | undefined;
    private markdownText: string | undefined;
    /**
     * One preview renderer per question: an option index only identifies an option inside its
     * own question, so a renderer must not be shared across tabs.
     */
    private readonly previewRenderers = new Map<number, QuestionPreviewRenderer>();

    constructor(options: QuestionPanelOptions) {
        this.request = options.request;
        this.theme = options.theme;
        this.keybindings = options.keybindings;
        this.close = options.close;
        this.onDeferred = options.onDeferred;

        this.requestRender = () => options.tui.requestRender();
        this.terminalRows = () => options.tui.terminal.rows;

        const editorTheme: EditorTheme = {
            borderColor: (text) => this.theme.fg("accent", text),
            selectList: {
                selectedPrefix: (text) => this.theme.fg("accent", text),
                selectedText: (text) => this.theme.fg("accent", text),
                description: (text) => this.theme.fg("muted", text),
                scrollInfo: (text) => this.theme.fg("dim", text),
                noMatch: (text) => this.theme.fg("warning", text),
            },
        };

        this.editor = new Editor(options.tui, editorTheme, { paddingX: 1 });
        this.editor.onSubmit = (text) => this.commitCustomAnswer(text);
        // The draft is kept in sync while typing, so a persistence pass from any direction
        // (Esc, shutdown, restart) sees the text even if the editor never lost focus.
        this.editor.onChange = () => this.captureEditorDraft();

        this.syncAutoInputMode();
    }

    handleInput(data: string): void {
        if (this.inputMode) {
            // Esc belongs to the editor first: it drops back to the options while keeping
            // what was written, and only a second Esc defers the whole panel.
            if (this.isCancelKey(data)) {
                this.exitInputMode();
                return;
            }

            this.editor.handleInput(data);
            this.requestRender();
            return;
        }

        if (this.isCancelKey(data)) {
            this.defer();
            return;
        }

        // Skip is Shift+S, and it is checked before the custom-row shortcut: a free-form
        // question opens its editor by itself, so Esc has to leave a key that still skips,
        // while a plain `s` stays the letter it is everywhere else - the start of an answer.
        // A Kitty-protocol terminal reports a modified key as a CSI sequence instead of the
        // uppercase byte, so matching `"S"` alone would leave skip unreachable there.
        if (data === "S" || matchesKey(data, Key.shift("s"))) {
            this.skipRequest();
            return;
        }

        // The custom row is where answers are written, so printable keys start the editor
        // there instead of being eaten by the single-key shortcuts below (digits, space,
        // j/k), which keep working on the option rows and on the submit tab.
        if (isTypedCharacter(data) && this.isCustomRowFocused()) {
            this.enterInputMode(data);
            return;
        }

        if (this.isMultiQuestion) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                this.moveTab(1);
                return;
            }

            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                this.moveTab(-1);
                return;
            }
        }

        if (this.isSubmitTab) {
            if (this.isConfirmKey(data)) {
                this.submit();
            }
            return;
        }

        if (this.isUpKey(data) || data === "k") {
            this.moveRow(-1);
            return;
        }

        if (this.isDownKey(data) || data === "j") {
            this.moveRow(1);
            return;
        }

        if (this.isConfirmKey(data)) {
            this.confirmRow();
            return;
        }

        if (matchesKey(data, Key.space)) {
            this.toggleFocusedRow();
            return;
        }

        const digit = /^[1-9]$/.exec(data);

        if (digit) {
            this.pickOption(Number(digit[0]) - 1);
        }
    }

    render(width: number): string[] {
        // The hardware cursor belongs to the editor only while it owns the keys.
        this.editor.focused = this.focused && this.inputMode;

        const innerWidth = Math.max(PANEL_MIN_INNER_WIDTH, width - 2);
        const contentWidth = innerWidth - 2;
        const maxBodyHeight = this.maxBodyHeight();
        // The tab strip stays put while the body scrolls. It is the only way to see which
        // questions exist and to reach the others, so it must not scroll out of view.
        const tabs = this.isMultiQuestion ? this.renderTabsBlock(contentWidth) : [];
        const bodyRoom = Math.max(1, maxBodyHeight - tabs.length);
        const { lines: body, focusLine } = this.renderBody(contentWidth, bodyRoom);
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
            this.frame("│") + this.renderFooter(innerWidth) + this.frame("│"),
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

    private get draft(): AskQuestionDraft {
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

    private rowsFor(question: AskQuestion): QuestionRow[] {
        const rows: QuestionRow[] = (question.options ?? []).map((_, index) => ({
            kind: "option" as const,
            index,
        }));

        rows.push({ kind: "custom" });

        // `Enter` toggles checkboxes in a multi-select question, so confirming the
        // selection needs a row of its own.
        if (question.multiSelect === true && (question.options?.length ?? 0) > 0) {
            rows.push({ kind: "next" });
        }

        return rows;
    }

    private focusedRow(rows: readonly QuestionRow[]): QuestionRow | undefined {
        const index = Math.min(rows.length - 1, Math.max(0, this.draft.optionIndex));

        return rows[index];
    }

    /** True while the cursor sits on the "type something" row of the current question. */
    private isCustomRowFocused(): boolean {
        const question = this.currentQuestion();

        return question !== undefined && this.focusedRow(this.rowsFor(question))?.kind === "custom";
    }

    private moveRow(step: number): void {
        const question = this.currentQuestion();

        if (!question) {
            return;
        }

        const rows = this.rowsFor(question);
        const current = Math.min(rows.length - 1, Math.max(0, this.draft.optionIndex));

        this.draft.optionIndex = (current + step + rows.length) % rows.length;
        this.requestRender();
    }

    private confirmRow(): void {
        const question = this.currentQuestion();

        if (!question) {
            return;
        }

        const row = this.focusedRow(this.rowsFor(question));

        if (!row) {
            return;
        }

        if (row.kind === "custom") {
            this.enterInputMode();
            return;
        }

        if (row.kind === "next") {
            this.advanceAfterAnswer();
            return;
        }

        if (question.multiSelect === true) {
            this.toggleOption(row.index);
            return;
        }

        this.answerWithOption(row.index);
    }

    private toggleFocusedRow(): void {
        const question = this.currentQuestion();

        if (!question || question.multiSelect !== true) {
            return;
        }

        const row = this.focusedRow(this.rowsFor(question));

        if (row?.kind === "option") {
            this.toggleOption(row.index);
        }
    }

    private pickOption(index: number): void {
        const question = this.currentQuestion();

        if (!question?.options?.[index]) {
            return;
        }

        this.draft.optionIndex = index;

        if (question.multiSelect === true) {
            this.toggleOption(index);
            return;
        }

        this.answerWithOption(index);
    }

    private toggleOption(index: number): void {
        const question = this.currentQuestion();

        if (!question?.options?.[index]) {
            return;
        }

        const questionIndex = this.draft.currentIndex;
        const answer = this.draft.answers[questionIndex];
        const selected = new Set(answer?.selectedIndexes ?? []);

        if (selected.has(index)) {
            selected.delete(index);
        } else {
            selected.add(index);
        }

        const indexes = Array.from(selected).sort((left, right) => left - right);

        // A written answer and selected options are mutually exclusive; the written
        // draft itself stays in `customDrafts` so the editor can restore it.
        this.draft.answers[questionIndex] = indexes.length > 0
            ? { selectedIndexes: indexes }
            : undefined;
        this.requestRender();
    }

    private answerWithOption(index: number): void {
        this.draft.answers[this.draft.currentIndex] = { selectedIndexes: [index] };
        this.advanceAfterAnswer();
    }

    private advanceAfterAnswer(): void {
        const questionIndex = this.draft.currentIndex;

        if (this.questions.length === 1) {
            this.submit();
            return;
        }

        this.draft.currentIndex = questionIndex < this.questions.length - 1
            ? questionIndex + 1
            : this.questions.length;
        this.draft.optionIndex = 0;
        this.inputMode = false;
        this.syncAutoInputMode();
        this.requestRender();
    }

    private moveTab(step: number): void {
        const total = this.questions.length + 1;
        const current = Math.min(total - 1, Math.max(0, this.draft.currentIndex));

        this.draft.currentIndex = (current + step + total) % total;
        this.draft.optionIndex = 0;
        this.inputMode = false;
        this.syncAutoInputMode();
        this.requestRender();
    }

    private enterInputMode(seed?: string): void {
        const questionIndex = this.draft.currentIndex;
        const draftText = this.draft.customDrafts[questionIndex]
            ?? this.draft.answers[questionIndex]?.customText
            ?? "";

        this.inputMode = true;
        this.editor.setText(draftText);
        this.editor.focused = this.focused;

        if (seed !== undefined) {
            // Let the editor place the key that opened it, so cursor and wrapping stay its job.
            this.editor.handleInput(seed);
        }

        this.requestRender();
    }

    private exitInputMode(): void {
        this.captureEditorDraft();
        this.inputMode = false;
        this.requestRender();
    }

    private captureEditorDraft(): void {
        // A large paste lives behind a `[paste #1 +12 lines]` marker in the editor; only
        // getExpandedText() returns the content that has to survive Esc and a restart.
        const text = this.editor.getExpandedText();

        this.draft.customDrafts[this.draft.currentIndex] = text.length > 0 ? text : undefined;
    }

    private commitCustomAnswer(text: string): void {
        const trimmed = text.trim();

        // An empty answer would be indistinguishable from unanswered; keep the editor
        // open so the user can type something or leave with Esc.
        if (trimmed.length === 0) {
            return;
        }

        const questionIndex = this.draft.currentIndex;

        this.draft.customDrafts[questionIndex] = trimmed;
        this.draft.answers[questionIndex] = { selectedIndexes: [], customText: trimmed };
        this.inputMode = false;
        this.advanceAfterAnswer();
    }

    /** Free-form questions have nothing to pick, so their editor opens immediately. */
    private syncAutoInputMode(): void {
        const question = this.currentQuestion();
        const unanswered = this.draft.answers[this.draft.currentIndex] === undefined;

        this.inputMode = question !== undefined
            && (question.options?.length ?? 0) === 0
            && unanswered;

        if (this.inputMode) {
            this.editor.setText(this.draft.customDrafts[this.draft.currentIndex] ?? "");
        }
    }

    private allAnswered(): boolean {
        return this.questions.every((_, index) => this.draft.answers[index] !== undefined);
    }

    private submit(): void {
        if (!this.allAnswered()) {
            // Landing on the first gap is more useful than a dead Enter press.
            const missing = this.draft.answers.findIndex((answer) => answer === undefined);

            if (missing >= 0) {
                this.draft.currentIndex = missing;
                this.draft.optionIndex = 0;
                this.inputMode = false;
                this.syncAutoInputMode();
                this.requestRender();
            }

            return;
        }

        const answers = this.draft.answers.filter(
            (answer): answer is AskQuestionAnswer => answer !== undefined,
        );

        if (questionManager.submit(this.request.id, answers)) {
            this.close("settled");
        }
    }

    private skipRequest(): void {
        if (questionManager.skip(this.request.id)) {
            this.close("settled");
        }
    }

    private defer(): void {
        if (this.inputMode) {
            this.captureEditorDraft();
        }

        try {
            // The draft is already on the request, so only the snapshot has to be written.
            this.onDeferred?.();
        } catch {
            // A hook failure must not leave the overlay stuck, and it must not reach the
            // terminal input loop either - the hook reports its own errors.
        } finally {
            this.close("deferred");
        }
    }

    private isConfirmKey(data: string): boolean {
        return matchesKey(data, Key.enter)
            || this.keybindings.matches(data, "tui.select.confirm")
            || this.keybindings.matches(data, "tui.input.submit");
    }

    private isCancelKey(data: string): boolean {
        return matchesKey(data, Key.escape)
            || this.keybindings.matches(data, "tui.select.cancel");
    }

    private isUpKey(data: string): boolean {
        return matchesKey(data, Key.up) || this.keybindings.matches(data, "tui.select.up");
    }

    private isDownKey(data: string): boolean {
        return matchesKey(data, Key.down) || this.keybindings.matches(data, "tui.select.down");
    }

    /**
     * Upper bound for the body, not a target: the panel is only as tall as its content, and
     * the bound is whatever room the terminal gives the overlay - a percentage of its height,
     * itself limited by the overlay margins. There is no fixed row cap: a request with several
     * questions is meant to be read in one piece, and clipping it to a constant would hide
     * content the user has to answer. Scrolling only steps in when the content genuinely does
     * not fit the screen.
     */
    private maxBodyHeight(): number {
        const rows = this.terminalRows();
        const usable = Math.min(Math.floor(rows * OVERLAY_HEIGHT_RATIO), rows - OVERLAY_MARGIN * 2);

        return Math.max(1, usable - FRAME_HEIGHT);
    }

    private renderHeader(width: number): string {
        const contentWidth = width - 2;
        const title = this.theme.bold("Questions");
        const answered = this.draft.answers.filter((answer) => answer !== undefined).length;
        const status = `${answered}/${this.questions.length} answered`;
        const gap = Math.max(1, contentWidth - visibleWidth(title) - visibleWidth(status));

        return this.cell(`${title}${" ".repeat(gap)}${this.theme.fg("muted", status)}`, width);
    }

    private renderFooter(width: number): string {
        const question = this.currentQuestion();

        let hints: string;

        if (this.inputMode) {
            // Shift+S belongs to the editor while it owns the keys, so the footer must not
            // advertise skip here; Esc leaves the editor and skips from the options.
            hints = "Enter submit · Esc back to options";
        } else if (this.isSubmitTab) {
            hints = `${this.isMultiQuestion ? "Tab/←→ switch · " : ""}Enter submit · S skip · Esc close`;
        } else if (question?.multiSelect === true) {
            hints = "↑↓ move · Space/Enter toggle · Tab next · S skip · Esc close";
        } else {
            hints = `↑↓ select · Enter confirm${this.isMultiQuestion ? " · Tab/←→ switch" : ""} · S skip · Esc close`;
        }

        return this.cell(this.theme.fg("dim", hints), width);
    }

    private renderBody(contentWidth: number, maxBodyHeight: number): { lines: string[]; focusLine: number } {
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

        const region = this.renderQuestionRegion(question, contentWidth, lines.length, maxBodyHeight);
        const focusLine = lines.length + region.focusLine;
        lines.push(...region.lines);

        if (this.inputMode) {
            lines.push("");
            pushWrapped(lines, contentWidth, " ", this.theme.fg("muted", "Your answer:"));

            // The editor draws its own frame; one column keeps it inside the panel border.
            for (const line of this.editor.render(Math.max(1, contentWidth - 2))) {
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
    ): { lines: string[]; focusLine: number } {
        const renderer = this.previewRendererFor(this.draft.currentIndex, question);

        // While the editor is open the focused row is the custom row, which has no preview of
        // its own, and the editor below needs the full width more than a preview does.
        if (this.inputMode || !renderer.hasAnyPreview()) {
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
        const rows = this.rowsFor(question);
        const focusedIndex = Math.min(rows.length - 1, Math.max(0, this.draft.optionIndex));
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

/** A single printable character, as opposed to an escape sequence or a control key. */
function isTypedCharacter(data: string): boolean {
    return data.length > 0 && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data);
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
