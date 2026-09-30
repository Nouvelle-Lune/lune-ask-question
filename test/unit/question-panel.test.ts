import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import {
    questionManager,
    type AskQuestion,
    type AskQuestionRequest,
} from "../../src/core/questionManager.ts";
import { QuestionPanel } from "../../src/tui/question-panel.ts";
import {
    createFakeKeybindings,
    createFakeTheme,
    createFakeTui,
} from "../harness.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const SPACE = " ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Markdown styles headings and code through pi's module-level theme; the real TUI
// initializes it before any extension renders.
initTheme();

const OPTION_QUESTIONS: AskQuestion[] = [
    {
        question: "Which database?",
        options: [
            { label: "Postgres", description: "server" },
            { label: "SQLite", preview: "file.db" },
        ],
    },
];

interface Fixture {
    readonly request: AskQuestionRequest;
    readonly panel: QuestionPanel;
    readonly counts: { closed: number; deferred: number; reason: string | undefined };
}

function createFixture(questions: AskQuestion[], options: { rows?: number } = {}): Fixture {
    const request = questionManager.create(questions);
    const counts: Fixture["counts"] = { closed: 0, deferred: 0, reason: undefined };

    const panel = new QuestionPanel({
        request,
        tui: createFakeTui(options.rows),
        theme: createFakeTheme(),
        keybindings: createFakeKeybindings(),
        close: (reason) => {
            counts.closed++;
            counts.reason = reason;
        },
        onDeferred: () => {
            counts.deferred++;
        },
    });

    return { request, panel, counts };
}

function renderLines(panel: QuestionPanel, width = 80): string[] {
    return panel.render(width).map((line) => stripTerminalSequences(line));
}

function renderText(panel: QuestionPanel, width = 80): string {
    return renderLines(panel, width).join("\n");
}

/** Trimmed text of the framed body lines, with the borders taken off. */
function innerLines(panel: QuestionPanel, width = 80): string[] {
    return renderLines(panel, width)
        .filter((line) => line.startsWith("│"))
        .map((line) => line.replace(/^│/, "").replace(/│$/, "").trim());
}

/** The preview box is the only inner element that draws its own top border. */
function hasPreviewBox(panel: QuestionPanel, width = 80): boolean {
    return innerLines(panel, width).some((line) => line.includes("┌"));
}

function type(panel: QuestionPanel, text: string): void {
    for (const character of text) {
        panel.handleInput(character);
    }
}

