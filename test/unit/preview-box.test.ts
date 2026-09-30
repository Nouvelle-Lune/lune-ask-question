/**
 * Pure box helpers for the option preview: fence stripping, width measurement and the
 * bordered box. Width is always measured in terminal columns (`visibleWidth`), never code
 * units: CJK content is twice as wide as its `length`, ANSI sequences are zero columns but
 * non-zero length.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import {
    MIN_BOX_INNER_WIDTH,
    computeBoxWidth,
    renderBorderedBox,
    stripFenceMarkers,
} from "../../src/tui/preview/preview-box.ts";

const identity = (text: string) => text;

/** Every line of a rendered block occupies the same number of columns. */
function assertUniformWidth(lines: readonly string[], width: number): void {
    for (const line of lines) {
        assert.equal(
            visibleWidth(line),
            width,
            `line is not ${width} columns wide: ${JSON.stringify(stripTerminalSequences(line))}`,
        );
    }
}

describe("preview box", () => {
    describe("stripFenceMarkers", () => {
        it("drops the fence lines pi-tui renders around code blocks", () => {
            const lines = ["before", "```ts", "const x = 1;", "```", "after"];

            assert.deepEqual(stripFenceMarkers(lines), ["before", "const x = 1;", "after"]);
        });

        it("keeps every other line, including inline code", () => {
            const lines = ["use `code` here", "- item", "  indented"];

            assert.deepEqual(stripFenceMarkers(lines), lines);
        });

        it("recognizes a fence that carries styling", () => {
            assert.deepEqual(stripFenceMarkers(["\x1b[2m```\x1b[0m", "body"]), ["body"]);
        });
    });

    describe("computeBoxWidth", () => {
        it("keeps a minimum width for content narrower than the floor", () => {
            assert.equal(computeBoxWidth(["ok"], 200), MIN_BOX_INNER_WIDTH + 4);
            assert.equal(computeBoxWidth([], 200), MIN_BOX_INNER_WIDTH + 4);
        });

        it("grows with the widest content line", () => {
            assert.equal(computeBoxWidth(["x".repeat(50)], 200), 54);
        });

        it("measures columns, not code units", () => {
            // 25 CJK characters: 25 code units, 50 terminal columns.
            const cjk = "测".repeat(25);

            assert.equal(cjk.length, 25);
            assert.equal(visibleWidth(cjk), 50);
            assert.equal(computeBoxWidth([cjk], 200), 54);
        });

        it("ignores ANSI styling and trailing padding", () => {
            // pi-tui renders every markdown line padded to the render width.
            assert.equal(computeBoxWidth(["\x1b[31m" + "y".repeat(50) + "\x1b[39m"], 200), 54);
            assert.equal(computeBoxWidth(["short" + " ".repeat(90)], 200), MIN_BOX_INNER_WIDTH + 4);
        });

        it("never exceeds the width it is given", () => {
            assert.equal(computeBoxWidth(["z".repeat(200)], 60), 64);
            assert.equal(computeBoxWidth(["z".repeat(200)], 61), 65);
        });

        it("keeps one content column when there is no room at all", () => {
            assert.equal(computeBoxWidth(["content"], 0), 5);
        });

        it("makes room for a border title", () => {
            const title = "x".repeat(50);

            assert.equal(computeBoxWidth(["ok"], 200, title), 58);
            assert.equal(computeBoxWidth([], 200, title), 58);
        });
    });

    describe("renderBorderedBox", () => {
        it("wraps content in a border with one column of inner padding", () => {
            const lines = renderBorderedBox(["hi"], 10, { colorFn: identity }).map((line) => stripTerminalSequences(line));

            assert.deepEqual(lines, ["┌────────┐", "│ hi     │", "└────────┘"]);
        });

        it("draws the title into the top border", () => {
            const lines = renderBorderedBox(["hi"], 20, { colorFn: identity, title: "Postgres" })
                .map((line) => stripTerminalSequences(line));

            assert.deepEqual(lines, ["┌─ Postgres ───────┐", "│ hi               │", "└──────────────────┘"]);
            assertUniformWidth(lines, 20);
        });

        it("truncates a title that does not fit", () => {
            const lines = renderBorderedBox(["hi"], 12, { colorFn: identity, title: "a very long option name" });

            assertUniformWidth(lines, 12);
            assert.match(stripTerminalSequences(lines[0]!), /^┌─ a ver… /);
        });

        it("keeps a plain border when there is no room for a title", () => {
            const lines = renderBorderedBox(["hi"], 5, { colorFn: identity, title: "Postgres" });

            assertUniformWidth(lines, 5);
            assert.equal(stripTerminalSequences(lines[0]!), "┌───┐");
        });

        it("pads blank content lines to the box width", () => {
            const lines = renderBorderedBox(["", "x"], 8, { colorFn: identity });

            assertUniformWidth(lines, 8);
        });

        it("truncates content wider than the box", () => {
            const lines = renderBorderedBox(["w".repeat(200)], 20, { colorFn: identity });

            assertUniformWidth(lines, 20);
            assert.ok(lines[1]!.includes("…"), "an over-long line is truncated with an ellipsis");
        });

        it("reports hidden lines in the bottom border", () => {
            const lines = renderBorderedBox(["x"], 40, { colorFn: identity, hidden: 3 });

            assertUniformWidth(lines, 40);
            assert.match(stripTerminalSequences(lines.at(-1)!), /3 lines hidden/);
        });

        it("uses the singular for a single hidden line", () => {
            const lines = renderBorderedBox(["x"], 40, { colorFn: identity, hidden: 1 });

            assert.match(stripTerminalSequences(lines.at(-1)!), /1 line hidden/);
            assert.doesNotMatch(stripTerminalSequences(lines.at(-1)!), /1 lines hidden/);
        });

        it("keeps the box rectangular when the hidden notice does not fit", () => {
            const lines = renderBorderedBox(["x"], 12, { colorFn: identity, hidden: 1234 });

            assertUniformWidth(lines, 12);
            assert.ok(stripTerminalSequences(lines.at(-1)!).startsWith("└"));
            assert.ok(stripTerminalSequences(lines.at(-1)!).endsWith("┘"));
        });

        it("stays rectangular for wide characters", () => {
            const lines = renderBorderedBox(["测试内容测试内容测试内容", "ok"], 16, { colorFn: identity });

            assertUniformWidth(lines, 16);
        });
    });
});
