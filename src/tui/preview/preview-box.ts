/**
 * Pure box helpers for the option preview pane.
 *
 * Every width here is terminal columns (`visibleWidth`), never code units: CJK content is
 * twice as wide as its `length`, and ANSI sequences are zero columns with non-zero length.
 * Measuring the wrong one misaligns the box and, in a side-by-side layout, the whole panel.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FENCE_MARKER_RE = /^`{3}/;

/** Top and bottom border rows of a rendered box. */
export const BORDER_VERTICAL_OVERHEAD = 2;
/** Left and right border columns of a rendered box. */
export const BORDER_HORIZONTAL_OVERHEAD = 2;
/** Inner horizontal padding between a border column and the content. */
export const BORDER_INNER_PADDING_HORIZONTAL = 1;
/** Floor for the content width, so a one-word preview still reads as a panel. */
export const MIN_BOX_INNER_WIDTH = 40;

/**
 * Drop the fence lines pi-tui renders around a code block, leaving the highlighted body.
 * Inline code is unaffected: markdown renders it without backticks in the first place.
 */
export function stripFenceMarkers(lines: readonly string[]): string[] {
    return lines.filter((line) => {
        const withoutAnsi = line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "");

        return !FENCE_MARKER_RE.test(withoutAnsi);
    });
}

export interface BorderedBoxOptions {
    /** Styles the border characters. */
    colorFn: (text: string) => string;
    /** Content rows below the box; replaces the bottom border with a notice. */
    hidden?: number;
    /** Content rows scrolled out above the box; reported in the same notice. */
    hiddenAbove?: number;
    /** Drawn into the top border, so the pane names the option it belongs to. */
    title?: string;
}

/**
 * Drop blank lines at the start and end of a rendered block.
 *
 * Markdown keeps the blank lines its source carries, so a preview ending with one would push
 * the bottom border down and leave a gap inside the box. Blank lines in the middle are content
 * (paragraph spacing) and stay.
 */
export function trimBlankEdges(lines: readonly string[]): string[] {
    let start = 0;
    let end = lines.length;

    while (start < end && isBlank(lines[start]!)) {
        start++;
    }

    while (end > start && isBlank(lines[end - 1]!)) {
        end--;
    }

    return lines.slice(start, end);
}

function isBlank(line: string): boolean {
    return line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "").trim().length === 0;
}

/**
 * Outer width of a box for `lines`, never wider than `maxInnerWidth` (+ border and padding).
 *
 * Trailing whitespace is ignored because pi-tui renders every markdown line padded to the
 * render width; measuring that padding would stretch the box to its whole column. A title
 * needs its own room inside the top border: one dash, the title, a space and one more dash.
 */
export function computeBoxWidth(lines: readonly string[], maxInnerWidth: number, title?: string): number {
    const available = Math.max(1, maxInnerWidth);
    let widest = Math.min(MIN_BOX_INNER_WIDTH, available);

    for (const line of lines) {
        const width = visibleWidth(line.replace(/\s+$/, ""));

        if (width > widest) {
            widest = width;
        }
    }

    if (title !== undefined && title.length > 0) {
        widest = Math.max(widest, visibleWidth(title) + 4);
    }

    return Math.min(widest, available) + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL;
}

/**
 * Draw `lines` inside a bordered box exactly `width` columns wide.
 *
 * `hidden` replaces the bottom border with a notice instead of adding a row, so the block
 * height stays predictable for the panel's window.
 */
export function renderBorderedBox(
    lines: readonly string[],
    width: number,
    options: BorderedBoxOptions,
): string[] {
    const dashSpan = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD);
    const contentInner = Math.max(1, dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL);
    const padding = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
    const boxed: string[] = [options.colorFn(topBorder(dashSpan, options.title))];

    for (const line of lines) {
        // Markdown pads its lines to the render width; that padding is not content, and
        // keeping it would mark every line as truncated.
        const content = truncateToWidth(line.replace(/\s+$/, ""), contentInner, "…", true);

        boxed.push(`${options.colorFn("│")}${padding}${content}${padding}${options.colorFn("│")}`);
    }

    const hidden = options.hidden ?? 0;
    const hiddenAbove = options.hiddenAbove ?? 0;

    boxed.push(options.colorFn(
        hidden > 0 || hiddenAbove > 0
            ? hiddenNotice(hiddenAbove, hidden, dashSpan)
            : `└${"─".repeat(dashSpan)}┘`,
    ));

    return boxed;
}

/** Top border, with the title worked into the dashes when there is room for it. */
function topBorder(dashSpan: number, title: string | undefined): string {
    const plain = `┌${"─".repeat(dashSpan)}┐`;

    if (title === undefined || title.length === 0) {
        return plain;
    }

    // "─ ", the title, a trailing space and at least one dash have to fit the border.
    const budget = dashSpan - 4;

    if (budget < 1) {
        return plain;
    }

    const head = `─ ${truncateToWidth(title, budget, "…")} `;

    return `┌${head}${"─".repeat(Math.max(1, dashSpan - visibleWidth(head)))}┐`;
}

/** Bottom border with the hidden-line notice, kept exactly `dashSpan` columns wide. */
function hiddenNotice(above: number, below: number, dashSpan: number): string {
    const text = above > 0
        ? `${[`↑ ${above}`, below > 0 ? `↓ ${below}` : undefined].filter(Boolean).join(" · ")} hidden`
        : `${below} line${below === 1 ? "" : "s"} hidden`;
    const notice = truncateToWidth(
        ` ✂ ── ${text} ── `,
        dashSpan,
        "…",
    );
    const fill = Math.max(0, dashSpan - visibleWidth(notice));
    const left = Math.floor(fill / 2);

    return `└${"─".repeat(left)}${notice}${"─".repeat(fill - left)}┘`;
}
