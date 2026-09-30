/**
 * Integration contract of the extension entry point.
 *
 * These tests drive the real `src/index.ts` through a fake pi host: the tool creates a
 * request, the panel opens through `ctx.ui.custom`, the answers travel back as a
 * `sendMessage` follow-up, and the session lifecycle persists and restores pending
 * questions. The panel's own key handling is covered by `test/unit/question-panel.test.ts`;
 * here it is only driven far enough to settle a request.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { stripTerminalSequences } from "@earendil-works/pi-tui";

import luneAskQuestion from "../../src/index.ts";
import { QUESTION_STATE_ENTRY, QUESTION_STATE_VERSION, questionManager, type AskQuestion } from "../../src/core/questionManager.ts";
import { ASK_QUESTION_ANSWER_MESSAGE } from "../../src/core/question-notification.ts";
import { resetQuestionPanelState } from "../../src/tui/question-panel.ts";
import {
    createFakeContext,
    createFakePiHost,
    createFakeTheme,
    createFakeUi,
    requireTool,
    type FakeBranchEntry,
    type FakePiHost,
    type FakeUi,
} from "../harness.ts";

const WIDGET_KEY = "lune-ask-question";
const ENTER = "\r";

const QUESTIONS: AskQuestion[] = [
    {
        header: "Storage",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
];

interface Session {
    readonly host: FakePiHost;
    readonly ui: FakeUi;
    readonly branch: FakeBranchEntry[];
}

/** Register the extension and start a session over `branch`, defaulting to a fresh one. */
async function startSession(branch: FakeBranchEntry[] = []): Promise<Session> {
    const host = createFakePiHost(luneAskQuestion, { branch });
    const ui = createFakeUi();
    const ctx = createFakeContext({ ui, branch });

    await host.fire("session_start", ctx);

    return { host, ui, branch };
}

/** Answer the currently open panel with its focused option. */
function answerFocusedOption(ui: FakeUi): void {
    assert.ok(ui.panel, "expected an open question panel");

    ui.panel.handleInput?.(ENTER);
}

/** Create a request through the tool; the panel it opens stays open until it is driven. */
async function ask(host: FakePiHost, ui: FakeUi, questions: AskQuestion[], callId: string): Promise<void> {
    await requireTool(host, "ask_user_questions").execute(
        callId,
        { questions },
        undefined,
        undefined,
        createFakeContext({ ui, branch: host.branch }),
    );
}

/** Text of the currently open panel, borders included. */
function panelText(ui: FakeUi, width = 120): string {
    assert.ok(ui.panel, "expected an open question panel");

    return stripTerminalSequences(ui.panel.render(width).join("\n"));
}

/**
 * Wait for an observable condition. Handing a panel over to the next request takes a few
 * microtask hops, so awaiting the closed panel's promise alone would race the next open.
 */
async function waitUntil(predicate: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
            return true;
        }

        await new Promise((resolve) => setImmediate(resolve));
    }

    return predicate();
}

/** Let the panel loop quiesce before asserting that it opens nothing further. */
async function drain(): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