describe("question panel", () => {
    beforeEach(() => {
        questionManager.clearAll();
    });

    describe("render", () => {
        it("shows the question, its options and the key hints", () => {
            const { panel } = createFixture(OPTION_QUESTIONS);

            const text = renderText(panel);

            assert.match(text, /Questions/);
            assert.match(text, /Which database\?/);
            assert.match(text, /1\. Postgres/);
            assert.match(text, /server/);
            assert.match(text, /2\. SQLite/);
            assert.match(text, /Type something/);
            assert.match(text, /s skip/);
            assert.match(text, /Esc close/);
        });

        it("titles the preview box with the focused option", () => {
            const { panel } = createFixture([
                {
                    question: "Which database?",
                    options: [{ label: "Postgres", preview: "server" }, { label: "SQLite" }],
                },
            ]);

            const inner = innerLines(panel, 120);

            assert.equal(
                inner.filter((line) => line.includes("┌─ Postgres ")).length,
                1,
                `the box carries the option name in its border: ${JSON.stringify(inner)}`,
            );
        });

        it("renders the focused option's preview, not the others", () => {
            const { panel } = createFixture([
                {
                    question: "Which database?",
                    options: [
                        { label: "Postgres", preview: "DATABASE_URL=postgres://localhost/app" },
                        { label: "SQLite", preview: "file.db" },
                    ],
                },
            ]);

            const lines = innerLines(panel, 120);

            assert.ok(
                lines.some((line) => line.includes("DATABASE_URL=postgres://localhost/app")),
                `the focused option's preview must render: ${JSON.stringify(lines)}`,
            );
            assert.equal(
                lines.some((line) => line.includes("file.db")),
                false,
                "an unfocused option's preview is not rendered",
            );
        });

        it("keeps every line inside the requested width", () => {
            const { panel } = createFixture([
                {
                    question: `A very long question ${"x".repeat(120)}`,
                    displayText: `A long preview\n${"y".repeat(200)}`,
                    options: [
                        {
                            label: `Option ${"a".repeat(100)}`,
                            description: "d".repeat(150),
                            preview: "p".repeat(160),
                        },
                        { label: "B", preview: `preview ${"f".repeat(120)}` },
                    ],
                },
            ]);

            for (const width of [30, 40, 70, 120]) {
                for (const line of panel.render(width)) {
                    assert.ok(
                        visibleWidth(line) <= width,
                        `line exceeds ${width} columns: ${JSON.stringify(stripTerminalSequences(line))}`,
                    );
                }
            }
        });

        it("does not number the questions", () => {
            const single = renderText(createFixture(OPTION_QUESTIONS).panel);
            const multi = renderText(createFixture([
                { header: "Storage", question: "First", options: [{ label: "A" }, { label: "B" }] },
                { header: "Auth", question: "Second", options: [{ label: "C" }, { label: "D" }] },
            ]).panel);

            for (const text of [single, multi]) {
                assert.equal(/\bQ\d\b/.test(text), false, `questions must not carry an automatic number: ${text}`);
            }

            assert.match(multi, /First/);
        });

        it("labels the tabs with the question headers", () => {
            const text = renderText(createFixture([
                { header: "Storage", question: "First", options: [{ label: "A" }, { label: "B" }] },
                { header: "Auth", question: "Second", options: [{ label: "C" }, { label: "D" }] },
            ]).panel);

            assert.match(text, /□ Storage/);
            assert.match(text, /□ Auth/);
            assert.match(text, /✓ Submit/);
            assert.match(text, /Tab\/←→ switch/);
        });

        it("cuts a header that is too long for a tab", () => {
            const text = renderText(createFixture([
                { header: "A very long header that will not fit", question: "First", options: [{ label: "A" }] },
                { header: "Auth", question: "Second", options: [{ label: "B" }] },
            ]).panel);

            assert.match(text, /□ A very long hea…/);
            assert.equal(text.includes("that will not fit"), false, "the tab is a label, not a sentence");
        });

        it("keeps the tabs visible when the body has to scroll", () => {
            const { panel } = createFixture([
                {
                    header: "Storage",
                    question: "Which database?",
                    displayText: Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"),
                    options: [{ label: "A" }, { label: "B" }],
                },
                { header: "Auth", question: "Which auth?", options: [{ label: "C" }] },
            ], { rows: 20 });

            const text = renderText(panel);

            assert.match(text, /□ Storage/);
            assert.match(text, /□ Auth/);
            assert.match(text, /✓ Submit/);
        });

        it("ends the body right after the content instead of padding to a fixed height", () => {
            const lines = renderLines(createFixture(OPTION_QUESTIONS).panel);
            const body = lines.slice(3, -3);
            const lastInner = body.at(-1)!.slice(1, -1).trim();

            assert.notEqual(
                lastInner.length,
                0,
                `the body ends on a content row, not padding: ${JSON.stringify(lines)}`,
            );
            assert.ok(lines.length < 24, `the panel shrank to its content: ${lines.length} rows`);
        });

        it("does not cap the panel height at a fixed number of rows", () => {
            const lines = renderLines(createFixture([
                {
                    header: "Storage",
                    question: "Which database?",
                    displayText: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
                    options: [{ label: "A" }, { label: "B" }],
                },
            ], { rows: 60 }).panel);

            const body = lines.slice(3, -3);
            const text = lines.join("\n");

            assert.ok(body.length > 18, `the body must use the room the terminal has: ${body.length} rows`);
            assert.match(text, /line 19/, "the whole request has to be on screen when the terminal has room");
            assert.match(text, /write your own answer/, "and it still ends on the last content row");
        });

        it("grows with the content", () => {
            const short = renderLines(createFixture(OPTION_QUESTIONS).panel).length;
            const tall = renderLines(createFixture([
                {
                    question: "Which database?",
                    displayText: Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"),
                    options: [{ label: "Postgres", description: "server" }, { label: "SQLite" }],
                },
            ]).panel).length;

            assert.ok(tall > short, `more content must mean a taller panel: ${tall} vs ${short}`);
        });
    });

    describe("option preview", () => {
        const PREVIEW_QUESTIONS: AskQuestion[] = [
            {
                question: "Which database?",
                options: [
                    { label: "Postgres", description: "server", preview: "## Postgres\n\nJSONB support" },
                    { label: "SQLite", description: "local file", preview: "## SQLite\n\nSingle file" },
                ],
            },
        ];

        const LONG_PREVIEW_QUESTIONS: AskQuestion[] = [
            {
                question: "Which database?",
                displayText: "Pick the storage engine for the new service.",
                options: [
                    {
                        label: "Postgres",
                        description: "server",
                        preview: Array.from({ length: 12 }, (_, index) => `- line ${index}`).join("\n"),
                    },
                    { label: "SQLite", description: "local file" },
                ],
            },
        ];

        it("renders the focused option's markdown in a box beside the options", () => {
            const { panel } = createFixture(PREVIEW_QUESTIONS);

            const lines = renderLines(panel, 120);
            const labelLine = lines.find((line) => line.includes("1. Postgres"));

            assert.ok(labelLine, "the focused option is rendered");
            assert.match(labelLine, /┌/, "the preview box shares the row band with the option rows");

            const text = renderText(panel, 120);
            assert.match(text, /JSONB support/);
            assert.equal(text.includes("Single file"), false, "the unfocused option's preview stays hidden");
        });

        it("swaps the preview when the focus moves", () => {
            const { panel } = createFixture(PREVIEW_QUESTIONS);

            panel.handleInput(DOWN);

            const text = renderText(panel, 120);
            assert.match(text, /Single file/);
            assert.equal(text.includes("JSONB support"), false);
        });

        it("shows the preview for a multi-select question as well", () => {
            const { panel } = createFixture([
                {
                    question: "Which checks?",
                    multiSelect: true,
                    options: [
                        { label: "Unit", preview: "unit preview" },
                        { label: "Integration", preview: "integration preview" },
                    ],
                },
            ]);

            assert.match(renderText(panel, 120), /unit preview/);

            panel.handleInput(SPACE);
            assert.match(renderText(panel, 120), /unit preview/, "toggling keeps the focused option's preview");

            panel.handleInput(DOWN);
            assert.match(renderText(panel, 120), /integration preview/);
        });

        it("keeps the box and explains an option without a preview", () => {
            const { panel } = createFixture([
                {
                    question: "Which database?",
                    options: [{ label: "Postgres", preview: "JSONB support" }, { label: "SQLite" }],
                },
            ]);

            panel.handleInput(DOWN);

            const text = renderText(panel, 120);
            assert.match(text, /No preview available/);
            assert.ok(hasPreviewBox(panel, 120), "the box stays while the focus moves");
        });

        it("does not open a preview column for a question without previews", () => {
            const { panel } = createFixture([
                {
                    question: "Which database?",
                    options: [
                        { label: "Postgres", description: "d".repeat(60) },
                        { label: "SQLite" },
                    ],
                },
            ]);

            const lines = renderLines(panel, 120);

            assert.equal(hasPreviewBox(panel, 120), false);
            assert.ok(
                lines.some((line) => line.includes("d".repeat(60))),
                "the descriptions keep the full panel width",
            );
        });

        it("stacks the preview under the options when the panel is narrow", () => {
            const { panel } = createFixture(PREVIEW_QUESTIONS);

            const lines = innerLines(panel, 80);
            const boxTop = lines.findIndex((line) => line.includes("┌"));
            const customRow = lines.findIndex((line) => line.includes("Type something"));

            assert.ok(boxTop >= 0, "the narrow layout keeps the preview");
            assert.ok(boxTop > customRow, "the box follows the option rows instead of sitting beside them");
        });

        it("gives the option list the full width while the editor is open", () => {
            const { panel } = createFixture(PREVIEW_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);
            assert.equal(
                hasPreviewBox(panel, 120),
                false,
                "typing a custom answer needs the room more than the preview does",
            );

            panel.handleInput(ESCAPE);
            assert.ok(hasPreviewBox(panel, 120), "the preview returns with the option list");
        });

        it("fits the preview block into a short panel body", () => {
            const { panel } = createFixture(LONG_PREVIEW_QUESTIONS, { rows: 24 });

            for (const width of [120, 80]) {
                const inner = innerLines(panel, width);
                const boxTop = inner.findIndex((line) => line.includes("┌"));
                const boxBottom = inner.findIndex((line) => line.includes("└"));

                assert.ok(boxTop >= 0, `the preview box is rendered at ${width} columns`);
                assert.ok(
                    boxBottom > boxTop,
                    `the bottom border survives the window at ${width} columns: ${JSON.stringify(inner)}`,
                );
                assert.match(
                    inner[boxBottom]!,
                    /lines hidden/,
                    "the rows that no longer fit are reported instead of clipped silently",
                );
            }
        });

        it("drops the preview when the body cannot hold a box", () => {
            const { panel } = createFixture(LONG_PREVIEW_QUESTIONS, { rows: 16 });

            const inner = innerLines(panel, 80);

            assert.equal(hasPreviewBox(panel, 80), false);
            assert.ok(
                inner.some((line) => line.includes("1. Postgres")),
                "the options still render, just without the preview column",
            );
        });

        it("recomputes the layout for the current width on every render", () => {
            const { panel } = createFixture(PREVIEW_QUESTIONS);

            const wide = renderLines(panel, 160);
            assert.ok(
                wide.some((line) => line.includes("1. Postgres") && line.includes("┌")),
                "side by side at 160 columns",
            );

            const narrow = innerLines(panel, 80);
            const boxTop = narrow.findIndex((line) => line.includes("┌"));
            const customRow = narrow.findIndex((line) => line.includes("Type something"));
            assert.ok(boxTop > customRow, `stacked after the resize: ${JSON.stringify(narrow)}`);

            assert.deepEqual(renderLines(panel, 160), wide, "back to the original layout after resizing back");
        });

        it("never leaves a preview box without its bottom border", () => {
            for (const rows of [16, 18, 20, 22, 24, 28]) {
                for (const width of [140, 100, 80]) {
                    const { panel } = createFixture(LONG_PREVIEW_QUESTIONS, { rows });
                    const inner = innerLines(panel, width);
                    const boxTop = inner.findIndex((line) => line.includes("┌"));

                    if (boxTop < 0) {
                        continue;
                    }

                    assert.ok(
                        inner.findIndex((line) => line.includes("└")) > boxTop,
                        `clipped preview box at ${rows} rows / ${width} columns: ${JSON.stringify(inner)}`,
                    );
                }
            }
        });
    });

    describe("single select", () => {
        it("answers the focused option and settles a single-question request", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [0] }]);
            assert.equal(request.status, "answered");
            assert.equal(counts.closed, 1);
        });

        it("moves the focus with the arrow keys before answering", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(DOWN);
            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [1] }]);
        });

        it("wraps the focus at both ends", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);

            // Rows are option 0, option 1, custom; one step up from the first crosses to the
            // custom row, one step down from it comes back.
            panel.handleInput(UP);
            assert.equal(request.draft.optionIndex, 2);

            panel.handleInput(DOWN);
            assert.equal(request.draft.optionIndex, 0);
        });

        it("selects an option by its number key", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);

            panel.handleInput("2");

            assert.deepEqual(request.answers, [{ selectedIndexes: [1] }]);
        });
    });

    describe("multi select", () => {
        const questions: AskQuestion[] = [
            {
                question: "Which checks?",
                multiSelect: true,
                options: [{ label: "Unit" }, { label: "Integration" }],
            },
        ];

        it("toggles checkboxes with space and confirms from the next row", () => {
            const { panel, request, counts } = createFixture(questions);

            panel.handleInput(SPACE);
            panel.handleInput(DOWN);
            panel.handleInput(SPACE);

            assert.deepEqual(request.answers, undefined);

            // option 1 -> custom -> next
            panel.handleInput(DOWN);
            panel.handleInput(DOWN);
            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [0, 1] }]);
            assert.equal(request.status, "answered");
            assert.equal(counts.closed, 1);
        });

        it("untoggles a selected option", () => {
            const { panel, request } = createFixture(questions);

            panel.handleInput(SPACE);
            panel.handleInput(SPACE);

            assert.deepEqual(request.answers, undefined);
        });

        it("shows the checkbox state and the next row", () => {
            const { panel } = createFixture(questions);

            panel.handleInput(SPACE);

            const text = renderText(panel);

            assert.match(text, /\[x\] 1\. Unit/);
            assert.match(text, /\[ \] 2\. Integration/);
            assert.match(text, /Next/);
            assert.match(text, /Space\/Enter toggle/);
        });
    });

    describe("several questions", () => {
        const questions: AskQuestion[] = [
            { header: "Storage", question: "First", options: [{ label: "A" }, { label: "B" }] },
            { header: "Auth", question: "Second", options: [{ label: "C" }, { label: "D" }] },
        ];

        it("advances to the next question, then to the submit tab", () => {
            const { panel, request, counts } = createFixture(questions);

            panel.handleInput(ENTER);
            assert.equal(request.draft.currentIndex, 1);
            assert.deepEqual(request.answers?.[0], undefined);

            panel.handleInput(ENTER);
            assert.equal(request.draft.currentIndex, 2);
            assert.match(renderText(panel), /Ready to submit/);

            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [
                { selectedIndexes: [0] },
                { selectedIndexes: [0] },
            ]);
            assert.equal(request.status, "answered");
            assert.equal(counts.closed, 1);
        });

        it("switches tabs with Tab and Shift+Tab", () => {
            const { panel, request } = createFixture(questions);

            panel.handleInput(TAB);
            assert.equal(request.draft.currentIndex, 1);
            panel.handleInput(SHIFT_TAB);
            assert.equal(request.draft.currentIndex, 0);
        });

        it("jumps to the first unanswered question instead of submitting", () => {
            const { panel, request, counts } = createFixture(questions);

            panel.handleInput(TAB);
            panel.handleInput(TAB);
            assert.equal(request.draft.currentIndex, 2);

            panel.handleInput(ENTER);

            assert.equal(request.draft.currentIndex, 0);
            assert.equal(counts.closed, 0);
            assert.equal(request.status, "pending");

            panel.handleInput(TAB);
            panel.handleInput(TAB);
            assert.match(renderText(panel), /Unanswered: Storage, Auth/);
        });
    });

    describe("custom answers", () => {
        const TWO_QUESTIONS: AskQuestion[] = [
            { question: "First", options: [{ label: "A" }, { label: "B" }] },
            { question: "Second", options: [{ label: "C" }, { label: "D" }] },
        ];

        /** The `✎` row is what the user picks to write an answer instead of choosing an option. */
        function customRow(panel: QuestionPanel): string {
            const row = innerLines(panel).find((line) => line.includes("✎"));

            assert.ok(row, "the custom row must render");

            return row;
        }

        it("writes an answer on the custom row", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            // option 0 -> custom is one row up
            panel.handleInput(UP);
            panel.handleInput(ENTER);
            assert.match(renderText(panel), /Your answer:/);

            type(panel, "mysql");
            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [], customText: "mysql" }]);
            assert.equal(counts.closed, 1);
        });

        it("opens the editor immediately for a free-form question", () => {
            const { panel, request } = createFixture([{ question: "Name the service?" }]);

            assert.match(renderText(panel), /Your answer:/);

            type(panel, "billing");
            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [], customText: "billing" }]);
        });

        it("ignores an empty custom answer and stays in the editor", () => {
            const { panel, request, counts } = createFixture([{ question: "Name the service?" }]);

            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, undefined);
            assert.equal(counts.closed, 0);
        });

        it("replaces a selected option when the user writes an answer", () => {
            const { panel, request } = createFixture([
                { question: "First", options: [{ label: "A" }, { label: "B" }] },
                { question: "Second", options: [{ label: "C" }, { label: "D" }] },
            ]);

            panel.handleInput(ENTER);
            assert.deepEqual(request.draft.answers[0], { selectedIndexes: [0] });

            panel.handleInput(SHIFT_TAB);
            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "mysql");
            panel.handleInput(ENTER);

            assert.deepEqual(request.draft.answers[0], { selectedIndexes: [], customText: "mysql" });
        });

        it("keeps the custom row on the placeholder while the answer is being typed", () => {
            const { panel } = createFixture(OPTION_QUESTIONS);

            // option 0 -> custom is one row up, Enter opens the editor
            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "mysql");

            assert.match(customRow(panel), /Type something/);
            assert.equal(customRow(panel).includes("mysql"), false, "typing must not rewrite the row");

            // The text is not lost - it lives in the editor under the options.
            const lines = innerLines(panel);
            const editor = lines.findIndex((line) => line.includes("Your answer:"));

            assert.ok(
                lines.slice(editor).some((line) => line.includes("mysql")),
                `the editor still shows what is typed: ${JSON.stringify(lines)}`,
            );
        });

        it("shows the written answer once it is committed", () => {
            const { panel } = createFixture(TWO_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "mysql");
            panel.handleInput(ENTER);
            panel.handleInput(SHIFT_TAB);

            assert.match(customRow(panel), /mysql/);
            assert.equal(customRow(panel).includes("Type something"), false);
        });

        it("starts typing on the custom row without pressing Enter", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            type(panel, "mysql");

            assert.equal(request.draft.customDrafts[0], "mysql");
            assert.deepEqual(request.draft.answers, [undefined], "typing alone does not answer the question");

            const lines = innerLines(panel);
            const editor = lines.findIndex((line) => line.includes("Your answer:"));

            assert.ok(
                lines.slice(editor).some((line) => line.includes("mysql")),
                `the editor shows what was typed: ${JSON.stringify(lines)}`,
            );
        });

        it("treats digits, j/k and space as text on the custom row", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            type(panel, "2j ");

            assert.equal(request.status, "pending", "a printable key on the custom row starts the answer");
            assert.equal(request.draft.customDrafts[0], "2j ");
        });

        it("skips from the custom row with s", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput("s");

            assert.equal(request.status, "skipped");
            assert.equal(counts.closed, 1);
        });

        it("keeps a large paste when the draft is captured", () => {
            const { panel, request } = createFixture(OPTION_QUESTIONS);
            const pasted = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");

            // option 0 -> custom row, then the editor
            panel.handleInput(UP);
            panel.handleInput(ENTER);
            panel.handleInput(`${PASTE_START}${pasted}${PASTE_END}`);

            // The editor holds a paste this large behind a marker; the draft has to keep the text.
            panel.handleInput(ESCAPE);

            assert.equal(request.draft.customDrafts[0], pasted);

            const reopened = new QuestionPanel({
                request,
                tui: createFakeTui(),
                theme: createFakeTheme(),
                keybindings: createFakeKeybindings(),
                close: () => undefined,
            });

            reopened.handleInput(ENTER);

            assert.match(renderText(reopened), /line 11/, "the pasted lines are back in the editor");
        });

        it("does not mirror edits to an answer that was already written", () => {
            const { panel } = createFixture(TWO_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "mysql");
            panel.handleInput(ENTER);
            panel.handleInput(SHIFT_TAB);

            // Reopen the editor on the written answer and keep typing.
            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "-8");

            assert.match(customRow(panel), /mysql/);
            assert.equal(customRow(panel).includes("mysql-8"), false, "the row must not follow the edit");
        });
    });

    describe("defer and skip", () => {
        it("defers on Esc without settling and keeps focus and draft", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(DOWN);
            panel.handleInput(ESCAPE);

            assert.equal(request.status, "pending");
            assert.equal(counts.closed, 1);
            assert.equal(counts.deferred, 1);
            assert.equal(request.draft.optionIndex, 1);
            assert.deepEqual(request.draft.answers, [undefined]);
        });

        it("returns from the editor to the options first, then defers", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "half typed");
            panel.handleInput(ESCAPE);

            assert.equal(counts.closed, 0, "the first Esc only closes the editor");
            assert.equal(request.draft.customDrafts[0], "half typed");
            assert.deepEqual(request.draft.answers, [undefined]);

            panel.handleInput(ESCAPE);

            assert.equal(counts.closed, 1);
            assert.equal(counts.deferred, 1);
        });

        it("keeps the written draft for the editor when the panel reopens", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);
            type(panel, "half typed");
            panel.handleInput(ESCAPE);
            panel.handleInput(ESCAPE);

            assert.equal(counts.closed, 1);

            const reopened = new QuestionPanel({
                request,
                tui: createFakeTui(),
                theme: createFakeTheme(),
                keybindings: createFakeKeybindings(),
                close: () => undefined,
            });

            assert.equal(request.draft.customDrafts[0], "half typed");
            assert.equal(request.draft.optionIndex, 2, "the custom row keeps the focus");
            assert.equal(
                renderText(reopened).includes("half typed"),
                false,
                "the draft is not echoed until the editor is opened again",
            );

            reopened.handleInput(ENTER);

            assert.match(renderText(reopened), /half typed/);
        });

        it("reports why the panel closed", () => {
            const answered = createFixture(OPTION_QUESTIONS);
            answered.panel.handleInput(ENTER);
            assert.equal(answered.counts.reason, "settled");

            const skipped = createFixture(OPTION_QUESTIONS);
            skipped.panel.handleInput("s");
            assert.equal(skipped.counts.reason, "settled");

            const deferred = createFixture(OPTION_QUESTIONS);
            deferred.panel.handleInput(ESCAPE);
            assert.equal(deferred.counts.reason, "deferred");
        });

        it("skips the whole request with s", () => {
            const { panel, request, counts } = createFixture(OPTION_QUESTIONS);

            panel.handleInput("s");

            assert.equal(request.status, "skipped");
            assert.equal(request.answers, undefined);
            assert.equal(counts.closed, 1);
            assert.equal(counts.deferred, 0);
        });

        it("treats the s key as text while the editor is open", () => {
            const { panel, request, counts } = createFixture([{ question: "Name the service?" }]);

            type(panel, "is");
            panel.handleInput(ENTER);

            assert.deepEqual(request.answers, [{ selectedIndexes: [], customText: "is" }]);
            assert.equal(counts.closed, 1);
        });

        it("skips a free-form question after leaving its editor", () => {
            const { panel, request, counts } = createFixture([{ question: "Name the service?" }]);

            // A free-form question opens the editor itself, so `s` has to stay reachable
            // through Esc instead of being a key the user can never press.
            assert.match(renderText(panel), /Your answer:/);

            panel.handleInput(ESCAPE);
            assert.equal(renderText(panel).includes("Your answer:"), false, "the first Esc leaves the editor");

            panel.handleInput("s");

            assert.equal(request.status, "skipped");
            assert.equal(counts.closed, 1);
        });

        it("does not advertise s while the editor owns the key", () => {
            const { panel } = createFixture(OPTION_QUESTIONS);

            panel.handleInput(UP);
            panel.handleInput(ENTER);

            const footer = innerLines(panel).at(-1)!;

            assert.match(footer, /Esc back to options/);
            assert.equal(footer.includes("s skip"), false, "the editor turns s into text");
        });
    });
});
