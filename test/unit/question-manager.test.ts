import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
    QUESTION_STATE_ENTRY,
    QuestionManager,
    questionManager,
    type AskQuestion,
    type QuestionManagerEvent,
} from "../../src/core/questionManager.ts";
import { createFakeContext, createFakePiHost, type FakeBranchEntry } from "../harness.ts";

const QUESTIONS: AskQuestion[] = [
    {
        question: "Which database?",
        options: [{ label: "Postgres", description: "server" }, { label: "SQLite" }],
    },
    {
        question: "Anything else?",
    },
];

function newManager(): QuestionManager {
    return new QuestionManager();
}

/** `getBranch` entries carrying one state snapshot, as a resumed session would have. */
function branchWith(snapshot: unknown, customType = QUESTION_STATE_ENTRY): FakeBranchEntry[] {
    return [{ type: "custom", customType, data: snapshot }];
}

describe("question manager", () => {
    beforeEach(() => {
        // Module state is shared inside this test process; the extension tests use the singleton.
        questionManager.clearAll();
    });

    describe("create", () => {
        it("creates a pending request with an empty draft per question", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(request.status, "pending");
            assert.equal(request.questions.length, 2);
            assert.deepEqual(request.draft.answers, [undefined, undefined]);
            assert.deepEqual(request.draft.customDrafts, [undefined, undefined]);
            assert.deepEqual(request.draft.currentIndex, 0);
        });

        it("copies the questions so later mutation cannot change the request", () => {
            const manager = newManager();
            const questions: AskQuestion[] = [{ question: "First", options: [{ label: "A" }, { label: "B" }] }];
            const request = manager.create(questions);

            questions[0]!.question = "changed";
            questions[0]!.options![0]!.label = "changed";

            assert.equal(request.questions[0]!.question, "First");
            assert.equal(request.questions[0]!.options![0]!.label, "A");
        });

        it("lists pending requests oldest first", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create([{ question: "Later" }]);

            // The clock may be too coarse to separate the two timestamps; order comes from
            // the manager walking its map in insertion order plus the sort.
            assert.deepEqual(
                manager.getPendingRequests().map((request) => request.id),
                [first.id, second.id],
            );
        });

        it("emits a created event", () => {
            const manager = newManager();
            const events: QuestionManagerEvent[] = [];
            manager.subscribe((event) => events.push(event));

            const request = manager.create(QUESTIONS);

            assert.deepEqual(events, [{ type: "request-created", id: request.id }]);
        });
    });

    describe("submit and skip", () => {
        it("stores the answers and settles the request once", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(manager.submit(request.id, [{ selectedIndexes: [1] }, { selectedIndexes: [], customText: "yes" }]), true);
            assert.equal(manager.get(request.id)?.status, "answered");
            assert.deepEqual(manager.get(request.id)?.answers, [
                { selectedIndexes: [1] },
                { selectedIndexes: [], customText: "yes" },
            ]);

            // A second settle is a no-op: the answers were already delivered.
            assert.equal(manager.submit(request.id, [{ selectedIndexes: [0] }, { selectedIndexes: [0] }]), false);
            assert.deepEqual(manager.get(request.id)?.answers?.[0], { selectedIndexes: [1] });
            assert.equal(manager.getPendingRequests().length, 0);
        });

        it("skips without answers and refuses a submit afterwards", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(manager.skip(request.id), true);
            assert.equal(manager.get(request.id)?.status, "skipped");
            assert.equal(manager.get(request.id)?.answers, undefined);
            assert.equal(manager.submit(request.id, []), false);
            assert.equal(manager.get(request.id)?.status, "skipped");
        });

        it("emits answered and skipped events", () => {
            const manager = newManager();
            const events: QuestionManagerEvent[] = [];
            manager.subscribe((event) => events.push(event));

            const answered = manager.create([{ question: "First" }]);
            manager.submit(answered.id, [{ selectedIndexes: [0] }]);
            const skipped = manager.create([{ question: "Second" }]);
            manager.skip(skipped.id);

            assert.deepEqual(events, [
                { type: "request-created", id: answered.id },
                { type: "request-answered", id: answered.id },
                { type: "request-created", id: skipped.id },
                { type: "request-skipped", id: skipped.id },
            ]);
        });

        it("returns undefined for a settled request", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            manager.skip(request.id);

            assert.equal(manager.getPendingRequest(request.id), undefined);
        });

        it("ignores unknown ids", () => {
            const manager = newManager();

            assert.equal(manager.submit("missing", []), false);
            assert.equal(manager.skip("missing"), false);
        });
    });

    describe("persistence", () => {
        it("persists only pending requests, at the state entry key", () => {
            const manager = newManager();
            const answered = manager.create([{ question: "Answered" }]);
            const pending = manager.create(QUESTIONS);
            manager.submit(answered.id, [{ selectedIndexes: [0] }]);

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            assert.equal(host.appendEntryCalls.length, 1);
            assert.equal(host.appendEntryCalls[0]!.customType, QUESTION_STATE_ENTRY);

            const snapshot = host.appendEntryCalls[0]!.data as { requests: Array<{ id: string }> };
            assert.deepEqual(snapshot.requests.map((request) => request.id), [pending.id]);
        });

        it("restores a request with its draft from the branch", () => {
            const manager = newManager();
            const original = manager.create(QUESTIONS);
            original.draft.currentIndex = 1;
            original.draft.optionIndex = 2;
            original.draft.answers[0] = { selectedIndexes: [1] };
            original.draft.customDrafts[1] = "half typed";

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch: host.branch }));

            const [restored] = restarted.getPendingRequests();
            assert.ok(restored);
            assert.equal(restored.id, original.id);
            assert.equal(restored.status, "pending");
            assert.equal(restored.draft.currentIndex, 1);
            assert.equal(restored.draft.optionIndex, 2);
            assert.deepEqual(restored.draft.answers[0], { selectedIndexes: [1] });
            assert.equal(restored.draft.customDrafts[1], "half typed");
        });

        it("restores the option payload, previews included", () => {
            const manager = newManager();
            const original = manager.create([
                {
                    question: "Which database?",
                    options: [
                        { label: "Postgres", description: "server", preview: "## JSONB" },
                        { label: "SQLite" },
                    ],
                },
            ]);

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch: host.branch }));

            // The preview pane has to survive a restart with the rest of the question.
            assert.deepEqual(restarted.getPendingRequests()[0]!.questions[0], original.questions[0]);
        });

        it("normalizes a stored draft that does not line up with the questions", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            const branch = branchWith({
                requests: [{
                    ...request,
                    draft: { currentIndex: 99, optionIndex: -3, answers: "broken", customDrafts: null },
                }],
            });

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch }));

            const [restored] = restarted.getPendingRequests();
            assert.ok(restored);
            assert.equal(restored.draft.currentIndex, restored.questions.length);
            assert.equal(restored.draft.optionIndex, 0);
            assert.deepEqual(restored.draft.answers, [undefined, undefined]);
            assert.deepEqual(restored.draft.customDrafts, [undefined, undefined]);
        });

        it("keeps the newest snapshot when the branch holds several", () => {
            const manager = newManager();
            const stale = manager.create([{ question: "Stale" }]);
            const latest = manager.create([{ question: "Latest" }]);

            const branch: FakeBranchEntry[] = [
                { type: "custom", customType: QUESTION_STATE_ENTRY, data: { requests: [stale] } },
                { type: "custom", customType: QUESTION_STATE_ENTRY, data: { requests: [latest] } },
            ];

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch }));

            assert.deepEqual(
                restarted.getPendingRequests().map((request) => request.id),
                [latest.id],
            );
        });

        it("ignores unrelated custom entries and malformed snapshots", () => {
            const manager = newManager();

            manager.restore(createFakeContext({
                branch: [
                    { type: "custom", customType: "something-else", data: { requests: [{ id: "x", questions: [] }] } },
                    { type: "custom", customType: QUESTION_STATE_ENTRY, data: { requests: "broken" } },
                ],
            }));

            assert.deepEqual(manager.getPendingRequests(), []);
        });

        it("does not replace a live request with the same id", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            request.draft.answers[0] = { selectedIndexes: [0] };

            const branch = branchWith({ requests: [{ ...request, draft: { ...request.draft, answers: [undefined, undefined] } }] });

            manager.restore(createFakeContext({ branch }));

            assert.deepEqual(manager.get(request.id)?.draft.answers[0], { selectedIndexes: [0] });
        });

        it("clears every request including settled ones", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            manager.skip(request.id);

            manager.clearAll();

            assert.deepEqual(manager.getPendingRequests(), []);
            assert.equal(manager.get(request.id), undefined);
        });
    });
});
