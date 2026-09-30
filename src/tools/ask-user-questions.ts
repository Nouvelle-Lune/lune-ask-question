import { defineTool } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { formatPendingMessage, summarizeText } from "../core/question-format.ts";
import { questionManager } from "../core/questionManager.ts";
import { openQuestionPanel } from "../tui/question-panel.ts";

import Type from "typebox";

export type AskUserQuestionsDetails =
    | {
        status: "pending";
        requestId: string;
    }
    | {
        status: "unavailable";
    };

/**
 * The tool is asynchronous by design: it returns as soon as the panel is open, the model
 * keeps working on what it is sure about, and the answers arrive as a follow-up message.
 *
 * `persist` writes the pending questions (with drafts) into the session, which is what
 * keeps them answerable after Esc or a restart.
 */
export function askUserQuestions(persist: () => void) {
    return defineTool({
        name: "ask_user_questions",
        label: "Ask User Questions",
        description:
            "Ask the user structured questions when their answer is needed to choose what to do next. Use this for user-owned decisions or meaningful tradeoffs that cannot be resolved from the conversation or workspace. The panel opens immediately and answers arrive later as a follow-up message.",

        promptSnippet:
            "Ask for user-owned decisions; discover facts and use reasonable defaults yourself.",

        promptGuidelines: [
            "Ask only when the answer materially changes what you should do next; inspect the conversation and workspace first, and use reasonable defaults for low-impact choices.",
            "Ask the smallest set of questions needed. After calling the tool, continue independent work and stop only when further progress depends on the answers.",
            "Use option previews for concrete alternatives that benefit from visual comparison - code, configuration, structured text, or UI mockups - and do not add previews to simple preference questions. The pane is titled with the option label, so a preview must not repeat it.",
            "Give every question a short header naming its subject ('Storage', 'Auth', 'Timeouts'); the panel shows it as the tab label. The header is required, so never number questions yourself or repeat the question text.",
        ],
        parameters: askUserQuestionsSchema,
        // The panel is a user interaction, not a nested-tool capability, and shared
        // panel state must not be mutated by parallel calls.
        exposure: "model-only",
        executionMode: "sequential",

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (ctx.mode !== "tui") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: ask_user_questions needs the interactive TUI; ask your questions in plain text in this mode instead.",
                        },
                    ],
                    details: { status: "unavailable" } as AskUserQuestionsDetails,
                    isError: true,
                };
            }

            const request = questionManager.create(params.questions);

            // Not awaited: the tool result is what lets the model keep working while the
            // user reads the panel.
            void openQuestionPanel(ctx, { onDeferred: persist });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: formatPendingMessage(),
                    },
                ],
                details: {
                    status: "pending",
                    requestId: request.id,
                } as AskUserQuestionsDetails,
            };
        },

        renderCall(args, theme, _context) {
            const count = args.questions.length;
            const label = `${count} question${count === 1 ? "" : "s"}`;

            const lines = args.questions.map(
                (question) => theme.fg("text", summarizeText(question.question, 60)),
            );

            return new Text(
                theme.fg("toolTitle", theme.bold("ask_user_questions ")) + theme.fg("muted", label) +
                (lines.length > 0 ? `\n${lines.join("\n")}` : ""),
                0,
                0,
            );
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as AskUserQuestionsDetails | undefined;

            if (details?.status === "unavailable") {
                return new Text(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "unavailable"), 0, 0);
            }

            return new Text(
                theme.fg("warning", "waiting for the user") +
                theme.fg("dim", " · /question to reopen the panel"),
                0,
                0,
            );
        },
    });
}

const askUserQuestionsSchema = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({
                description:
                    "A single-sentence, atomic decision prompt shown to the user. Ask exactly one thing and include enough context to answer without reading surrounding prose.",
            }),

            header: Type.String({
                minLength: 1,
                maxLength: 16,
                description:
                    "Short label naming this question's subject ('Storage', 'Auth', 'Timeouts'), shown as the tab label in the panel. Always provide it, keep it to a word or two, and never number the questions.",
            }),

            displayText: Type.Optional(
                Type.String({
                    description:
                        "Optional context shown before the answer controls when the user needs to inspect something to make the decision, such as a preview, code snippet, rendered text, or concrete example. Do not use this for generic explanation that belongs in the question or option descriptions.",
                }),
            ),

            options: Type.Optional(
                Type.Array(
                    Type.Object({
                        label: Type.String({
                            description:
                                "Short, scannable user-visible choice label, preferably 1-5 words. If an option is clearly preferred, place it first and suffix the label with '(Recommended)'.",
                        }),

                        description: Type.Optional(
                            Type.String({
                                description:
                                    "One short sentence explaining the consequence, tradeoff, or meaning of selecting this option.",
                            }),
                        ),

                        preview: Type.Optional(
                            Type.String({
                                description:
                                    "Optional Markdown preview shown in a pane beside the options while this option is focused. Use it for mockups, code, config snippets, or other concrete comparisons that the label and description cannot convey on their own; keep it to roughly a dozen lines.",
                            }),
                        ),
                    }),
                    {
                        minItems: 2,
                        maxItems: 4,
                        description:
                            "Two to four meaningful, mutually distinct choices. Omit the entire field for genuinely free-form input.",
                    },
                ),
            ),

            multiSelect: Type.Optional(
                Type.Boolean({
                    default: false,
                    description:
                        "Whether multiple predefined options can validly apply at the same time. Keep false for mutually exclusive choices.",
                }),
            ),
        }),
        {
            minItems: 1,
            maxItems: 4,
            description:
                "Questions presented together in one panel. Prefer one question; batch up to four only when the decisions are independent and already known to be necessary.",
        },
    ),
});
