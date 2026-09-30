/**
 * Schema contract of `ask_user_questions`, checked against the validator pi runs before
 * `execute`.
 *
 * The harness in the other suites calls `execute` directly, so a request that pi would have
 * rejected can still "pass" there. This file is what proves the arguments are invocable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateToolArguments, type JsonObject, type Tool } from "@earendil-works/pi-ai";

import luneAskQuestion from "../../src/index.ts";
import { createFakePiHost, requireTool } from "../harness.ts";

const TOOL_NAME = "ask_user_questions";

function toolSchema(): Tool {
    const tool = requireTool(createFakePiHost(luneAskQuestion), TOOL_NAME);

    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Tool["parameters"],
    };
}

/** Validate a question list the way pi validates a tool call before reaching `execute`. */
function validate(questions: unknown): unknown {
    return validateToolArguments(toolSchema(), {
        type: "toolCall",
        id: "call-1",
        name: TOOL_NAME,
        arguments: { questions } as JsonObject,
    });
}

describe("ask_user_questions schema", () => {
    it("accepts a minimal question with a header", () => {
        const args = validate([{ header: "Storage", question: "Which database?" }]) as {
            questions: Array<{ header: string; question: string }>;
        };

        assert.equal(args.questions[0]!.header, "Storage");
        assert.equal(args.questions[0]!.question, "Which database?");
    });

    it("accepts display text, previews, descriptions and multi-select", () => {
        const args = validate([
            {
                header: "Storage",
                question: "Which database?",
                displayText: "The service runs on a single node.",
                multiSelect: true,
                options: [
                    { label: "Postgres", description: "server", preview: "DATABASE_URL=postgres://localhost/app" },
                    { label: "SQLite" },
                ],
            },
        ]) as { questions: Array<{ options: Array<{ label: string }> }> };

        assert.equal(args.questions[0]!.options[1]!.label, "SQLite");
    });

    it("rejects a question without a header", () => {
        assert.throws(() => validate([{ question: "Which database?" }]), /header/);
    });

    it("rejects a header that is too long for a tab", () => {
        assert.throws(() => validate([{ header: "x".repeat(17), question: "Which database?" }]), /header/);
    });

    it("rejects a question without question text", () => {
        assert.throws(() => validate([{ header: "Storage" }]), /question/);
    });

    it("rejects a request without questions or with too many", () => {
        assert.throws(() => validate([]), /questions/);
        assert.throws(
            () => validate(Array.from({ length: 5 }, (_, index) => ({ header: `H${index}`, question: `Q${index}` }))),
            /questions/,
        );
    });

    it("rejects an option list that is not a real choice", () => {
        assert.throws(
            () => validate([{ header: "Storage", question: "Which?", options: [{ label: "Only" }] }]),
            /options/,
        );
        assert.throws(
            () =>
                validate([{
                    header: "Storage",
                    question: "Which?",
                    options: Array.from({ length: 5 }, (_, index) => ({ label: `option ${index}` })),
                }]),
            /options/,
        );
    });
});
