import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { questionManager } from "../../src/core/questionManager.ts";
import { QuestionDock } from "../../src/tui/question-dock.ts";
import { createFakeContext, createFakeUi, type FakeUi } from "../harness.ts";

/** Widget key the extension registers; changing it changes where the dock appears. */
const WIDGET_KEY = "lune-ask-question";

describe("question dock", () => {
    let dock: QuestionDock;
    let ui: FakeUi;

    beforeEach(() => {
        questionManager.clearAll();
        dock = new QuestionDock();
        ui = createFakeUi();
    });

    function render(ctx = createFakeContext({ ui })): void {
        dock.setCtx(ctx);
        dock.render();
    }

    function line(): string {
        const content = ui.mountedWidget("belowEditor", WIDGET_KEY);
        assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
        assert.equal(content.length, 1, "the dock must stay a single line");

        return content[0]!;
    }

    it("does nothing before a context is set", () => {
        questionManager.create([{ question: "Which database?" }]);

        dock.render();

        assert.deepEqual(ui.widgetCalls, []);
    });

    it("does nothing without an interactive UI", () => {
        questionManager.create([{ question: "Which database?" }]);

        render(createFakeContext({ ui, hasUI: false }));
        dock.clear();

        assert.deepEqual(ui.widgetCalls, []);
    });

    it("removes the widget when nothing is pending", () => {
        render();

        assert.deepEqual(ui.widgetCalls, [
            { key: WIDGET_KEY, content: undefined, placement: undefined },
        ]);
        assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
    });

    it("mounts the pending question below the editor with the reopen hint", () => {
        questionManager.create([{ question: "Which database?" }]);

        render();

        assert.equal(line(), "1 pending question · Which database? · /question to answer");
        assert.deepEqual(ui.widgetCalls.at(-1), {
            key: WIDGET_KEY,
            content: ["1 pending question · Which database? · /question to answer"],
            placement: "belowEditor",
        });
    });

    it("counts several pending requests and previews the next one", () => {
        questionManager.create([{ question: "First question" }]);
        questionManager.create([{ question: "Second question" }]);

        render();

        assert.equal(line(), "2 pending questions · First question · /question to answer");
    });

    it("previews the request the panel would show next", () => {
        const first = questionManager.create([{ question: "First question" }]);
        questionManager.create([{ question: "Second question" }]);

        // The first one was already on screen, so the newer one is what comes next.
        questionManager.markShown(first.id);

        render();

        assert.equal(line(), "2 pending questions · Second question · /question to answer");
    });

    it("truncates a long question and keeps one line", () => {
        questionManager.create([{ question: `Which ${"x".repeat(60)} database?\nsecond line` }]);

        render();

        const rendered = line();
        assert.equal(rendered.includes("\n"), false);

        const clean = stripTerminalSequences(rendered);
        assert.match(clean, /^1 pending question · .*… · \/question to answer$/);
        // 18 count + 3 + 42 summary + 3 + 20 hint; the summary budget is the only slack.
        assert.ok(visibleWidth(clean) <= 86, `dock line too wide: ${clean}`);
    });

    it("truncates a CJK question by terminal columns, not by string length", () => {
        // 24 code units but 48 columns: a length-based budget never truncates it.
        const question = "运行测试脚本并输出结果并继续运行并检查日志输出与状态";
        assert.ok(question.length <= 40, "guard: the code-unit length fits the budget");
        assert.ok(visibleWidth(question) > 40, "guard: the display width does not");
        questionManager.create([{ question }]);

        render();

        const summary = /^1 pending question · (.*) · \/question to answer$/.exec(stripTerminalSequences(line()))?.[1];
        assert.ok(summary, "the dock line must keep its shape");
        assert.ok(visibleWidth(summary) <= 41, `summary too wide: ${JSON.stringify(summary)}`);
        assert.ok(summary.endsWith("…"), "an over-budget question must be marked as truncated");
    });

    it("clears only the dock widget", () => {
        questionManager.create([{ question: "Which database?" }]);
        render();

        dock.clear();

        assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
        assert.deepEqual(ui.widgetCalls.at(-1), {
            key: WIDGET_KEY,
            content: undefined,
            placement: undefined,
        });
    });
});
