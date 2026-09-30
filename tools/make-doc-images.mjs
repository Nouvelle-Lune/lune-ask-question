/**
 * Render the README screenshots (docs/*.svg + docs/*.png) from the real components.
 *
 * WHY: an image drawn by hand drifts from the UI it documents. Every frame here is produced by
 * the extension's own renderers - the real `QuestionPanel`, the real `QuestionDock` mounted the
 * way pi mounts a below-editor widget, and the real answer-message renderer - so a UI change is
 * regenerated with one command instead of re-photographed.
 *
 * The palette is pi's shipped dark theme, resolved to hex through pi-tui's color parser (theme
 * colors are `okhsl()` strings, which an SVG renderer would otherwise drop) and emitted as
 * truecolor escapes. Markdown inside the panel uses pi's global markdown theme, which emits
 * both truecolor and 256-color escapes, so the SVG writer understands both forms.
 *
 * Needs `rsvg-convert` (librsvg) on PATH for the PNG step.
 *
 * Run with: npm run docs:images
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, colorToHex, parseColor, visibleWidth } from "@earendil-works/pi-tui";

import { questionManager } from "../src/core/questionManager.ts";
import { renderQuestionAnswerMessage } from "../src/tui/question-answer-message.ts";
import { QuestionDock } from "../src/tui/question-dock.ts";
import { QuestionPanel } from "../src/tui/panel/question-panel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const THEME_JSON = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json");

/* ---------------------------------------------------------------- palette */

const themeJson = JSON.parse(readFileSync(THEME_JSON, "utf8"));

