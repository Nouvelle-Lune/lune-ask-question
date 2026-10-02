import type {
    ExtensionContext,
    Theme,
} from "@earendil-works/pi-coding-agent";

import {
    Editor,
    Key,
    matchesKey,
    type Component,
    type EditorTheme,
    type Focusable,
    type KeybindingsManager,
    type TUI,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
    questionManager,
    type AskQuestionDraft,
    type AskQuestionRequest,
} from "../../core/questionManager.ts";
import { QuestionPanelController } from "./question-panel-controller.ts";
import {
    QuestionPanelRenderer,
    type PanelRect,
    type PanelSpan,
    type QuestionPanelLayout,
} from "./question-panel-renderer.ts";

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

/**
 * Overlay adapter of one question request: it routes terminal input to the controller, owns
 * the editor, and turns a controller transition into a render request, an editor mode change
 * or a settle. Drawing is the renderer's job.
 */
export class QuestionPanel implements Component, Focusable {
    /** Set by the TUI when this overlay owns input. */
    focused = false;

    private readonly request: AskQuestionRequest;
    private readonly keybindings: KeybindingsManager;
    private readonly requestRender: () => void;
    private readonly terminalRows: () => number;
    private readonly close: (reason: PanelCloseReason) => void;
    private readonly onDeferred: (() => void) | undefined;

    private readonly controller: QuestionPanelController;
    private readonly renderer: QuestionPanelRenderer;

    private readonly editor: Editor;
    private inputMode = false;

    /** Geometry of the last frame, for mouse hit-testing. */
    private layout: QuestionPanelLayout | undefined;
    /** Wheel position of the body; `undefined` lets the window follow the focused row. */
    private bodyScroll: number | undefined;
    private previewScroll = 0;

    constructor(options: QuestionPanelOptions) {
        this.request = options.request;
        this.keybindings = options.keybindings;
        this.close = options.close;
        this.onDeferred = options.onDeferred;

        this.requestRender = () => options.tui.requestRender();
        this.terminalRows = () => options.tui.terminal.rows;
        this.controller = new QuestionPanelController(options.request);
        this.renderer = new QuestionPanelRenderer({
            request: options.request,
            theme: options.theme,
        });

        const editorTheme: EditorTheme = {
            borderColor: (text) => options.theme.fg("accent", text),
            selectList: {
                selectedPrefix: (text) => options.theme.fg("accent", text),
                selectedText: (text) => options.theme.fg("accent", text),
                description: (text) => options.theme.fg("muted", text),
                scrollInfo: (text) => options.theme.fg("dim", text),
                noMatch: (text) => options.theme.fg("warning", text),
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
        // A key moves the focus, so the window goes back to following it.
        this.bodyScroll = undefined;
        this.withPreviewReset(() => this.handleKey(data));
    }

    private handleKey(data: string): void {
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
        if (isTypedCharacter(data) && this.controller.isCustomRowFocused()) {
            this.enterInputMode(data);
            return;
        }

        if (this.controller.isMultiQuestion) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                this.moveTab(1);
                return;
            }

            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                this.moveTab(-1);
                return;
            }
        }

        if (this.controller.isSubmitTab) {
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

    /**
     * Fullscreen mode routes the mouse here; regular mode leaves it to the terminal, so every
     * action below also has a key. Only the tab strip and the open editor are targets: a press
     * on an option row stays unhandled, so the panel's text can still be selected and copied.
     */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const layout = this.layout;

        if (!layout) {
            return undefined;
        }

        if (event.type === "wheel") {
            // Claimed even when nothing moves: an unhandled wheel scrolls the transcript behind.
            return { handled: true, render: this.scrollBy(layout, event) };
        }

        if (event.button !== "left") {
            return undefined;
        }

        if (this.inputMode && layout.editor && insideRect(layout.editor, event) && insideRect(layout.body, event)) {
            return this.editor.handleMouse({
                ...event,
                x: event.x - layout.editor.x,
                y: event.y - layout.editor.y,
                width: layout.editor.width,
                height: layout.editor.height,
            });
        }

        if (event.type === "press") {
            return this.withPreviewReset(() => this.pressTabAt(layout, event));
        }

        return undefined;
    }

    /**
     * A preview belongs to one option, so moving the focus away and back starts it at its top;
     * another question starts with the window on its focused row.
     */
    private withPreviewReset<T>(action: () => T): T {
        const question = this.draft.currentIndex;
        const option = this.draft.optionIndex;
        const result = action();

        if (this.draft.currentIndex !== question) {
            this.bodyScroll = undefined;
        }

        if (this.draft.currentIndex !== question || this.draft.optionIndex !== option) {
            this.previewScroll = 0;
        }

        return result;
    }

