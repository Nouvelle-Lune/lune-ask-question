/**
 * Renders one question's option preview as a bordered markdown block.
 *
 * One instance per question. `optionIndex` only identifies an option inside its own
 * question, so a renderer reused across questions would hand out the wrong preview; keeping
 * it per question is what makes the index key safe.
 *
 * Width handling is left to pi-tui's `Markdown`, which caches its rendered lines per width
 * (and its parsed tokens per text), so there is no width-keyed cache to maintain here.
 *
 * The renderer holds no interaction state: focus, selection and answers belong to the panel
 * and the question manager, and it never reads the manager itself. Its only state is the
 * per-option `Markdown` cache, which is a render concern; the caller decides which option is
 * focused and how much room the block gets.
 */
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

import type { AskQuestion } from "../../core/question-types.ts";
import {
    BORDER_HORIZONTAL_OVERHEAD,
    BORDER_INNER_PADDING_HORIZONTAL,
    BORDER_VERTICAL_OVERHEAD,
    computeBoxWidth,
    renderBorderedBox,
    stripFenceMarkers,
    trimBlankEdges,
} from "./preview-box.ts";
import { optionHasPreview, questionHasPreview } from "./preview-layout.ts";

/** Shown for a focused option without a preview, keeping the box in place. */
export const NO_PREVIEW_TEXT = "No preview available";

export interface QuestionPreviewRendererOptions {
    question: AskQuestion;
    theme: Theme;
    /** Defaults to the shared markdown theme the rest of the TUI uses. */
    markdownTheme?: MarkdownTheme;
}

export interface PreviewBlock {
    /** Box lines, borders included; the caller pads them into its preview column. */
    lines: string[];
    /** Content rows the block could not show; reported in its bottom border. */
    hidden: number;
}

export class QuestionPreviewRenderer {
    private readonly question: AskQuestion;
    private readonly theme: Theme;
    private readonly markdownTheme: MarkdownTheme;
    private readonly markdownByOption = new Map<number, Markdown>();
    private readonly hasPreview: boolean;

    constructor(options: QuestionPreviewRendererOptions) {
        this.question = options.question;
        this.theme = options.theme;
        this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
        this.hasPreview = questionHasPreview(options.question);
    }

    /** False when no option of this question carries a preview: the panel then skips the column. */
    hasAnyPreview(): boolean {
        return this.hasPreview;
    }

    render(optionIndex: number, width: number, maxBlockRows: number): PreviewBlock {
        const maxInnerWidth = Math.max(
            1,
            width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL,
        );
        const contentBudget = Math.max(1, maxBlockRows - BORDER_VERTICAL_OVERHEAD);
        const title = this.question.options?.[optionIndex]?.label;
        const raw = this.contentLines(optionIndex, maxInnerWidth);
        const hidden = Math.max(0, raw.length - contentBudget);
        const visible = hidden > 0 ? raw.slice(0, contentBudget) : raw;
        const boxWidth = computeBoxWidth(visible, maxInnerWidth, title);

        return {
            lines: renderBorderedBox(visible, boxWidth, {
                colorFn: (text) => this.theme.fg("border", text),
                hidden,
                title,
            }),
            hidden,
        };
    }

    private contentLines(optionIndex: number, innerWidth: number): string[] {
        const option = this.question.options?.[optionIndex];

        if (option && optionHasPreview(option) && option.preview !== undefined) {
            const rendered = trimBlankEdges(
                stripFenceMarkers(this.markdownFor(optionIndex, option.preview).render(innerWidth)),
            );

            // A preview of nothing but fence markers or blank lines renders to nothing; fall
            // back to the placeholder so the box never collapses into an empty frame.
            if (rendered.length > 0) {
                return rendered;
            }
        }

        return [this.theme.fg("dim", NO_PREVIEW_TEXT)];
    }

    private markdownFor(optionIndex: number, text: string): Markdown {
        const cached = this.markdownByOption.get(optionIndex);

        if (cached) {
            return cached;
        }

        const markdown = new Markdown(text, 0, 0, this.markdownTheme);
        this.markdownByOption.set(optionIndex, markdown);

        return markdown;
    }
}
