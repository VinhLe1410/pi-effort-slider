/**
 * Effort slider POC - Amp-style reasoning effort picker for Pi.
 *
 * Run: pi --extension ./effort-slider.ts
 * Use:  /effort [level]  - open the slider, or set a level directly
 *       Shift+Tab        - open the slider, press again inside to cycle effort
 *       Ctrl+Shift+E     - open the slider (fallback)
 *
 * The slider is a bottom-right overlay popup that sits just above the
 * input box. It sweeps left to right on open and on every change.
 *
 * Keys in the slider:
 *   shift+tab         - cycle effort forward (wraps around)
 *   left/right or h/l - change effort (live, animates left to right)
 *   tab               - swallowed, the slider is effort-only
 *   typing            - dismiss the slider, text lands in the editor
 *   enter             - confirm and close
 *   esc               - close (keeps the last live-applied level)
 *
 * Optional config: ~/.pi/agent/effort-slider.json
 * {
 *   "levels": ["low", "medium", "high"],
 *   "descriptions": { "medium": "Default for most tasks, balancing quality, speed, and cost." }
 * }
 * Config levels are intersected with what the current model supports.
 * Without config the slider spans every level the model supports.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_DESCRIPTIONS: Record<EffortLevel, string> = {
	off: "No reasoning.",
	minimal: "Very brief reasoning (~1k tokens).",
	low: "Light reasoning (~2k tokens).",
	medium: "Default for most tasks, balancing quality, speed, and cost.",
	high: "Deep reasoning (~16k tokens).",
	xhigh: "Extra-high reasoning (~32k tokens).",
	max: "Maximum reasoning.",
};

interface EffortConfig {
	levels?: EffortLevel[];
	descriptions?: Partial<Record<EffortLevel, string>>;
}

function loadConfig(agentDir: string | undefined): EffortConfig {
	if (!agentDir) return {};
	const home = process.env.HOME;
	const dir = agentDir || (home ? join(home, ".pi", "agent") : "");
	if (!dir) return {};
	const path = join(dir, "effort-slider.json");
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as EffortConfig;
	} catch {
		return {};
	}
}

/** Replicates pi-ai getSupportedThinkingLevels without importing it. */
function supportedLevels(model: unknown): EffortLevel[] {
	const m = model as { reasoning?: boolean; thinkingLevelMap?: Partial<Record<EffortLevel, string | null>> } | undefined;
	if (!m) return [...ALL_LEVELS];
	if (!m.reasoning) return ["off"];
	return ALL_LEVELS.filter((level) => {
		const mapped = m.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function resolveLevels(supported: EffortLevel[], config: EffortConfig): EffortLevel[] {
	// Span every effort the model supports. Only an explicit config
	// narrows the slider, intersected with supported levels.
	if (config.levels && config.levels.length > 0) {
		const wanted = config.levels.filter((l) => ALL_LEVELS.includes(l));
		const kept = wanted.filter((l) => supported.includes(l));
		if (kept.length > 0) return kept;
	}
	return supported;
}

function describe(level: EffortLevel, config: EffortConfig): string {
	return config.descriptions?.[level] || DEFAULT_DESCRIPTIONS[level];
}

function isPrintableText(data: string): boolean {
	if (data.length === 0) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		// Exclude control characters and escape sequences. Functional keys
		// are matched by matchesKey before this runs.
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

// Env-gated trace for phantom-open hunts. Run with PI_EFFORT_DEBUG=1
// and reproduce, then read $TMPDIR/pi-effort-slider-debug.log.
function debugLog(event: string, detail?: unknown): void {
	if (process.env.PI_EFFORT_DEBUG !== "1") return;
	try {
		appendFileSync(
			join(tmpdir(), "pi-effort-slider-debug.log"),
			`${new Date().toISOString()} ${event}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
		);
	} catch {
		// Logging must never break the extension.
	}
}

// Kitty-protocol key-release events (CSI u ...:3u) must never act.
// The debug log proved the phantom: press opened, Enter closed, and the
// late Shift+Tab release reopened 539ms later. Releases also land after
// app switches, which is the Cmd+Tab phantom. Releases are swallowed.
function isReleaseEvent(data: string): boolean {
	return /^\x1b\[.*:3u$/.test(data);
}

function modelLabel(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model) return "no model";
	return `${model.provider || "?"}/${model.id || "?"}`;
}

class EffortSliderComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private levels: EffortLevel[];
	private index: number;
	private displayFill: number;
	private animTimer: ReturnType<typeof setInterval> | null = null;
	private config: EffortConfig;
	private shortModel: string;
	private onPick: (level: EffortLevel) => void;
	private onTypeText: (text: string) => void;
	private disposed = false;
	private finished = false;

	constructor(args: {
		tui: TUI;
		theme: Theme;
		done: (result: string | null) => void;
		levels: EffortLevel[];
		initialIndex: number;
		config: EffortConfig;
		shortModel: string;
		onPick: (level: EffortLevel) => void;
		onTypeText: (text: string) => void;
	}) {
		this.tui = args.tui;
		this.theme = args.theme;
		this.done = args.done;
		this.levels = args.levels;
		this.index = args.initialIndex;
		this.config = args.config;
		this.shortModel = args.shortModel;
		this.onPick = args.onPick;
		this.onTypeText = args.onTypeText;
		// Entrance animation: fill sweeps left to right on open.
		this.displayFill = 0;
		this.animateTo(this.targetFill());
	}

	private targetFill(): number {
		if (this.levels.length <= 1) return 1;
		return this.index / (this.levels.length - 1);
	}

	private animateTo(target: number): void {
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}
		const from = this.displayFill;
		if (Math.abs(from - target) < 0.001) {
			this.displayFill = target;
			this.tui.requestRender();
			return;
		}
		const durationMs = 160;
		const started = Date.now();
		this.animTimer = setInterval(() => {
			if (this.disposed) {
				if (this.animTimer) clearInterval(this.animTimer);
				return;
			}
			const t = Math.min(1, (Date.now() - started) / durationMs);
			const eased = 1 - Math.pow(1 - t, 3);
			this.displayFill = from + (target - from) * eased;
			this.tui.requestRender();
			if (t >= 1 && this.animTimer) {
				clearInterval(this.animTimer);
				this.animTimer = null;
			}
		}, 33);
	}

	private move(dir: -1 | 1): void {
		const next = Math.min(this.levels.length - 1, Math.max(0, this.index + dir));
		if (next === this.index) return;
		this.index = next;
		this.animateTo(this.targetFill());
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	private cycle(): void {
		if (this.levels.length <= 1) return;
		this.index = (this.index + 1) % this.levels.length;
		this.animateTo(this.targetFill());
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	private close(result: string | null): void {
		// Guard against double-dismiss from rapid keys before unmount.
		if (this.finished) return;
		this.finished = true;
		this.done(result);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			debugLog("dismiss", "esc");
			this.close(null);
		} else if (matchesKey(data, "return")) {
			debugLog("dismiss", "return");
			this.close(this.levels[this.index]!);
		} else if (matchesKey(data, "shift+tab")) {
			// Press cycles once. The release is swallowed so a single
			// press can never double-step.
			if (!isReleaseEvent(data)) this.cycle();
		} else if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.move(-1);
		} else if (matchesKey(data, "right") || matchesKey(data, "l")) {
			this.move(1);
		// Plain tab is intentionally swallowed. The slider is
			// effort-only. Arrows and shift+tab change the level.
		} else if (isPrintableText(data)) {
			// Typing dismisses the slider and lands in the editor,
			// so the popup never traps normal input.
			debugLog("dismiss", `typing:${data.length}`);
			this.onTypeText(data);
			this.close(null);
		}
	}

	private dotsLine(innerW: number): string {
		// Small bullet track like Amp: green filled plus gray empty.
		// U+2022 renders in every font, unlike the heavier U+25CF.
		// One dot per column for a full-bleed track.
		const total = innerW;
		const filled = Math.round(this.displayFill * total);
		let out = "";
		let prevCol = -1;
		for (let i = 0; i < total; i++) {
			const col = Math.round((i * (innerW - 1)) / (total - 1));
			out += " ".repeat(Math.max(0, col - prevCol - 1));
			out += i < filled ? this.theme.fg("success", "•") : this.theme.fg("dim", "•");
			prevCol = col;
		}
		return out;
	}

	private labelsLine(innerW: number): string {
		if (this.levels.length === 1) {
			const only = this.levels[0]!;
			const styled = this.theme.fg("success", only);
			const pad = Math.max(0, Math.floor((innerW - visibleWidth(only)) / 2));
			return " ".repeat(pad) + styled;
		}
		// Distribute labels across the width: first left, last right, rest spaced.
		const gaps = this.levels.length - 1;
		const textWidth = this.levels.reduce((n, l) => n + visibleWidth(l), 0);
		const spaceTotal = Math.max(gaps, innerW - textWidth);
		const perGap = Math.floor(spaceTotal / gaps);
		let remainder = spaceTotal - perGap * gaps;
		let line = "";
		this.levels.forEach((l, i) => {
			line += i === this.index ? this.theme.fg("success", l) : this.theme.fg("dim", l);
			if (i < gaps) {
				let gap = perGap + (remainder > 0 ? 1 : 0);
				if (remainder > 0) remainder--;
				line += " ".repeat(gap);
			}
		});
		return line;
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(12, width - 2);
		const border = (c: string) => th.fg("border", c);
		const pad = (s: string) => truncateToWidth(` ${s}`, innerW, "", true);
		const lines: string[] = [];
		const level = this.levels[this.index]!;

		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + pad(this.dotsLine(innerW - 2)) + border("│"));
		lines.push(border("│") + pad(this.labelsLine(innerW - 2)) + border("│"));
		lines.push(border("│") + pad("") + border("│"));
		lines.push(
			border("│") + truncateToWidth(` ${th.fg("dim", describe(level, this.config))}`, innerW, "...", true) + border("│"),
		);

		const hints = th.fg("dim", "← → · ⇧tab · esc");
		const status = `${th.fg("muted", this.shortModel)} ${th.fg("success", level)}`;
		const gap = Math.max(1, innerW - 2 - visibleWidth(hints) - visibleWidth(status));
		lines.push(border("│") + pad(`${hints}${" ".repeat(gap)}${status} `) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}
	}
}

// True when the slider actually showed. False on early exits that never
// displayed anything, so callers only debounce real opens.
async function openEffortSlider(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Effort slider needs interactive mode. Use /thinking <level> instead.", "warning");
		return false;
	}
	let agentDir: string | undefined;
	try {
		agentDir = getAgentDir();
	} catch {
		agentDir = undefined;
	}
	const config = loadConfig(agentDir);

	// The model is fixed for the life of the popup. The overlay owns
	// focus, so no model switch can happen underneath it.
	const currentName = modelLabel(ctx);
	const shortId = (ctx.model as { id?: string } | undefined)?.id ?? "no model";

	const levels = resolveLevels(supportedLevels(ctx.model), config);
	const current = pi.getThinkingLevel() as EffortLevel;
	let startIndex = levels.indexOf(current);
	if (startIndex === -1) startIndex = 0;

	if (levels.length <= 1 && levels[0] === "off") {
		ctx.ui.notify("Current model does not support reasoning effort.", "warning");
		return false;
	}

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const comp = new EffortSliderComponent({
				tui,
				theme,
				done,
				levels,
				initialIndex: startIndex,
				config,
				shortModel: shortId,
				onPick: (lvl) => {
					pi.setThinkingLevel(lvl as never);
				},
				onTypeText: (text) => {
					const ui = ctx.ui as unknown as {
						pasteToEditor?: (t: string) => void;
						getEditorText?: () => string;
						setEditorText?: (t: string) => void;
					};
					try {
						if (typeof ui.pasteToEditor === "function") {
							ui.pasteToEditor(text);
							return;
						}
						if (typeof ui.getEditorText === "function" && typeof ui.setEditorText === "function") {
							ui.setEditorText(`${ui.getEditorText()}${text}`);
						}
					} catch {
						// Editor writeback is best effort. The slider still closes.
					}
				},
			});
			return comp;
		},
		{
			overlay: true,
			// Bottom margin clears the footer plus the editor box so the
			// popup sits just above the input instead of covering it.
			overlayOptions: { anchor: "bottom-right", width: 56, margin: { bottom: 5, right: 2 } },
		},
	);

	if (result) {
		ctx.ui.notify(`Effort: ${result} · ${currentName}`, "info");
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	let uninstallInput: (() => void) | null = null;
	let sliderOpen = false;
	let lastCloseAt = 0;
	const REOPEN_DEBOUNCE_MS = 350;

	// Single flight across every open path. Without this, Shift+Tab plus
	// Ctrl+Shift+E together could stack two overlays, and closing the top
	// one would reveal the second looking like a phantom reopen.
	const cooling = () => Date.now() - lastCloseAt < REOPEN_DEBOUNCE_MS;
	async function tryOpen(ctx: ExtensionContext): Promise<boolean> {
		if (sliderOpen || cooling()) {
			debugLog("tryOpen-skip", { sliderOpen });
			return false;
		}
		sliderOpen = true;
		try {
			const showed = await openEffortSlider(pi, ctx);
			debugLog("tryOpen-done", { showed });
			if (showed) lastCloseAt = Date.now();
			return showed;
		} finally {
			sliderOpen = false;
		}
	}

	// Shift+Tab is reserved for the built-in thinking cycler, so a plain
	// registerShortcut for it would be skipped. Intercept it earlier via
	// raw terminal input and consume it. This shadows the built-in cycle
	// while the extension is loaded. Rebind app.thinking.cycle in
	// keybindings.json if both behaviors are wanted.
	//
	// The trigger matches only the literal Shift+Tab byte sequence. Cmd
	// never reaches the pty, so Cmd+Tab app switching sends nothing. A
	// slider that appears around then is either a held Shift key turning
	// the switch into Shift+Tab, or a stacked second overlay.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Fresh session, fresh state. If a slider was orphaned by a
		// session replacement mid-dialog, its promise belongs to the old
		// UI and must not block new opens.
		sliderOpen = false;
		lastCloseAt = 0;
		debugLog("session_start");
		if (uninstallInput) {
			try {
				uninstallInput();
			} catch {
				// ignore stale unsubscribe
			}
			uninstallInput = null;
		}
		uninstallInput = ctx.ui.onTerminalInput((data) => {
			// Open slider gets the key for effort cycling.
			if (sliderOpen) return undefined;
			if (!matchesKey(data, "shift+tab")) return undefined;
			debugLog("intercept-shift-tab", data);
			// Swallow releases without opening. The press already
			// acted. Passing a release down would also let the
			// built-in cycler fire on it.
			if (isReleaseEvent(data)) return { consume: true };
			// Inside the cooldown window let the key fall through
			// to the built-in cycler instead of eating it.
			if (cooling()) return undefined;
			void tryOpen(ctx);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		debugLog("session_shutdown");
		if (uninstallInput) {
			try {
				uninstallInput();
			} catch {
				// ignore stale unsubscribe
			}
			uninstallInput = null;
		}
		sliderOpen = false;
		lastCloseAt = 0;
	});

	pi.registerCommand("effort", {
		description: "Amp-style reasoning effort slider",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const want = args.trim().toLowerCase();
			if (want) {
				const lvl = ALL_LEVELS.find((l) => l === want);
				if (!lvl) {
					ctx.ui.notify(`Unknown effort "${args.trim()}". Try one of: ${ALL_LEVELS.join(", ")}.`, "error");
					return;
				}
				pi.setThinkingLevel(lvl as never);
				ctx.ui.notify(`Effort: ${lvl}`, "info");
				return;
			}
			await tryOpen(ctx);
		},
	});

	// Shift+Tab opens the slider via the raw-input interceptor above, not via
	// a registered shortcut: Pi reserves Shift+Tab for the built-in
	// app.thinking.cycle action and skips extension shortcuts on reserved
	// keys (registering one only prints an Extension issues warning).
	// Ctrl+Shift+E stays as a fallback that works without interception.
	pi.registerShortcut(Key.ctrlShift("e"), {
		description: "Open effort slider",
		handler: async (ctx) => {
			await tryOpen(ctx);
		},
	});
}