    render(width: number): string[] {
        // The hardware cursor belongs to the editor only while it owns the keys.
        this.editor.focused = this.focused && this.inputMode;

        const frame = this.renderer.render(width, {
            inputMode: this.inputMode,
            maxBodyHeight: this.maxBodyHeight(),
            editor: this.inputMode ? this.editor : undefined,
            bodyScroll: this.bodyScroll,
            previewScroll: this.previewScroll,
        });

        this.layout = frame.layout;

        return frame.lines;
    }

    invalidate(): void {
        this.renderer.invalidate();
    }

    private get draft(): AskQuestionDraft {
        return this.request.draft;
    }

    /**
     * The preview under the pointer scrolls first; at its limits the wheel stays with it.
     *
     * Renders are batched, so several wheel events can arrive against one frame: each step
     * builds on the scroll already requested, not on the offset that frame drew.
     */
    private scrollBy(layout: QuestionPanelLayout, event: TuiMouseEvent): boolean {
        const delta = event.wheelDelta ?? 0;
        const preview = layout.preview;

        if (preview && preview.maxOffset > 0 && insideRect(preview, event)) {
            const current = clamp(this.previewScroll, 0, preview.maxOffset);
            const next = clamp(current + delta, 0, preview.maxOffset);

            this.previewScroll = next;
            return next !== current;
        }

        const body = layout.body;
        const current = clamp(this.bodyScroll ?? body.offset, 0, body.maxOffset);
        const next = clamp(current + delta, 0, body.maxOffset);

        this.bodyScroll = next;
        return next !== current;
    }

    /** The tab strip is the only row the mouse can act on; option rows stay keyboard-only. */
    private pressTabAt(layout: QuestionPanelLayout, event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const tab = layout.tabs.find((span) => insideSpan(span, event));

        if (!tab) {
            return undefined;
        }

        const target = tab.target;

        if (target.kind === "step" || target.index !== this.draft.currentIndex) {
            // Before the switch: the draft is stored under the question being left.
            this.leaveEditorForTab();

            if (target.kind === "step") {
                this.moveTab(target.step);
            } else {
                this.controller.selectTab(target.index);
                this.inputMode = false;
                this.syncAutoInputMode();
            }
        }

        this.requestRender();
        return { handled: true, focus: true };
    }

    /** Moving away by mouse must keep what was typed, as `Esc` does. */
    private leaveEditorForTab(): void {
        if (this.inputMode) {
            this.captureEditorDraft();
        }
    }

    private moveRow(step: number): void {
        this.controller.moveRow(step);
        this.requestRender();
    }

    private moveTab(step: number): void {
        this.controller.moveTab(step);
        this.inputMode = false;
        this.syncAutoInputMode();
        this.requestRender();
    }

    private confirmRow(): void {
        const question = this.controller.currentQuestion();
        const row = this.controller.focusedRow();

        if (!question || !row) {
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
        this.controller.toggleFocusedRow();
        this.requestRender();
    }

    private toggleOption(index: number): void {
        this.controller.toggleOption(index);
        this.requestRender();
    }

    private pickOption(index: number): void {
        const action = this.controller.pickOption(index);

        if (action === "answer") {
            this.advanceAfterAnswer();
            return;
        }

        if (action === "toggle") {
            this.requestRender();
        }
    }

    private answerWithOption(index: number): void {
        this.controller.answerWithOption(index);
        this.advanceAfterAnswer();
    }

    private advanceAfterAnswer(): void {
        if (this.controller.advanceAfterAnswer() === "submit") {
            this.submit();
            return;
        }

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

        this.controller.setCustomAnswer(trimmed);
        this.inputMode = false;
        this.advanceAfterAnswer();
    }

    /** Free-form questions have nothing to pick, so their editor opens immediately. */
    private syncAutoInputMode(): void {
        const question = this.controller.currentQuestion();
        const unanswered = this.draft.answers[this.draft.currentIndex] === undefined;

        this.inputMode = question !== undefined
            && (question.options?.length ?? 0) === 0
            && unanswered;

        if (this.inputMode) {
            this.editor.setText(this.draft.customDrafts[this.draft.currentIndex] ?? "");
        }
    }

    private submit(): void {
        if (!this.controller.prepareSubmit()) {
            this.inputMode = false;
            this.syncAutoInputMode();
            this.requestRender();
            return;
        }

        if (questionManager.submit(this.request.id, this.controller.collectAnswers())) {
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
}

function insideRect(rect: PanelRect, event: TuiMouseEvent): boolean {
    return event.x >= rect.x && event.x < rect.x + rect.width
        && event.y >= rect.y && event.y < rect.y + rect.height;
}

function insideSpan(span: PanelSpan, event: TuiMouseEvent): boolean {
    return event.y === span.y && event.x >= span.start && event.x < span.end;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** A single printable character, as opposed to an escape sequence or a control key. */
function isTypedCharacter(data: string): boolean {
    return data.length > 0 && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data);
}