/** Resolve a theme color name ("accent") through vars to a hex color. */
function colorHex(name) {
	const value = themeJson.colors[name] ?? themeJson.vars[name] ?? name;
	const resolved = themeJson.vars[value] ?? value;
	const hex = colorToHex(parseColor(resolved));
	if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Unresolved theme color: ${name} -> ${resolved} -> ${hex}`);
	return hex;
}

function hexToRgb(hex) {
	return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

/** Theme object for the extension's components, emitting truecolor escapes from dark.json. */
const theme = {
	fg: (name, text) => `\x1b[38;2;${hexToRgb(colorHex(name)).join(";")}m${text}\x1b[39m`,
	bg: (name, text) => `\x1b[48;2;${hexToRgb(colorHex(name)).join(";")}m${text}\x1b[49m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => `\x1b[3m${text}\x1b[23m`,
	underline: (text) => `\x1b[4m${text}\x1b[24m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
};

// The panel renders markdown through pi's global markdown theme, which the TUI initializes
// before any extension draws.
initTheme("dark", false);
if (typeof getMarkdownTheme !== "function") throw new Error("pi does not expose getMarkdownTheme");

/* ---------------------------------------------------------------- content */

const STORAGE = {
	header: "Storage",
	question: "Where should the new session index live?",
	displayText:
		"The transcript itself stays on disk either way; only the lookup path changes.\n\n" +
		"- `sqlite` adds one file next to the config\n" +
		"- `jsonl` reuses what already ships",
	options: [
		{
			label: "SQLite index (Recommended)",
			description: "One file, constant-time resume, no extra service.",
			preview:
				"```\nsessions/\n  index.sqlite\n  4f2a9c.jsonl\n```\n\n" +
				"- a `WAL` file appears beside it\n" +
				"- survives a crash mid-write",
		},
		{
			label: "Scan every JSONL",
			description: "No new dependency; resume re-reads each session file.",
			preview: "```\nsessions/\n  *.jsonl   ← read all\n```\n\n- O(n) per resume\n- about 40 ms at 1k sessions",
		},
		{
			label: "Rebuild in memory",
			description: "Nothing on disk; the index is rebuilt on every start.",
			preview: "```\nstartup:\n  walk() -> Map\n```\n\n- no files to migrate\n- cold start pays the walk",
		},
	],
};

const TIMEOUTS = {
	header: "Timeouts",
	question: "How should a stalled shell job be reported?",
	options: [
		{ label: "Warn, keep running", description: "The job stays alive and the dock turns yellow." },
		{ label: "Kill after 90s", description: "The process tree is aborted and the agent is told why." },
	],
};

/* ------------------------------------------------------------ rendering */

/** Terminal width pi resolves for an overlay at a given terminal size. */
function overlayWidth(cols) {
	return Math.max(1, Math.min(Math.max(Math.floor((cols * 80) / 100), 70), cols - 4));
}

/**
 * Render one panel frame at a terminal size.
 *
 * `keys` are raw terminal sequences, so the frame goes through the same `handleInput` path a
 * real key press takes.
 */
function panelFrame({ rows, cols, keys = [] }) {
	questionManager.clearAll();
	const request = questionManager.create(structuredClone([STORAGE, TIMEOUTS]));

	const panel = new QuestionPanel({
		request,
		tui: { terminal: { rows, cols }, requestRender: () => {} },
		theme,
		keybindings: { matches: () => false },
		close: () => {},
		onDeferred: () => {},
	});

	for (const key of keys) panel.handleInput(key);

	return panel.render(overlayWidth(cols));
}

/**
 * Render the below-editor dock.
 *
 * The dock only hands lines to `ctx.ui.setWidget`; pi wraps each of them in `new Text(line, 1, 0)`
 * before they reach the layout, so the image uses the same wrapper instead of re-indenting by hand.
 */
function dockFrame(width) {
	questionManager.clearAll();
	questionManager.create([structuredClone(STORAGE)]);

	const dock = new QuestionDock();
	const mounted = [];
	dock.setCtx({
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key, content) => {
				if (content !== undefined) mounted.push(...content);
			},
		},
	});
	dock.render();

	const container = new Container();
	for (const line of mounted) container.addChild(new Text(line, 1, 0));

	return container.render(width);
}

/** Render the transcript row of the follow-up message that carries the answers. */
function answerFrame(width) {
	return renderQuestionAnswerMessage(
		{
			status: "answered",
			questions: [structuredClone(STORAGE), structuredClone(TIMEOUTS)],
			answers: [
				{ selectedIndexes: [0] },
				{ selectedIndexes: [], customText: "Warn at 60s, kill at 90s" },
			],
		},
		theme,
	).render(width);
}

/* ------------------------------------------------------------------- SVG */

const XTERM = [
	["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"],
	["#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"],
];

/** Standard xterm 256-color palette, used for escapes pi's markdown theme emits. */
function color256(index) {
	if (index < 8) return XTERM[0][index];
	if (index < 16) return XTERM[1][index - 8];
	if (index < 232) {
		const n = index - 16;
		const level = (v) => (v === 0 ? 0 : 55 + v * 40);
		return `#${[Math.floor(n / 36), Math.floor((n % 36) / 6), n % 6].map((v) => level(v).toString(16).padStart(2, "0")).join("")}`;
	}
	const gray = 8 + (index - 232) * 10;
	return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
}

const ESCAPE = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Split styled terminal text into runs of {text, fg, bg, bold, italic, underline}. */
function runs(line) {
	const out = [];
	let fg = null;
	let bg = null;
	let bold = false;
	let italic = false;
	let underline = false;
	let last = 0;
	const push = (text) => {
		if (text !== "") out.push({ text, fg, bg, bold, italic, underline });
	};
	ESCAPE.lastIndex = 0;
	for (let match = ESCAPE.exec(line); match !== null; match = ESCAPE.exec(line)) {
		push(line.slice(last, match.index));
		last = match.index + match[0].length;
		if (match[1] === undefined) continue; // OSC or cursor control, not styling
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fg = null;
				bg = null;
				bold = false;
				italic = false;
				underline = false;
			} else if (code === 1) bold = true;
			else if (code === 3) italic = true;
			else if (code === 4) underline = true;
			else if (code === 22) bold = false;
			else if (code === 23) italic = false;
			else if (code === 24) underline = false;
			else if (code === 39) fg = null;
			else if (code === 49) bg = null;
			else if ((code === 38 || code === 48) && params[i + 1] === "5") {
				const color = color256(Number(params[i + 2]));
				if (code === 38) fg = color;
				else bg = color;
				i += 2;
			} else if ((code === 38 || code === 48) && params[i + 1] === "2") {
				const color = `#${params.slice(i + 2, i + 5).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
				if (code === 38) fg = color;
				else bg = color;
				i += 4;
			}
		}
	}
	push(line.slice(last));
	return out;
}

const escapeXml = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const CELL = 8.43;
const LINE = 19.4;
const PAD = 18;
const BAR = 34;
const BG = colorToHex(parseColor(themeJson.export?.pageBg ?? themeJson.vars.text));
const FRAME = colorHex("borderMuted");
const TITLE = colorHex("muted");
/** Terminal default foreground: unstyled runs must not fall back to SVG black. */
const TEXT = colorHex("text");

/** Compose terminal lines into a window-framed SVG at 2x scale. */
function toSvg(lines, { title }) {
	const cols = Math.max(...lines.map((line) => visibleWidth(line.replace(ESCAPE, ""))));
	const width = cols * CELL + PAD * 2;
	const height = lines.length * LINE + PAD * 2 + BAR;
	const body = lines
		.map((line, row) => {
			const y = BAR + PAD + row * LINE;
			const baseline = (y + LINE * 0.72).toFixed(1);
			const background = [];
			const spans = [];
			let column = 0;

			for (const run of runs(line)) {
				const runWidth = visibleWidth(run.text);

				if (run.bg !== null) {
					background.push(
						`<rect x="${(PAD + column * CELL).toFixed(1)}" y="${y.toFixed(1)}" width="${(runWidth * CELL).toFixed(1)}" height="${LINE.toFixed(1)}" fill="${run.bg}"/>`,
					);
				}

				const attrs = [
					run.fg === null ? "" : ` fill="${run.fg}"`,
					run.bold ? ' font-weight="600"' : "",
					run.italic ? ' font-style="italic"' : "",
					run.underline ? ' text-decoration="underline"' : "",
				].join("");

				spans.push(`<tspan${attrs}>${escapeXml(run.text)}</tspan>`);
				column += runWidth;
			}

			return `${background.join("")}\n<text x="${PAD}" y="${baseline}" fill="${TEXT}" xml:space="preserve">${spans.join("")}</text>`;
		})
		.join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Menlo, ui-monospace, monospace" font-size="14">
<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
<rect y="0" width="${width}" height="${BAR}" rx="10" fill="${FRAME}" opacity="0.25"/>
<circle cx="${PAD + 6}" cy="${BAR / 2}" r="5" fill="#ff5f57"/><circle cx="${PAD + 24}" cy="${BAR / 2}" r="5" fill="#febc2e"/><circle cx="${PAD + 42}" cy="${BAR / 2}" r="5" fill="#28c840"/>
<text x="${PAD + 62}" y="${BAR / 2 + 5}" fill="${TITLE}" font-size="13">${escapeXml(title)}</text>
${body}
</svg>
`;
}

/* ------------------------------------------------------------------ main */

mkdirSync(DOCS, { recursive: true });

const frames = [
	{
		name: "question-panel",
		title: "pi — ask_user_questions: 2 questions, the focused option's preview pane",
		lines: panelFrame({ rows: 36, cols: 140 }),
	},
	{
		name: "question-dock",
		title: "pi — the pending dock below the editor after Esc closed the panel",
		lines: dockFrame(100),
	},
	{
		name: "question-answer-row",
		title: "pi — the answer message that resumes the model",
		lines: answerFrame(100),
	},
];

for (const frame of frames) {
	const svg = join(DOCS, `${frame.name}.svg`);
	writeFileSync(svg, toSvg(frame.lines, frame));
	execFileSync("rsvg-convert", ["-z", "2", "-o", join(DOCS, `${frame.name}.png`), svg]);
	console.log(`docs/${frame.name}.svg + .png  (${frame.lines.length} rows)`);
}
