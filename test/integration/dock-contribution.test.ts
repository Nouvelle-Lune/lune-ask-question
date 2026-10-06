import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    getDockRegistry,
} from "lune-dock-protocol/host";

import type { LuneDockProvider } from "lune-dock-protocol";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import luneAskQuestion from "../../src/index.ts";
import {
    QUESTION_STATE_ENTRY,
    questionManager,
    type AskQuestion,
    type AskQuestionRequest,
} from "../../src/core/questionManager.ts";
import { resetQuestionPanelState } from "../../src/tui/panel/question-panel.ts";
import { QUESTION_CONTRIBUTION_ID, createQuestionDockContribution, getQuestionDockSnapshot } from "../../src/tui/question-dock-contribution.ts";
import {
    createFakeContext,
    createFakePiHost,
    createFakeUi,
    type FakeBranchEntry,
    type FakePiHost,
    type FakeUi,
} from "../harness.ts";

const WIDGET_KEY = "lune-ask-question";
const liveSessions: QuestionSession[] = [];
const directContributions: ReturnType<typeof createQuestionDockContribution>[] = [];
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const ENTER = "\r";

interface QuestionSession {
    readonly host: FakePiHost;
    ui: FakeUi;
    ctx: ReturnType<typeof createFakeContext>;
    readonly branch: FakeBranchEntry[];
    closed: boolean;
}

/** Start the actual extension entry point against a fresh or resumed session branch. */
async function startSession(
    branch: FakeBranchEntry[] = [],
    ui = createFakeUi(),
): Promise<QuestionSession> {
    const host = createFakePiHost(luneAskQuestion, { branch });
    const ctx = createFakeContext({ ui, branch });
    await host.fire("session_start", ctx);
    const session = { host, ui, ctx, branch, closed: false };
    liveSessions.push(session);
    return session;
}

/** Resolve the real extension contribution registered for the session's UI object. */
function registeredContribution(ui: object): LuneDockProvider {
    const contribution = getDockRegistry().getContributions(ui)
        .find((item) => item.id === QUESTION_CONTRIBUTION_ID);
    assert.ok(contribution, "the extension entry point must register the question contribution for this UI");
    return contribution.provider;
}

/** Count writes to the plugin's independent widget key. */
function widgetWrites(ui: FakeUi): number {
    return ui.widgetCalls.filter((call) => call.key === WIDGET_KEY).length;
}

/** Feed printable characters through the real question panel input handler. */
function type(panel: NonNullable<FakeUi["panel"]>, text: string): void {
    for (const character of text) panel.handleInput?.(character);
}

/** Read the latest persisted question snapshot from the fake session branch. */
function latestSnapshot(branch: readonly FakeBranchEntry[]): { requests: AskQuestionRequest[] } {
    const entry = [...branch].reverse().find(
        (candidate) => candidate.type === "custom" && candidate.customType === QUESTION_STATE_ENTRY,
    );
    assert.ok(entry && entry.type === "custom", "the extension must persist a question state entry");
    return entry.data as { requests: AskQuestionRequest[] };
}

/** Close the editor first when needed, then defer the current request with Esc. */
async function closeQuestionPanel(ui: FakeUi): Promise<void> {
    assert.ok(ui.panel, "the question panel must be open before closing it");
    ui.panel.handleInput?.(ESCAPE);
    ui.panel.handleInput?.(ESCAPE);
    await ui.panelClosed;
}

