/**
 * Integration contract of the extension entry point.
 *
 * These tests drive the real `src/index.ts` through a fake pi host: the tool creates a
 * request, the panel opens through `ctx.ui.custom`, the answers travel back as a
 * `sendMessage` follow-up, and the session lifecycle persists and restores pending
 * questions. The panel's own key handling is covered by `test/unit/question-panel.test.ts`;
 * here it is only driven far enough to settle a request.
 *
 * The host is this repo's fake, not a Pi `AgentSession`, so what is pinned here is the
 * extension's contract with the host API it calls. `npm run tui:demo` is the only check that
 * runs the extension inside a real pi process.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { stripTerminalSequences } from "@earendil-works/pi-tui";

import luneAskQuestion from "../../src/index.ts";
import {
    QUESTION_STATE_ENTRY,
    questionManager,
    type AskQuestion,
    type AskQuestionAnswer,
} from "../../src/core/questionManager.ts";
import { ASK_QUESTION_ANSWER_MESSAGE } from "../../src/core/question-notification.ts";
import { resetQuestionPanelState } from "../../src/tui/panel/question-panel.ts";
import {
    createFakeContext,
    createFakePiHost,
    createFakeTheme,
    createFakeUi,
    requireTool,
    type FakeBranchEntry,
    type FakeCommittedMessageEntry,
    type FakePiHost,
    type FakeUi,
    type SendMessageCall,
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

/** Sessions started by the current test, so their listeners cannot outlive it. */
const liveSessions: Session[] = [];

/** Register the extension and start a session over `branch`, defaulting to a fresh one. */
async function startSession(branch: FakeBranchEntry[] = []): Promise<Session> {
    const host = createFakePiHost(luneAskQuestion, { branch });
    const ui = createFakeUi();
    const ctx = createFakeContext({ ui, branch });

    await host.fire("session_start", ctx);

    const session = { host, ui, branch };
    liveSessions.push(session);

    return session;
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

/** The request a recorded delivery attempt carries; the id is the delivery correlation key. */
function attemptedRequestId(call: SendMessageCall): string | undefined {
    const details = call.message.details as { requestId?: unknown } | undefined;

    return typeof details?.requestId === "string" ? details.requestId : undefined;
}

/** Delivery attempts recorded for one request. */
function deliveryAttempts(host: FakePiHost, requestId: string): SendMessageCall[] {
    return host.sendMessageCalls.filter((call) => attemptedRequestId(call) === requestId);
}

/** Commit the attempt for `requestId` into the fake session, as pi does once it accepts it. */
function commitAnswer(host: FakePiHost, requestId: string): void {
    const index = host.sendMessageCalls.findIndex((call) => attemptedRequestId(call) === requestId);

    assert.notEqual(index, -1, `expected a delivery attempt for ${requestId}`);
    host.commitSendMessage(index);
}

/** Answer messages the session branch holds for one request, matched by its stable identity. */
function committedAnswers(entries: readonly FakeBranchEntry[], requestId: string): FakeCommittedMessageEntry[] {
    return entries.filter(
        (entry): entry is FakeCommittedMessageEntry =>
            entry.type === "custom_message"
            && entry.customType === ASK_QUESTION_ANSWER_MESSAGE
            && (entry.details as { requestId?: unknown } | undefined)?.requestId === requestId,
    );
}

/** Shut a session down and start a new one over the same branch, as quitting and resuming pi does. */
async function restart(session: Session): Promise<Session> {
    await session.host.fire(
        "session_shutdown",
        createFakeContext({ ui: session.ui, branch: session.host.branch }),
    );

    return startSession(session.host.branch);
}

/** Move the fake session to another branch, as pi does on a tree jump. */
async function switchBranch(session: Session, next: FakeBranchEntry[]): Promise<void> {
    const previous = session.host.branch;

    await session.host.fire("session_before_tree", createFakeContext({ ui: session.ui, branch: previous }));
    session.host.activateBranch(next);
    await session.host.fire("session_tree", createFakeContext({ ui: session.ui, branch: next }));
}

/** Answers the plugin still keeps durably for `requestId`, if any. */
function durableAnswers(entries: readonly FakeBranchEntry[], requestId: string): AskQuestionAnswer[] | undefined {
    // Only the newest entry of each kind counts, matching how the plugin restores state: an
    // older snapshot still holding the answer must not mask a newer one that dropped it.
    const newestByType = new Map<string, unknown>();

    for (const entry of entries) {
        if (entry.type === "custom") {
            newestByType.set(entry.customType, entry.data);
        }
    }

    for (const data of newestByType.values()) {
        const answers = findAnswers(data, requestId);

        if (answers) {
            return answers;
        }
    }

    return undefined;
}

/**
 * Find settled answers for `requestId` in one durable value.
 *
 * The shape is deliberately open: a snapshot entry, an outbox record, a collection keyed by
 * request id or an answered-request array all qualify. A draft must not: an answer is only
 * durable when the settled payload carries it, not while the user is still editing.
 */
function findAnswers(value: unknown, requestId: string): AskQuestionAnswer[] | undefined {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findAnswers(item, requestId);

            if (found) {
                return found;
            }
        }

        return undefined;
    }

    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const record = value as Record<string, unknown>;

    if (record.id === requestId || record.requestId === requestId) {
        const answers = settledAnswers(record);

        if (answers) {
            return answers;
        }
    }

    const keyed = record[requestId];

    if (keyed !== null && typeof keyed === "object") {
        const answers = settledAnswers(keyed as Record<string, unknown>);

        if (answers) {
            return answers;
        }
    }

    for (const child of Object.values(record)) {
        const found = findAnswers(child, requestId);

        if (found) {
            return found;
        }
    }

    return undefined;
}

