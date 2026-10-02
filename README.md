# Lune Ask Question

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Structured questions for [Pi](https://pi.dev): the model asks, the panel opens, and your answer reaches it when you are ready.**

`ask_user_questions` is for the decisions the model should not make on its own. Asking is asynchronous: the question waits in the session while the model keeps working on everything that does not depend on it, and your answer - or a skip - arrives back as a message that resumes it. Read the panel, take your time, and answer when you get to it.

<img src="docs/question-panel.png" alt="The question panel: two question tabs, the focused option's Markdown preview pane, numbered options and the free-form row" width="880">

## Quick start

Install from git:

```bash
pi install git:github.com/Nouvelle-Lune/lune-ask-question
```

## What it does

- **Asks without stopping the turn.** The panel opens over the session the moment a decision is needed, and the model carries on with the parts that do not depend on the answer instead of waiting for you.
- **Brings the answer back into the session.** Answering or skipping adds a `Questions answered` or `Questions skipped` row to the transcript and resumes the model from there.
- **A question waits as long as you need.** `Esc` closes the panel without settling anything: a dock below the editor says a question is still pending, and `/question` reopens it with the focused row and your drafts intact.
- **Survives a restart.** A pending question and what you had written come back after `/reload`, `/resume` or `/tree`.
- **Compares options before answering.** An option can carry a Markdown preview - a diff, a config block, a mockup - in a pane beside the options, side by side on a wide terminal and stacked under them on a narrow one. A preview is only for you: it never becomes the answer.
- **Only as tall as its content.** A short question covers as little of the transcript as possible; a long one scrolls, with the tab strip pinned above the body. While you are writing an answer, the body scrolls with you to keep the whole input box - and its cursor - in view instead of clipping the newest lines.

## Panel

| Key | |
| --- | --- |
| `↑` `↓`, `k` `j` | Move between option rows |
| `Enter` | Confirm the focused row - on a submit row it submits |
| `Space` | Toggle the focused option in a multi-select question |
| `1`–`9` | Pick an option by number |
| `Tab`, `⇧Tab`, `←` `→` | Switch question tabs and the `✓ Submit` tab |
| Any printable key except `⇧S` on `Type something` | Open the answer editor with that key |
| `Enter` in the editor | Submit the written answer |
| `Esc` in the editor | Back to the options, keeping the draft |
| `Esc` | Close the panel and leave the request pending |
| `⇧S` | Skip the whole request; inside the editor `S` is text, so leave it with `Esc` first |

A single-question request submits on the option press. Several questions walk through their tabs and meet on the `✓ Submit` tab, and submitting with a gap jumps to the first unanswered question instead of doing nothing.

Skip is `Shift+S`, so a plain `s` stays available as the first letter of an answer; on a `Type something` row, an answer that starts with a capital `S` starts with `Enter` instead.

In pi's fullscreen mode the panel also takes the mouse:

| Mouse | |
| --- | --- |
| Click a tab | Switch question tabs |
| Click in the editor | Move the cursor |
| Wheel over the preview | Scroll the preview |
| Wheel elsewhere | Scroll the body, including a long question or `displayText` |

Option rows stay keyboard-only - a click neither focuses nor confirms one - and a press that hits no tab or editor is left to pi's text selection, so the panel's text can still be copied. Regular mode keeps the terminal's own mouse handling, and every action above also has a key.

Answers land in the transcript and resume the model:

<img src="docs/question-answer-row.png" alt="The Questions answered row: header, question and the selected option or written answer for each question" width="880">

## Pending questions

`Esc` is a defer, not a dismissal: the panel closes, the request stays pending, and the dock under the editor says which question `/question` would show next.

<img src="docs/question-dock.png" alt="The below-editor dock: 1 pending question, the next question and the /question hint" width="880">

A question that just arrived surfaces immediately, while one you only deferred waits its turn. A request that arrives while a panel is open does not need `/question`: answering the current one hands the panel over to the next.

## Development

```bash
npm install
npm test
npm run typecheck
npm run tui:demo                # real pi TUI, scripted model, one question
LAQ_DEMO=two npm run tui:demo   # queue a second request to watch the handover
LAQ_DEMO=multi npm run tui:demo # one request with three questions, to watch the tabs
npm run docs:images             # regenerate docs/*.svg + docs/*.png (needs rsvg-convert)
```

## License

MIT
