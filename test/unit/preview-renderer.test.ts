/**
 * The preview renderer turns one option's markdown into a bordered block for the panel.
 *
 * One renderer per question: `optionIndex` is only unique inside a question, so a renderer
 * shared across questions would hand out another question's preview. Rendering itself stays
 * free of request state — no selection, no manager.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { AskQuestion } from "../../src/core/questionManager.ts";
import { QuestionPreviewRenderer } from "../../src/tui/preview-renderer.ts";
import { createFakeTheme } from "../harness.ts";

// Markdown highlights code blocks through pi's module-level theme; the real TUI
// initializes it before any extension renders.
initTheme();

const WIDE_QUESTION: AskQuestion = {
    question: "Which database?",
    options: [
        { label: "Postgres", preview: "# Postgres\n\n- JSONB\n- `pg_stat`\n\n```sql\nSELECT 1;\n```" },
        { label: "SQLite", preview: "**file only**" },
    ],
};

function createRenderer(question: AskQuestion = WIDE_QUESTION): QuestionPreviewRenderer {
    return new QuestionPreviewRenderer({ question, theme: createFakeTheme() });
}

function text(lines: readonly string[]): string {
    return stripTerminalSequences(lines.join("\n"));
}

describe("preview renderer", () => {
    it("uses the renderer's own question to answer availability", () => {
        assert.equal(createRenderer().hasAnyPreview(), true);
        assert.equal(
            createRenderer({ question: "Q?", options: [{ label: "a" }, { label: "b" }] }).hasAnyPreview(),
            false,
        );
    });

    it("wraps the preview in a bordered box and renders it as markdown", () => {
        const { lines } = createRenderer().render(0, 60, 14);

        const rendered = text(lines);
        assert.ok(stripTerminalSequences(lines[0]!).startsWith("┌"));
        assert.ok(stripTerminalSequences(lines.at(-1)!).endsWith("┘"));
        // Markdown: headings and list bullets survive, the fence markers do not.
        assert.match(rendered, /Postgres/);
        assert.match(rendered, /JSONB/);
        assert.match(rendered, /pg_stat/);
        assert.match(rendered, /SELECT 1;/);
        assert.equal(rendered.includes("```"), false);
        assert.equal(rendered.includes("#"), false, "the heading marker is consumed by markdown");
    });

    it("keeps the box inside the column it was given", () => {
        for (const width of [20, 45, 60]) {
            const { lines } = createRenderer().render(0, width, 14);

            for (const line of lines) {
                assert.ok(
                    visibleWidth(line) <= width,
                    `line exceeds ${width} columns: ${JSON.stringify(stripTerminalSequences(line))}`,
                );
            }

            const widths = new Set(lines.map((line) => visibleWidth(line)));
            assert.equal(widths.size, 1, "the box must be rectangular");
        }
    });

    it("swaps the content when another option is rendered", () => {
        const renderer = createRenderer();

        assert.match(text(renderer.render(0, 60, 14).lines), /JSONB/);
        assert.match(text(renderer.render(1, 60, 14).lines), /file only/);
        assert.equal(text(renderer.render(1, 60, 14).lines).includes("JSONB"), false);
    });

    it("explains an option without a preview instead of dropping the box", () => {
        const renderer = createRenderer({
            question: "Q?",
            options: [{ label: "a", preview: "preview a" }, { label: "b" }],
        });

        const { lines } = renderer.render(1, 60, 14);

        assert.match(text(lines), /No preview available/);
        assert.ok(stripTerminalSequences(lines[0]!).startsWith("┌"), "the box stays for layout stability");
    });

    it("caps the block height and reports the hidden remainder", () => {
        const renderer = createRenderer({
            question: "Q?",
            options: [{ label: "a", preview: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") }],
        });

        const { lines, hidden } = renderer.render(0, 60, 8);

        assert.equal(lines.length, 8);
        assert.ok(hidden > 0);
        assert.match(text(lines), new RegExp(`${hidden} lines hidden`));
    });

    it("titles the box with the option label", () => {
        const { lines } = createRenderer().render(0, 60, 14);

        assert.match(stripTerminalSequences(lines[0]!), /^┌─ Postgres /);
    });

    it("drops the blank lines a preview carries around its content", () => {
        const renderer = createRenderer({
            question: "Q?",
            options: [{ label: "a", preview: "\n\n- one\n- two\n\n\n" }, { label: "b" }],
        });

        const inner = renderer.render(0, 60, 14).lines
            .slice(1, -1)
            .map((line) => stripTerminalSequences(line).slice(2, -2).replace(/\s+$/, ""));

        assert.deepEqual(inner, ["- one", "- two"]);
    });

    it("does not report hidden lines when everything fits", () => {
        const { lines, hidden } = createRenderer().render(0, 60, 14);

        assert.equal(hidden, 0);
        assert.equal(text(lines).includes("hidden"), false);
    });

    it("is a pure render: the same inputs repeat and a narrower width re-wraps", () => {
        const renderer = createRenderer();
        const wide = text(renderer.render(0, 70, 14).lines);
        const narrow = text(renderer.render(0, 30, 14).lines);

        assert.equal(text(renderer.render(0, 70, 14).lines), wide, "repeating a render is stable");
        assert.notEqual(narrow, wide, "the markdown has to re-wrap for a new width");
        assert.match(narrow, /JSONB/);
    });

    it("renders a very long preview without a stall", () => {
        const preview = Array.from({ length: 400 }, (_, index) => `- line ${index} ${"x".repeat(40)}`).join("\n");
        const renderer = createRenderer({
            question: "Q?",
            options: [{ label: "a", preview }, { label: "b" }],
        });

        const started = performance.now();
        const { lines, hidden } = renderer.render(0, 80, 14);
        const elapsed = performance.now() - started;

        assert.equal(lines.length, 14, "the block still respects its row budget");
        assert.ok(hidden > 0);
        assert.ok(elapsed < 1000, `a ${preview.length} character preview took ${elapsed.toFixed(0)}ms`);
    });

    it("keeps two questions apart even when they share option indexes", () => {
        const first = createRenderer({
            question: "Q1?",
            options: [{ label: "a", preview: "first preview" }, { label: "b" }],
        });
        const second = createRenderer({
            question: "Q2?",
            options: [{ label: "a", preview: "second preview" }, { label: "b" }],
        });

        assert.match(text(first.render(0, 60, 14).lines), /first preview/);
        assert.match(text(second.render(0, 60, 14).lines), /second preview/);
        assert.equal(text(second.render(0, 60, 14).lines).includes("first preview"), false);
    });
});