/** The settled answers of one record, if it carries any; a pending record's draft does not count. */
function settledAnswers(record: Record<string, unknown>): AskQuestionAnswer[] | undefined {
    if (record.status === "pending" || !Array.isArray(record.answers)) {
        return undefined;
    }

    return record.answers as AskQuestionAnswer[];
}

describe("lune-ask-question extension", () => {
    beforeEach(() => {
        resetQuestionPanelState();
        questionManager.clearAll();
    });

    afterEach(async () => {
        // The manager and the dock are module singletons, so a listener left subscribed after
        // its test would fire into a finished test's fake ui on every later manager event.
        for (const session of liveSessions.splice(0)) {
            await session.host.fire(
                "session_shutdown",
                createFakeContext({ ui: session.ui, branch: session.branch }),
            );
        }
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
            const first = persisted[0]!.data as { requests: unknown[]; outbox: unknown[] };

            assert.equal(persisted.length, 2, "creating and showing the request each write a snapshot");
            assert.equal(first.requests.length, 1, "the request is in a snapshot before it is shown");
            assert.deepEqual(first.outbox, [], "and nothing is waiting for delivery yet");
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
        it("attempts delivery of the answers as a follow-up message that steers the model", async () => {
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

        it("attempts delivery of a skip as a follow-up message", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);
            ui.panel!.handleInput?.("S");

            assert.equal(host.sendMessageCalls.length, 1);
            assert.match(String(host.sendMessageCalls[0]!.message.content), /skipped these questions/);
        });

        it("attempts delivery of a settled answer exactly once", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            // A second settle attempt (a key landing while the panel closes) must not deliver again.
            ui.panel!.handleInput?.(ENTER);
            ui.panel!.handleInput?.("S");

            assert.equal(host.sendMessageCalls.length, 1);
            assert.equal((host.sendMessageCalls[0]!.message.details as { status: string }).status, "answered");
        });

        it("attempts to deliver a settled answer, and reports a delivery that throws", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");

            // pi rejects the call (for example while it is switching sessions): the answer must
            // still be settled, and the user must learn it never arrived. That the answer also
            // stays durable until a confirmed delivery is covered by `durable answer delivery`.
            host.api.sendMessage = () => {
                throw new Error("session not owned");
            };

            ui.panel!.handleInput?.(ENTER);
            await ui.panelClosed;

            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be delivered/.test(call.message)),
                `expected a delivery error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
        });

        it("keeps the answered request out of the pending queue", async () => {
            const { host, ui } = await startSession();
            const tool = requireTool(host, "ask_user_questions");
            const ctx = createFakeContext({ ui, branch: host.branch });

            await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, ctx);
            answerFocusedOption(ui);

            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.equal(questionManager.nextPendingRequest(), undefined);
        });
    });

    /**
     * Durable answer delivery contract.
     *
     * Three facts have to stay distinct:
     *
     * 1. pending - the user has not answered; the request belongs to the panel, `/question`,
     *    the pending dock and `nextPendingRequest()`.
     * 2. answered but undelivered - the user answered; the settled payload (requestId,
     *    questions, answers) stays recoverable from durable plugin state after `sendMessage`
     *    was only attempted, because a call is not a delivery.
     * 3. delivered - a `custom_message` entry with `customType === ASK_QUESTION_ANSWER_MESSAGE`
     *    and `details.requestId === request.id` is in the session branch; only then may the
     *    durable answer copy be released.
     *
     * The fake host keeps `sendMessageCalls` (attempts) and `committedMessages` (session
     * content) separate; a test acknowledges a delivery by committing one of its attempts.
     * Reconciliation is triggered through the lifecycle events that re-read the branch today,
     * `session_start` and `session_tree`: a committed message must release the durable answer
     * and never be delivered twice, an uncommitted one must be retried after a restore, and
     * the retry has to be matched by requestId rather than message order or recency.
     */
    describe("durable answer delivery", () => {
        const SECOND: AskQuestion[] = [
            { header: "Port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] },
        ];

        it("keeps an answered request durable until delivery is acknowledged", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;

            const sendMessage = host.api.sendMessage;
            let durableAtAttempt: AskQuestionAnswer[] | undefined;

            // Capture durability at the moment the plugin reaches for pi: the write has to
            // happen before the attempt, not after the answer is handed over.
            host.api.sendMessage = (message, options) => {
                durableAtAttempt = durableAnswers(host.branch, requestId);
                sendMessage(message, options);
            };

            answerFocusedOption(ui);

            assert.deepEqual(durableAtAttempt, [{ selectedIndexes: [0] }], "the answer is durable before the attempt");
            assert.deepEqual(
                durableAnswers(host.branch, requestId),
                [{ selectedIndexes: [0] }],
                "and it stays durable while the delivery is unacknowledged",
            );
            assert.equal(questionManager.getPendingRequests().length, 0, "the request is settled, not pending");
        });

        it("does not treat a sendMessage call as a delivery acknowledgement", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(ui);

            assert.equal(deliveryAttempts(host, requestId).length, 1, "the extension asked pi to deliver");
            assert.equal(host.committedMessages.length, 0, "but pi never accepted the message");
            assert.deepEqual(
                durableAnswers(host.branch, requestId),
                [{ selectedIndexes: [0] }],
                "so the answer is not the plugin's to drop yet",
            );
        });

        it("releases the durable answer only after the matching message is committed", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(ui);

            assert.deepEqual(
                durableAnswers(host.branch, requestId),
                [{ selectedIndexes: [0] }],
                "held while the attempt is unacknowledged",
            );
            assert.equal(host.committedMessages.length, 0);

            commitAnswer(host, requestId);

            // The branch now carries the message; re-reading it must mark the answer delivered.
            await host.fire("session_tree", createFakeContext({ ui, branch: host.branch }));

            assert.equal(durableAnswers(host.branch, requestId), undefined, "the acknowledged answer may be released");
            assert.equal(deliveryAttempts(host, requestId).length, 1, "and is not sent a second time");
            assert.equal(questionManager.getPendingRequests().length, 0, "delivered is not pending");
        });

        it("restores an answered-but-undelivered request without reopening the question", async () => {
            const branch: FakeBranchEntry[] = [];
            const first = await startSession(branch);

            await ask(first.host, first.ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(first.ui);

            const second = await restart(first);

            assert.deepEqual(durableAnswers(branch, requestId), [{ selectedIndexes: [0] }], "the answers survived");
            assert.equal(questionManager.getPendingRequests().length, 0, "the user is not asked again");
            assert.equal(questionManager.nextPendingRequest(), undefined);
            assert.equal(second.ui.mountedWidget("belowEditor", WIDGET_KEY), undefined, "the dock stays quiet");

            await second.host.commands.get("question")!.handler(
                "",
                createFakeContext({ ui: second.ui, branch }),
            );

            assert.deepEqual(second.ui.notifyCalls, [{ message: "No pending questions", type: "info" }]);
            assert.equal(second.ui.customCalls.length, 0, "and no panel reopens");
        });

        it("retries an unacknowledged answer after a restore", async () => {
            const branch: FakeBranchEntry[] = [];
            const first = await startSession(branch);

            await ask(first.host, first.ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(first.ui);

            assert.equal(deliveryAttempts(first.host, requestId).length, 1, "the first attempt is made");
            assert.equal(first.host.committedMessages.length, 0, "and never accepted");

            const second = await restart(first);
            const retries = deliveryAttempts(second.host, requestId);

            assert.equal(retries.length, 1, "restoring a durable answer with no committed message retries it");
            assert.equal(retries[0]!.message.customType, ASK_QUESTION_ANSWER_MESSAGE, "as the same kind of message");
            assert.deepEqual(
                (retries[0]!.message.details as { answers: unknown }).answers,
                [{ selectedIndexes: [0] }],
                "with the same answers under the same requestId",
            );
            assert.equal(questionManager.getPendingRequests().length, 0, "without reopening the question");
        });

        it("keeps a skipped request durable and retries it after a restore", async () => {
            const branch: FakeBranchEntry[] = [];
            const first = await startSession(branch);

            await ask(first.host, first.ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            first.ui.panel!.handleInput?.("S");

            assert.equal(deliveryAttempts(first.host, requestId).length, 1, "the skip is attempted");
            assert.equal(questionManager.getPendingRequests().length, 0, "the skip is settled, not pending");

            const second = await restart(first);
            const retries = deliveryAttempts(second.host, requestId);

            assert.equal(retries.length, 1, "a skip takes the same durable path as an answer");
            assert.equal((retries[0]!.message.details as { status: unknown }).status, "skipped");
            assert.match(String(retries[0]!.message.content), /skipped these questions/);
            assert.equal(questionManager.getPendingRequests().length, 0, "without reopening the question");
        });

        it("does not redeliver an answer already committed to the session", async () => {
            const branch: FakeBranchEntry[] = [];
            const first = await startSession(branch);

            await ask(first.host, first.ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(first.ui);

            assert.deepEqual(
                durableAnswers(branch, requestId),
                [{ selectedIndexes: [0] }],
                "the answer is durable before the ack",
            );
            commitAnswer(first.host, requestId);

            const second = await restart(first);

            assert.equal(deliveryAttempts(second.host, requestId).length, 0, "the committed answer is not sent again");
            assert.equal(durableAnswers(branch, requestId), undefined, "and its durable copy is released");
            assert.equal(questionManager.getPendingRequests().length, 0, "a delivered answer is not a pending question");

            // Reconciliation is idempotent: a second pass must not produce another message either.
            await second.host.fire("session_tree", createFakeContext({ ui: second.ui, branch }));

            assert.equal(deliveryAttempts(second.host, requestId).length, 0);
            assert.equal(committedAnswers(branch, requestId).length, 1, "the session holds exactly one answer message");
        });

        it("matches the acknowledgement by requestId instead of message order", async () => {
            const branch: FakeBranchEntry[] = [];
            const first = await startSession(branch);

            await ask(first.host, first.ui, QUESTIONS, "call-1");
            await ask(first.host, first.ui, SECOND, "call-2");

            answerFocusedOption(first.ui);
            const firstId = attemptedRequestId(first.host.sendMessageCalls[0]!)!;
            assert.ok(await waitUntil(() => first.ui.customCalls.length === 2), "the second request surfaces to be answered");
            answerFocusedOption(first.ui);
            const secondId = attemptedRequestId(first.host.sendMessageCalls[1]!)!;
            assert.notEqual(firstId, secondId);

            // Only the later message reached the session; the earlier one did not.
            commitAnswer(first.host, secondId);

            const second = await restart(first);

            assert.equal(deliveryAttempts(second.host, secondId).length, 0, "the committed answer is not retried");
            assert.equal(deliveryAttempts(second.host, firstId).length, 1, "the uncommitted one is");
            assert.deepEqual(durableAnswers(branch, firstId), [{ selectedIndexes: [0] }], "the uncommitted answer stays durable");
            assert.equal(durableAnswers(branch, secondId), undefined, "the committed answer is released");
        });

        it("keeps an answer durable when the delivery attempt throws", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;

            host.api.sendMessage = () => {
                throw new Error("session not owned");
            };

            answerFocusedOption(ui);
            await ui.panelClosed;

            assert.equal(questionManager.getPendingRequests().length, 0, "the answer is settled");
            assert.deepEqual(
                durableAnswers(host.branch, requestId),
                [{ selectedIndexes: [0] }],
                "and stays durable so a retry can still deliver it",
            );
            assert.ok(
                ui.notifyCalls.some((call) => call.type === "error" && /could not be delivered/.test(call.message)),
                `expected a delivery error notice, got ${JSON.stringify(ui.notifyCalls)}`,
            );
        });

        it("keeps an answered-but-undelivered request out of the panel and the dock", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(ui);

            assert.deepEqual(durableAnswers(host.branch, requestId), [{ selectedIndexes: [0] }], "the answer is undelivered");
            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.equal(questionManager.nextPendingRequest(), undefined);
            assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined, "the dock does not offer it");

            await host.commands.get("question")!.handler("", createFakeContext({ ui, branch: host.branch }));

            assert.deepEqual(ui.notifyCalls.at(-1), { message: "No pending questions", type: "info" });
            assert.equal(ui.customCalls.length, 1, "the panel that was answered is the only one that opened");
        });

        it("keeps delivery state isolated across a branch restore", async () => {
            const branchA: FakeBranchEntry[] = [];
            const branchB: FakeBranchEntry[] = [];
            const session = await startSession(branchA);

            await ask(session.host, session.ui, QUESTIONS, "call-1");
            const requestId = questionManager.getPendingRequests()[0]!.id;
            answerFocusedOption(session.ui);

            assert.deepEqual(durableAnswers(branchA, requestId), [{ selectedIndexes: [0] }], "branch A holds the undelivered answer");
            assert.equal(deliveryAttempts(session.host, requestId).length, 1);

            await switchBranch(session, branchB);

            assert.equal(deliveryAttempts(session.host, requestId).length, 1, "branch B must not deliver A's answer");
            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.deepEqual(durableAnswers(branchA, requestId), [{ selectedIndexes: [0] }], "and must not clear it from A");

            await switchBranch(session, branchA);

            assert.deepEqual(durableAnswers(branchA, requestId), [{ selectedIndexes: [0] }], "A still holds its answer");
            assert.equal(deliveryAttempts(session.host, requestId).length, 2, "and retries it on return");
            assert.equal(questionManager.getPendingRequests().length, 0, "without asking the user again");
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

    describe("session lifecycle (fake host)", () => {
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

        it("starts a replacement session without writing to the replaced context", async () => {
            const { host, ui } = await startSession();

            await ask(host, ui, QUESTIONS, "call-1");
            assert.equal(ui.customCalls.length, 1);

            const writesToFirst = ui.widgetCalls.length;
            const replacement = createFakeUi();

            // The fake host can deliver a second session_start to the same extension
            // instance, which is what a reload looks like from the module's side.
            await host.fire("session_start", createFakeContext({ ui: replacement, branch: [] }));

            assert.equal(ui.widgetCalls.length, writesToFirst, "the replaced session's ui must not be written to");
            assert.equal(
                replacement.mountedWidget("belowEditor", WIDGET_KEY),
                undefined,
                "and the replacement session's dock is the one that renders",
            );
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