describe("lune-ask-question extension", () => {
    beforeEach(() => {
        resetQuestionPanelState();
        questionManager.clearAll();
    });

    describe("registration", () => {
        it("registers the tool, the command and the answer renderer", () => {
            const host = createFakePiHost(luneAskQuestion);

            assert.ok(host.tools.has("ask_user_questions"));
            assert.ok(host.commands.has("question"));
            assert.ok(host.messageRenderers.has(ASK_QUESTION_ANSWER_MESSAGE));

            const tool = requireTool(host, "ask_user_questions");
            assert.equal((tool as { exposure?: string }).exposure, "model-only");
            assert.equal((tool as { executionMode?: string }).executionMode, "sequential");
            assert.match(tool.description, /panel opens immediately/);
            assert.ok(
                (tool as { promptGuidelines?: string[] }).promptGuidelines?.some((line) => /preview/i.test(line)),
                "the model has to be told when a preview is worth adding",
            );
            assert.ok(
                (tool as { promptGuidelines?: string[] }).promptGuidelines?.some((line) => /header/i.test(line)),
                "the tabs need a short header, and the model is what writes it",
            );
        });
    });

    describe("tool execution", () => {
        it("opens the panel immediately and returns a pending result", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            const result = await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);

            const requestId = questionManager.getPendingRequests()[0]!.id;
            const pendingText = String(result.content[0]?.type === "text" ? result.content[0].text : "");

            assert.equal(result.isError, undefined);
            assert.deepEqual(result.details, { status: "pending", requestId });
            assert.match(pendingText, /Questions are pending/);
            assert.match(pendingText, /follow-up message/);
            assert.equal(
                pendingText.includes("Which database?"),
                false,
                "the questions are already in the tool call arguments",
            );
            assert.equal(pendingText.includes(requestId), false, "the request id is not model-facing");
            assert.equal(ui.customCalls.length, 1);
            assert.equal(ui.customCalls[0]!.overlay, true);
            assert.equal(questionManager.getPendingRequests().length, 1);
            assert.equal(
                ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0],
                "1 pending question · Which database? · /question to answer",
            );
        });

        it("persists the pending request before the user sees it", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);

            const persisted = host.appendEntryCalls.filter((call) => call.customType === QUESTION_STATE_ENTRY);
            const first = persisted[0]!.data as { version: number; requests: unknown[] };

            assert.equal(persisted.length, 2, "creating and showing the request each write a snapshot");
            assert.equal(first.version, QUESTION_STATE_VERSION, "the snapshot carries the format it was written in");
            assert.equal(first.requests.length, 1, "the request is in a snapshot before it is shown");
        });

        it("reports that the tool is unavailable outside the TUI", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, mode: "print", branch: host.branch });

            const result = await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);

            assert.equal(result.isError, true);
            assert.deepEqual(result.details, { status: "unavailable" });
            assert.equal(ui.customCalls.length, 0);
            assert.equal(questionManager.getPendingRequests().length, 0);
        });
    });

    describe("answer delivery", () => {
        it("delivers the answers as a follow-up message that steers the model", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);
            answerFocusedOption(ui);

            assert.equal(host.sendMessageCalls.length, 1);

            const call = host.sendMessageCalls[0]!;
            assert.equal(call.message.customType, ASK_QUESTION_ANSWER_MESSAGE);
            assert.deepEqual(call.options, { triggerTurn: true, deliverAs: "steer" });
            assert.match(String(call.message.content), /The user answered these questions\./);
            assert.match(String(call.message.content), /Which database\?/);
            assert.equal(String(call.message.content).includes("Q1"), false, "the answer must not invent a question number");
            assert.match(String(call.message.content), /answer: selected: 1\. Postgres/);

            const details = call.message.details as { status: string; answers: unknown[] };
            assert.equal(details.status, "answered");
            assert.deepEqual(details.answers, [{ selectedIndexes: [0] }]);
        });

        it("keeps the panel-only previews out of the delivered answer", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute(
                "call-1",
                {
                    questions: [
                        {
                            header: "Storage",
                            question: "Which database?",
                            displayText: "DISPLAY_SENTINEL",
                            options: [{ label: "Postgres", preview: "PREVIEW_SENTINEL" }, { label: "SQLite" }],
                        },
                    ],
                },
                undefined,
                undefined,
                ctx,
            );
            answerFocusedOption(ui);

            const call = host.sendMessageCalls[0]!;
            assert.equal(
                String(call.message.content).includes("PREVIEW_SENTINEL"),
                false,
                "a preview is display input, not part of the answer",
            );

            const details = JSON.stringify(call.message.details);
            assert.equal(details.includes("PREVIEW_SENTINEL"), false, "a preview must not enter the session transcript");
            assert.equal(details.includes("DISPLAY_SENTINEL"), false, "neither must the display text");
            assert.equal(details.includes("Postgres"), true, "the answer row still names the options");
            assert.deepEqual((call.message.details as { answers: unknown[] }).answers, [{ selectedIndexes: [0] }]);
        });

        it("delivers a skip as a follow-up message", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);
            ui.panel!.handleInput?.("S");

            assert.equal(host.sendMessageCalls.length, 1);
            assert.match(String(host.sendMessageCalls[0]!.message.content), /skipped these questions/);
        });

        it("delivers a settled answer exactly once", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            // A second settle attempt (a key landing while the panel closes) must not deliver again.
            ui.panel!.handleInput?.(ENTER);
            ui.panel!.handleInput?.("S");

            assert.equal(host.sendMessageCalls.length, 1);
            assert.equal((host.sendMessageCalls[0]!.message.details as { status: string }).status, "answered");
        });

        it("keeps a settled answer when the delivery throws, and says so", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            // pi rejects the call (for example while it is switching sessions): the answer must
            // still be settled and persisted, and the user must learn it never arrived.
            host.api.sendMessage = () => {
                throw new Error("session not owned");
            };

            ui.panel!.handleInput?.(ENTER);
            await ui.panelClosed;

            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.equal(
                (host.appendEntryCalls.at(-1)!.data as { requests: unknown[] }).requests.length,
                0,
                "the settled state is persisted",
            );
            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be delivered/.test(call.message)),
                `expected a delivery error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
        });

        it("persists the settled state so the answered request cannot come back", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);
            answerFocusedOption(ui);

            const last = host.appendEntryCalls.filter((call) => call.customType === QUESTION_STATE_ENTRY).at(-1);
            assert.equal((last!.data as { requests: unknown[] }).requests.length, 0);
        });
    });

    describe("multiple pending requests", () => {
        const SECOND: AskQuestion[] = [{ header: "Port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] }];
        const THIRD: AskQuestion[] = [{ header: "Host", question: "Which host?", options: [{ label: "local" }, { label: "remote" }] }];

        it("surfaces the next request once the current one is answered", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            await ask(host, ui, SECOND, "call-2");

            assert.equal(questionManager.getPendingRequests().length, 2);
            assert.equal(ui.customCalls.length, 1, "one panel at a time");

            answerFocusedOption(ui);
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the queued request surfaces without /question");
            assert.match(panelText(ui), /Which port\?/);
        });

        it("queues concurrent tool calls in call order and counts them in the dock", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            // Two calls issued together (one assistant message): the queue is ordered by arrival,
            // and the dock reports the whole backlog rather than just the visible request.
            await Promise.all([
                tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx),
                tool.execute("call-2", { questions: SECOND }, undefined, undefined, ctx),
            ]);

            assert.match(panelText(ui), /Which database\?/, "the first call owns the panel");
            assert.equal(questionManager.getPendingRequests().length, 2);
            // The dock names the question the panel would show next, which is the queued one.
            assert.match(String(ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0]), /2 pending questions · Which port\?/);

            answerFocusedOption(ui);
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the queued call surfaces");
            assert.match(panelText(ui), /Which port\?/);
            assert.match(String(ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0]), /1 pending question · Which port\?/);
        });

        it("walks through three pending requests in order", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            await ask(host, ui, SECOND, "call-2");
            await ask(host, ui, THIRD, "call-3");

            answerFocusedOption(ui);
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the second request surfaces");
            assert.match(panelText(ui), /Which port\?/);

            answerFocusedOption(ui);
            assert.ok(await waitUntil(() => ui.customCalls.length === 3), "the third request surfaces");
            assert.match(panelText(ui), /Which host\?/);

            answerFocusedOption(ui);
            await drain();

            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.equal(ui.customCalls.length, 3, "no panel is opened for an empty queue");
        });

        it("shows a new request ahead of an older one that was only deferred", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            await ask(host, ui, SECOND, "call-2");

            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the new request surfaces");
            assert.match(panelText(ui), /Which port\?/);
            assert.equal(questionManager.getPendingRequests().length, 2, "the deferred request stays pending");
        });

        it("stops auto-surfacing after a defer and keeps the request pending", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            assert.equal(ui.customCalls.length, 1, "a defer is quiet: no panel pops back up");
            assert.equal(questionManager.getPendingRequests().length, 1);

            // The explicit command is what brings the panel back.
            void host.commands.get("question")!.handler("", createFakeContext({ ui, branch: host.branch }));
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "/question reopens the request");
            assert.match(panelText(ui), /Which database\?/);
        });

        it("falls back to the request that was shown least recently", async () => {
            const { host, ui } = await startSession();

            // The first request is shown and deferred; the second arrives, is shown and deferred.
            await ask(host, ui, QUESTIONS, "call-1");
            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            await ask(host, ui, SECOND, "call-2");
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the new request surfaces");
            assert.match(panelText(ui), /Which port\?/);

            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            assert.equal(questionManager.getPendingRequests().length, 2);

            // Nothing is unseen any more, so `/question` returns to the least recently shown one.
            void host.commands.get("question")!.handler("", createFakeContext({ ui, branch: host.branch }));
            assert.ok(await waitUntil(() => ui.customCalls.length === 3), "/question reopens a pending request");
            assert.match(panelText(ui), /Which database\?/);
        });

        it("gives the next request fresh preview renderers", async () => {
            const { host, ui } = await startSession();
            const withPreview = (preview: string): AskQuestion[] => [
                {
                    header: "Storage",
                    question: "Which database?",
                    options: [{ label: "Postgres", preview }, { label: "SQLite" }],
                },
            ];

            await ask(host, ui, withPreview("first preview"), "call-1");
            assert.match(panelText(ui, 140), /first preview/);

            await ask(host, ui, withPreview("second preview"), "call-2");
            answerFocusedOption(ui);
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the second request surfaces");

            const rendered = panelText(ui, 140);
            assert.match(rendered, /second preview/);
            assert.equal(rendered.includes("first preview"), false, "a new panel must not reuse the old cache");
        });

        it("keeps the dock on the request /question would reopen", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            await ask(host, ui, SECOND, "call-2");
            assert.ok(await waitUntil(() => ui.customCalls.length === 2), "the new request surfaces");

            // Showing the second request moved it behind the deferred first one, and the dock
            // has to say so while the second panel is still up.
            assert.match(
                String(ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0]),
                /2 pending questions · Which database\?/,
            );

            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            await drain();

            assert.match(
                String(ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0]),
                /2 pending questions · Which database\?/,
            );

            void host.commands.get("question")!.handler("", createFakeContext({ ui, branch: host.branch }));

            assert.ok(await waitUntil(() => ui.customCalls.length === 3), "/question opens the request the dock names");
            assert.match(panelText(ui), /Which database\?/);
        });
    });

    describe("reopening", () => {
        it("notifies when no question is pending", async () => {
            const { host, ui } = await startSession();
            const command = host.commands.get("question")!;

            await command.handler("", createFakeContext({ ui, branch: host.branch }));

            assert.deepEqual(ui.notifyCalls, [{ message: "No pending questions", type: "info" }]);
            assert.equal(ui.customCalls.length, 0);
        });

        it("reopens the pending panel after Esc deferred it", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);

            ui.panel!.handleInput?.("\x1b");
            assert.equal(questionManager.getPendingRequests().length, 1);

            // The overlay promise has to settle (and release the open-panel guard) before
            // the command may open the next one.
            await ui.panelClosed;
            await drain();

            // The command handler awaits the overlay's lifetime, so it stays pending until the
            // reopened panel closes; the custom() call is registered synchronously.
            void host.commands.get("question")!.handler("", ctx);

            assert.equal(ui.customCalls.length, 2);
            assert.ok(questionManager.getPendingRequest(questionManager.getPendingRequests()[0]!.id));

            ui.panel!.handleInput?.("\x1b");
            await ui.panelClosed;
            assert.equal(questionManager.getPendingRequests().length, 1);
        });
    });

    describe("session lifecycle", () => {
        it("restores pending questions and the dock after a restart", async () => {
            const branch: FakeBranchEntry[] = [];

            const first = await startSession(branch);
            const tool = requireTool(first.host, "ask_user_questions");
            await tool.execute(
                "call-1",
                { questions: QUESTIONS },
                undefined,
                undefined,
                createFakeContext({ ui: first.ui, branch }),
            );

            // The user closes the panel without answering and quits Pi.
            first.ui.panel!.handleInput?.("\x1b");
            await first.host.fire("session_shutdown", createFakeContext({ ui: first.ui, branch }));

            assert.equal(questionManager.getPendingRequests().length, 0);

            const second = await startSession(branch);

            const restored = questionManager.getPendingRequests();
            assert.equal(restored.length, 1);
            assert.equal(restored[0]!.questions[0]!.question, "Which database?");
            assert.equal(
                second.ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0],
                "1 pending question · Which database? · /question to answer",
            );

            void second.host.commands.get("question")!.handler(
                "",
                createFakeContext({ ui: second.ui, branch }),
            );
            assert.ok(second.ui.panel, "the restored question must be answerable");
        });

        it("clears the dock and the pending list on shutdown", async () => {
            const { host, ui, branch } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, createFakeContext({ ui, branch }));

            await host.fire("session_shutdown", createFakeContext({ ui, branch }));

            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
        });

        it("restores the pending questions of the branch a tree jump lands on", async () => {
            const branch: FakeBranchEntry[] = [];

            const first = await startSession(branch);
            const tool = requireTool(first.host, "ask_user_questions");
            await tool.execute(
                "call-1",
                { questions: QUESTIONS },
                undefined,
                undefined,
                createFakeContext({ ui: first.ui, branch }),
            );
            await first.host.fire("session_before_tree", createFakeContext({ ui: first.ui, branch }));

            // The new branch is the same array in this fake, so the snapshot is found again.
            await first.host.fire("session_tree", createFakeContext({ ui: first.ui, branch }));

            assert.equal(questionManager.getPendingRequests().length, 1);
        });

        it("does not let a stale overlay release the panel of the session that replaced it", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            assert.equal(ui.customCalls.length, 1);

            // The session is replaced while the first overlay is still up.
            const replacement = createFakeUi();
            const replacementQuestions: AskQuestion[] = [
                { header: "Port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] },
            ];
            await host.fire("session_start", createFakeContext({ ui: replacement, branch: [] }));
            await ask(host, replacement, replacementQuestions, "call-2");
            assert.equal(replacement.customCalls.length, 1, "the replacement session owns its own panel");

            // A disposed overlay can still resolve late: it must neither continue into the new
            // session's queue nor release the ownership of the panel that is up.
            ui.customCalls[0]!.close("settled");
            await drain();

            assert.equal(ui.customCalls.length, 1, "the stale loop must not open another panel");
            assert.equal(replacement.customCalls.length, 1, "the live panel is still owned");

            await ask(host, ui, QUESTIONS, "call-3");
            assert.equal(ui.customCalls.length, 1, "a second panel cannot open while one is up");
        });

        it("releases the panel guard for the branch a tree jump lands on", async () => {
            const { host, ui, branch } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            assert.equal(ui.customCalls.length, 1);

            // The overlay never resolves while the branch changes under it.
            await host.fire("session_tree", createFakeContext({ ui, branch }));

            assert.equal(questionManager.getPendingRequests().length, 1, "the branch still holds the request");

            void host.commands.get("question")!.handler("", createFakeContext({ ui, branch }));

            assert.equal(ui.customCalls.length, 2, "/question can open the restored request");
        });

        it("reports a snapshot that could not be written", async () => {
            const { host, ui } = await startSession();

            host.api.appendEntry = () => {
                throw new Error("session is read-only");
            };

            await ask(host, ui, QUESTIONS, "call-1");

            assert.ok(ui.panel, "the question is still askable");
            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be saved/.test(call.message)),
                `expected a snapshot error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
        });

        it("closes the deferred overlay when the snapshot cannot be written", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            host.api.appendEntry = () => {
                throw new Error("session is read-only");
            };

            ui.panel!.handleInput?.("\x1b");
            await drain();

            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be saved/.test(call.message)),
                `expected a snapshot error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
            assert.equal(questionManager.getPendingRequests().length, 1, "the request stays pending");
            assert.equal(ui.customCalls.length, 1, "a defer is quiet");

            // The overlay released its ownership instead of sticking on screen.
            void host.commands.get("question")!.handler("", createFakeContext({ ui, branch: host.branch }));

            assert.equal(ui.customCalls.length, 2, "/question can open the deferred request again");
        });

        it("finishes shutdown when the final snapshot cannot be written", async () => {
            const { host, ui, branch } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            host.api.appendEntry = () => {
                throw new Error("session is read-only");
            };

            await host.fire("session_shutdown", createFakeContext({ ui, branch }));

            assert.equal(questionManager.getPendingRequests().length, 0, "shutdown still clears the state");
            assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined, "and the dock");
            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be saved/.test(call.message)),
                `expected a snapshot error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
        });
    });

    describe("transcript renderer", () => {
        it("renders the answered questions", () => {
            const host = createFakePiHost(luneAskQuestion);
            const renderer = host.messageRenderers.get(ASK_QUESTION_ANSWER_MESSAGE);
            assert.ok(renderer);

            const component = renderer(
                {
                    role: "custom",
                    customType: ASK_QUESTION_ANSWER_MESSAGE,
                    content: "",
                    display: true,
                    timestamp: Date.now(),
                    details: {
                        status: "answered",
                        questions: QUESTIONS,
                        answers: [{ selectedIndexes: [1] }],
                    },
                } as never,
                { expanded: false, outputPad: 0 },
                createFakeTheme(),
            );

            const text = stripTerminalSequences(component!.render(120).join("\n"));
            assert.match(text, /Questions answered/);
            assert.match(text, /Which database\?/);
            assert.equal(text.includes("Q1"), false, "the answer must not invent a question number");
            assert.match(text, /selected: 2\. SQLite/);
        });
    });
});
