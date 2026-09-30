/**
 * Launcher for the real-pi-TUI observer of lune-ask-question.
 *
 * Starts the real `pi` binary in interactive mode with the scripted faux model from
 * `scripted-provider.ts` and the extension's `src/index.ts`. The model asks one question with
 * options, so the run shows the overlay opening immediately after the tool call without any
 * `/question` input. Observation only: nothing here asserts, the human watching decides.
 *
 * Usage: npm run tui:demo
 *        npm run tui:demo -- --help
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: npm run tui:demo

Starts the real pi TUI with a scripted faux model and the extension in src/index.ts. The model
calls ask_user_questions once, so the question overlay opens as soon as the tool call arrives.

What to watch for:
1. the panel appears immediately, above the transcript, with the question, the Markdown display
   text, the two options and the "Type something" row;
2. the focused option's "preview" renders as Markdown in a box beside the options (stacked under
   them on a narrow terminal), and pressing up/down swaps it - including on a multi-select
   question and after the model has finished its turn;
3. Enter on an option submits the single-question request and a follow-up "Questions answered"
   row appears while the model answers "questions settled";
4. with the panel open instead: Esc closes it and leaves "1 pending question · ... ·
   /question to answer" below the editor, /question reopens it with the same focus and draft,
   and Shift+S skips the whole request - the model then reports it was skipped.

pi loads the extensions and stays interactive; quit it with Ctrl+D, Ctrl+C or /quit.

Run LAQ_DEMO=two npm run tui:demo to queue a second request while the first panel is open:
answering the first question must bring the second panel up by itself, without /question.
Run LAQ_DEMO=multi npm run tui:demo for one request with three questions, to watch the tabs.
`;

/** Absolute path of a file named relative to this launcher, for pi's `-e` flag. */
function repoFile(relativePath: string): string {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

function main(): void {
    const argv = process.argv.slice(2);

    if (argv[0] === "--help" || argv[0] === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    const args = [
        "--no-extensions",
        "-e",
        repoFile("./scripted-provider.ts"),
        "-e",
        repoFile("../../src/index.ts"),
        "--provider",
        "faux",
        "--model",
        "faux-1",
        "--no-session",
        "-nc",
        "-np",
        "-ns",
        "--offline",
        "run the lune-ask-question fixture",
    ];

    const child = spawn("pi", args, { stdio: "inherit" });

    child.on("error", (error) => {
        process.stderr.write(`tui:demo could not start pi: ${error.message}\n`);
        process.exitCode = 1;
    });

    child.on("exit", (code, signal) => {
        if (code !== null) {
            process.exitCode = code;
            return;
        }

        // Killed by a signal (for example the pty harness hitting its timeout): there is no exit
        // code to forward, so report the failure instead of looking successful.
        process.stderr.write(`tui:demo: pi was terminated by signal ${signal ?? "unknown"}\n`);
        process.exitCode = 1;
    });
}

try {
    main();
} catch (error) {
    process.stderr.write(`tui:demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
