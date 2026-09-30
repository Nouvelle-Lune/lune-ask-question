/**
 * Scripted (faux) model for the real-TUI observer of lune-ask-question.
 *
 * Loaded as `pi -e test/tui/scripted-provider.ts -e src/index.ts`, it queues two responses:
 * one `ask_user_questions` call and one closing line. Nothing below the model is mocked - the
 * tool runs for real, opens the overlay through `ctx.ui.custom`, and the user's answer (or `S`)
 * comes back as the extension's follow-up message, which is what produces the second turn.
 *
 * With `LAQ_DEMO=two` the first response carries two tool calls instead, so a second request is
 * already pending while the first panel is open; answering the first one shows whether the panel
 * hands over to it on its own. `LAQ_DEMO=multi` asks four questions in one request instead, one
 * of them with a body taller than the old fixed height cap, to watch the tab strip, the submit
 * tab and the content-sized panel.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Questions the scripted model asks; the panel controls are what this run observes. */
const QUESTIONS = [
    {
        header: "Storage",
        question: "Which database should the service use?",
        displayText: "Pick the **storage engine** for the new service.",
        options: [
            {
                label: "Postgres",
                description: "Managed server with JSONB support",
                preview: [
                    "- JSONB indexes",
                    "- `LISTEN` / `NOTIFY`",
                    "",
                    "```bash",
                    "DATABASE_URL=postgres://localhost/app",
                    "```",
                ].join("\n"),
            },
            {
                label: "SQLite",
                description: "Single file next to the app",
                preview: [
                    "- no server to run",
                    "- one writer at a time",
                    "",
                    "```bash",
                    "DATABASE_PATH=./app.db",
                    "```",
                ].join("\n"),
            },
        ],
    },
];

const FINAL_TEXT = "questions settled";

/** Question set for `LAQ_DEMO=multi`: one panel with three questions, so the tabs show. */
type DemoQuestion = {
    header: string;
    question: string;
    displayText?: string;
    multiSelect?: boolean;
    options?: { label: string; description?: string; preview?: string }[];
};

const MULTI_QUESTIONS: DemoQuestion[] = [
    {
        header: "Storage",
        question: "Which database should the service use?",
        // Long on purpose: with the body taller than the old fixed cap this is what shows
        // whether the panel renders the whole request instead of clipping it.
        displayText: [
            "Pick the **storage engine** for the new service.",
            "",
            "```json",
            "{",
            '  "example": "shown above the options",',
            '  "second": 2,',
            '  "third": 3,',
            '  "fourth": 4',
            "}",
            "```",
        ].join("\n"),
        options: [
            {
                label: "Postgres",
                description: "Managed server with JSONB support",
                preview: [
                    "- JSONB indexes",
                    "- `LISTEN` / `NOTIFY`",
                    "",
                    "```bash",
                    "DATABASE_URL=postgres://localhost/app",
                    "```",
                ].join("\n"),
            },
            {
                label: "SQLite",
                description: "Single file next to the app",
                preview: [
                    "- no server to run",
                    "- one writer at a time",
                    "",
                    "```bash",
                    "DATABASE_PATH=./app.db",
                    "```",
                ].join("\n"),
            },
        ],
    },
    {
        header: "Auth",
        question: "How should users sign in?",
        multiSelect: true,
        options: [
            { label: "Email link", description: "No password to store" },
            { label: "OAuth", description: "Delegate to a provider" },
            { label: "Passkeys", description: "Nothing to remember" },
        ],
    },
    {
        header: "Port",
        question: "Which port should the service listen on?",
    },
    {
        header: "Notes",
        question: "Anything else worth knowing before this ships?",
    },
];

/** Second request for `LAQ_DEMO=two`: it is pending while the first panel is still open. */
const SECOND_QUESTIONS = [
    {
        header: "Port",
        question: "Which port should the service listen on?",
        options: [
            { label: "8080", description: "Common alternative to 80" },
            { label: "9090", description: "Often used by proxies" },
        ],
    },
];

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const toolCalls = process.env.LAQ_DEMO === "two"
        ? [
            fauxToolCall("ask_user_questions", { questions: QUESTIONS }),
            fauxToolCall("ask_user_questions", { questions: SECOND_QUESTIONS }),
        ]
        : process.env.LAQ_DEMO === "multi"
            ? [fauxToolCall("ask_user_questions", { questions: MULTI_QUESTIONS })]
            : [fauxToolCall("ask_user_questions", { questions: QUESTIONS })];

    faux.setResponses([
        fauxAssistantMessage(toolCalls, { stopReason: "toolUse" }),
        fauxAssistantMessage(FINAL_TEXT),
    ]);
}