describe("question dock contribution", () => {
    beforeEach(() => {
        resetQuestionPanelState();
        questionManager.clearAll();
    });

    afterEach(async () => {
        for (const session of liveSessions.splice(0)) {
            if (!session.closed) {
                await session.host.fire(
                    "session_shutdown",
                    createFakeContext({ ui: session.ui, branch: session.branch }),
                );
                session.closed = true;
            }
        }
        for (const contribution of directContributions.splice(0)) contribution.detach();
        resetQuestionPanelState();
        questionManager.clearAll();
    });

    it("counts pending requests rather than the number of questions inside each request", () => {
        // Contract: one contribution count represents pending requests, even when a request contains several individual questions.
        const contribution = createQuestionDockContribution(() => undefined);
        directContributions.push(contribution);
        contribution.attach(createFakeContext());

        assert.equal(stripTerminalSequences(getQuestionDockSnapshot(createFakeContext()).base.render(100)[0]!), "○ Ask");

        const bundledQuestions: AskQuestion[] = [
            { question: "First choice?", options: [{ label: "A" }] },
            { question: "Second choice?", options: [{ label: "B" }] },
            { question: "Third choice?", options: [{ label: "C" }] },
        ];
        questionManager.create(bundledQuestions);

        assert.equal(stripTerminalSequences(getQuestionDockSnapshot(createFakeContext()).detail!.render(100)[0]!), "● Ask · 1 pending request");

        questionManager.create([{ question: "Another request?" }]);
        assert.equal(stripTerminalSequences(getQuestionDockSnapshot(createFakeContext()).detail!.render(100)[0]!), "● Ask · 2 pending requests");
    });

    it("publishes atomic levels, retains an idle base, and stays single-line at narrow widths", async () => {
        const session = await startSession();
        const mounted = getDockRegistry().getContributions(session.ui)[0]!;
        const idle = mounted.snapshot;
        questionManager.create([{ header: "API design", question: "Which API?" }]);
        assert.notStrictEqual(mounted.snapshot, idle);
        assert.equal(stripTerminalSequences(idle.base.render(80)[0]!), "○ Ask");
        assert.match(stripTerminalSequences(mounted.snapshot.full!.render(200)[0]!), /1 pending request · API design/);
        for (const level of [mounted.snapshot.base, mounted.snapshot.detail!, mounted.snapshot.full!]) {
            for (const width of [0, 1, 8, 30, 120]) {
                const lines = level.render(width);
                assert.equal(lines.length, 1);
                assert.ok(visibleWidth(lines[0]!) <= width);
            }
        }
        questionManager.clearAll();
        assert.equal(getDockRegistry().getContributions(session.ui).length, 1);
        assert.equal(stripTerminalSequences(mounted.snapshot.detail!.render(80)[0]!), "○ Ask · idle");
    });

    it("uses host presence only in the matching UI scope and restores its widget when the host detaches", async () => {
        // Contract: an unrelated UI host cannot claim this request, while a matching host hides and later restores the standalone widget.
        const session = await startSession();
        const otherUi = createFakeUi();
        let otherInvalidations = 0;
        const releaseOtherHost = getDockRegistry().attachHost(otherUi, {
            invalidate: () => otherInvalidations++,
        });
        const invalidationsAfterAttach = otherInvalidations;
        questionManager.create([{ question: "Which database?" }]);

        assert.ok(session.ui.mountedWidget("belowEditor", WIDGET_KEY), "the fallback remains visible without a same-scope host");
        assert.equal(otherInvalidations, invalidationsAfterAttach, "another UI receives no contribution invalidation");
        assert.equal(getDockRegistry().getContributions(otherUi).length, 0);
        assert.equal(getDockRegistry().getContributions(session.ui).length, 1);

        let hostInvalidations = 0;
        const releaseHost = getDockRegistry().attachHost(session.ui, {
            invalidate: () => hostInvalidations++,
        });
        assert.equal(session.ui.mountedWidget("belowEditor", WIDGET_KEY), undefined, "the host takes over the standalone widget");
        assert.ok(hostInvalidations > 0, "the host receives the existing question state");

        releaseHost();
        assert.ok(session.ui.mountedWidget("belowEditor", WIDGET_KEY), "detaching the host restores the pending question widget");
        releaseOtherHost();
    });

    it("opens the same pending request from the slash command and dock while persisting an unfinished draft", async () => {
        // Contract: both entry points open the pending-question panel, and Esc persists unfinished text so it survives a resumed session.
        const session = await startSession();
        const request = questionManager.create([{
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
        }]);
        const command = session.host.commands.get("question");
        assert.ok(command, "the /question command must be registered");

        const commandOpening = command.handler("", session.ctx) as Promise<void>;
        assert.ok(session.ui.panel, "the command must open the question panel");
        session.ui.panel.handleInput?.(UP);
        session.ui.panel.handleInput?.(ENTER);
        type(session.ui.panel, "half typed");
        await closeQuestionPanel(session.ui);
        await commandOpening;

        assert.equal(request.draft.customDrafts[0], "half typed");
        assert.deepEqual(latestSnapshot(session.branch).requests.find((saved) => saved.id === request.id)?.draft.customDrafts, ["half typed"]);
        const firstUi = session.ui;
        await session.host.fire("session_shutdown", session.ctx);
        session.closed = true;

        const resumed = await startSession(session.branch);
        const restored = questionManager.getPendingRequests().find((pending) => pending.id === request.id);
        assert.equal(restored?.draft.customDrafts[0], "half typed", "the draft is restored from the saved session branch");

        const openingFromDock = registeredContribution(resumed.ui).activate();
        assert.ok(resumed.ui.panel, "Enter on the question dock contribution opens the same panel");
        resumed.ui.panel.handleInput?.(ENTER);
        assert.match(
            resumed.ui.panel.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"),
            /half typed/,
            "the dock-opened panel restores the saved draft into the editor",
        );
        await closeQuestionPanel(resumed.ui);
        await openingFromDock;

        assert.equal(widgetWrites(firstUi) > 0, true, "the command session rendered its fallback widget before opening");
        assert.equal(resumed.ui.customCalls.length, 1, "the dock opened exactly one panel");
    });

    it("releases registrations and manager subscriptions across repeated starts, reload, and shutdown", async () => {
        // Contract: a replacement session owns one registration and listener, while retired contexts stop receiving widget or persistence writes.
        const first = await startSession();
        questionManager.create([{ question: "First session?" }]);
        const firstUi = first.ui;
        const firstUiWritesAtRestart = widgetWrites(firstUi);
        const secondUi = createFakeUi();
        const secondCtx = createFakeContext({ ui: secondUi, branch: first.branch });

        await first.host.fire("session_start", secondCtx);
        first.ui = secondUi;
        first.ctx = secondCtx;
        assert.equal(getDockRegistry().getContributions(firstUi).length, 0, "the previous UI registration is removed");
        assert.equal(getDockRegistry().getContributions(secondUi).length, 1, "the new session registers one contribution");
        const oldPersistCount = first.host.appendEntryCalls.length;

        questionManager.create([{ question: "Second session?" }]);
        assert.equal(widgetWrites(firstUi), firstUiWritesAtRestart, "the retired UI receives no later question state updates");
        assert.equal(first.host.appendEntryCalls.length, oldPersistCount + 1, "the active session persists the new request once");
        assert.ok(widgetWrites(secondUi) > 0, "the replacement UI receives the pending request");

        await first.host.fire("session_shutdown", secondCtx);
        first.closed = true;
        assert.equal(getDockRegistry().getContributions(secondUi).length, 0, "shutdown releases the current contribution");
        const oldPersistCountAfterShutdown = first.host.appendEntryCalls.length;

        const reloaded = await startSession(first.branch, secondUi);
        assert.equal(getDockRegistry().getContributions(secondUi).length, 1, "a reloaded extension installs one new contribution");
        const writesBeforeReloadRequest = widgetWrites(secondUi);
        const oldWritesBeforeReloadRequest = first.host.appendEntryCalls.length;

        questionManager.create([{ question: "Reloaded session?" }]);
        assert.equal(widgetWrites(secondUi), writesBeforeReloadRequest + 1, "one active listener renders the new request once");
        assert.equal(reloaded.host.appendEntryCalls.length, 1, "the reloaded host persists the request once");
        assert.equal(first.host.appendEntryCalls.length, oldWritesBeforeReloadRequest, "the old extension does not keep writing after reload");
        assert.equal(oldPersistCountAfterShutdown, oldWritesBeforeReloadRequest);

        await reloaded.host.fire("session_shutdown", reloaded.ctx);
        reloaded.closed = true;
    });
});
