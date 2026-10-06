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
 * The overlay never takes focus, so the editor keeps every key except
 * the slider's own. Typing, enter, and all shortcuts flow through.
 *
 * Keys while the slider is visible:
 *   shift+tab         - cycle effort forward (wraps around)
 *   left/right or h/l - change effort (live, animates left to right)
 *   typing or enter   - dismiss the slider, input flows to the editor
 *   esc               - dismiss the slider (consumed, never cancels a run)
 *
 * Optional config: ~/.pi/agent/effort-slider.json
 * {
 *   "levels": ["low", "medium", "high"],
 *   "descriptions": { "medium": "Default for most tasks, balancing quality, speed, and cost." }
 * }
 * Config levels are intersected with what the current model supports.
 * Without config the slider spans every level the model supports.
 */

import { existsSync, readFileSync } from "node:fs";
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

interface SliderSession {
	dismiss: (confirm: boolean) => void;
	route: (data: string) => { consume?: boolean } | undefined;
	sync: (levels: EffortLevel[], level: EffortLevel, shortModel: string) => void;
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

// Kitty-protocol key-release events (CSI u ...:3u) must never act.
// A late Shift+Tab release once reopened the slider after Enter closed
// it. Releases also land after app switches. Releases are swallowed.
function isReleaseEvent(data: string): boolean {
	return /^\x1b\[.*:3u$/.test(data);
}

function modelLabel(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model) return "no model";
	return `${model.provider || "?"}/${model.id || "?"}`;
}

function shortId(ctx: ExtensionContext): string {
	return (ctx.model as { id?: string } | undefined)?.id ?? "no model";
}

class EffortSliderComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private levels: EffortLevel[];
	private index: number;
	private displayFill: number;
	private animTimer: ReturnType<typeof setInterval> | null = null;
	private config: EffortConfig;
	private shortModel: string;
	private onPick: (level: EffortLevel) => void;
	private disposed = false;

	constructor(args: {
		tui: TUI;
		theme: Theme;
		levels: EffortLevel[];
		initialIndex: number;
		config: EffortConfig;
		shortModel: string;
		onPick: (level: EffortLevel) => void;
	}) {
		this.tui = args.tui;
		this.theme = args.theme;
		this.levels = args.levels;
		this.index = args.initialIndex;
		this.config = args.config;
		this.shortModel = args.shortModel;
		this.onPick = args.onPick;
		// Entrance animation: fill sweeps left to right on open.
		this.displayFill = 0;
		this.animateTo(this.targetFill());
	}

	get level(): EffortLevel {
		return this.levels[this.index]!;
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

	move(dir: -1 | 1): void {
		const next = Math.min(this.levels.length - 1, Math.max(0, this.index + dir));
		if (next === this.index) return;
		this.index = next;
		this.animateTo(this.targetFill());
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	cycle(): void {
		if (this.levels.length <= 1) return;
		this.index = (this.index + 1) % this.levels.length;
		this.animateTo(this.targetFill());
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	sync(levels: EffortLevel[], level: EffortLevel, shortModel: string): void {
		this.shortModel = shortModel;
		this.levels = levels;
		const pos = levels.indexOf(level);
		this.index = pos === -1 ? 0 : pos;
		this.animateTo(this.targetFill());
		this.tui.requestRender();
	}

	private dotsLine(innerW: number): string {
		// Small bullet track like Amp: green filled plus gray empty.
		// U+2022 renders in every font, unlike the heavier U+25CF.
		// One dot per column for a full-bleed track.
		const total = innerW;
		const filled = Math.round(this.displayFill * total);
		let out = "";
		for (let i = 0; i < total; i++) {
			out += i < filled ? this.theme.fg("success", "•") : this.theme.fg("dim", "•");
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
async function openEffortSlider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: EffortConfig,
	onSession: (session: SliderSession) => void,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Effort slider needs interactive mode. Use /thinking <level> instead.", "warning");
		return false;
	}

	// The model is fixed at open for the initial levels. Later changes
	// behind the popup arrive via model_select and resync the slider.
	const currentName = modelLabel(ctx);
	const levels = resolveLevels(supportedLevels(ctx.model), config);
	const current = pi.getThinkingLevel() as EffortLevel;
	let startIndex = levels.indexOf(current);
	if (startIndex === -1) startIndex = 0;

	if (levels.length <= 1 && levels[0] === "off") {
		ctx.ui.notify("Current model does not support reasoning effort.", "warning");
		return false;
	}

	let comp: EffortSliderComponent | undefined;
	let doneFn: ((result: string | null) => void) | undefined;
	const promise = ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			comp = new EffortSliderComponent({
				tui,
				theme,
				levels,
				initialIndex: startIndex,
				config,
				shortModel: shortId(ctx),
				onPick: (lvl) => {
					pi.setThinkingLevel(lvl as never);
				},
			});
			doneFn = done;
			return comp;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-right",
				width: 56,
				margin: { bottom: 5, right: 2 },
				// Never take focus. The editor keeps every key. The
				// interceptor below drives the slider and consumes only
				// slider keys.
				nonCapturing: true,
			},
		},
	);
	if (!comp || !doneFn) return false;
	const done = doneFn;

	const dismiss = (confirm: boolean) => {
		done(confirm ? comp!.level : null);
	};

	onSession({
		dismiss: () => dismiss(false),
		route: (data: string) => {
			// Esc and Ctrl+C stay consumed. Passing them through would
			// cancel a running agent and wipe editor text. Both dismiss.
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				dismiss(false);
				return { consume: true };
			}
			// Enter confirms and submits. Typing dismisses and lands.
			// Everything else, including all shortcuts, passes through.
			if (matchesKey(data, "return")) {
				dismiss(true);
				return undefined;
			}
			if (isPrintableText(data)) {
				dismiss(false);
				return undefined;
			}
			if (matchesKey(data, "shift+tab")) {
				// Press cycles once. The release is swallowed so a single
				// press can never double-step.
				if (!isReleaseEvent(data)) comp!.cycle();
				return { consume: true };
			}
			if (matchesKey(data, "left") || matchesKey(data, "h")) {
				comp!.move(-1);
				return { consume: true };
			}
			if (matchesKey(data, "right") || matchesKey(data, "l")) {
				comp!.move(1);
				return { consume: true };
			}
			return undefined;
		},
		sync: (nextLevels, level, shortModel) => {
			comp!.sync(nextLevels, level, shortModel);
		},
	});

	const result = await promise;
	if (result) {
		ctx.ui.notify(`Effort: ${result} · ${currentName}`, "info");
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	let uninstallInput: (() => void) | null = null;
	let active: SliderSession | null = null;
	let sliderOpen = false;
	let lastCloseAt = 0;
	let sessionConfig: EffortConfig = {};
	const REOPEN_DEBOUNCE_MS = 350;

	// Single flight across every open path. Without this, Shift+Tab plus
	// Ctrl+Shift+E together could stack two overlays, and closing the top
	// one would reveal the second looking like a phantom reopen.
	const cooling = () => Date.now() - lastCloseAt < REOPEN_DEBOUNCE_MS;
	async function tryOpen(ctx: ExtensionContext): Promise<boolean> {
		if (sliderOpen || cooling()) return false;
		sliderOpen = true;
		try {
			const showed = await openEffortSlider(pi, ctx, sessionConfig, (session) => {
				active = session;
			});
			if (!showed) return false;
			lastCloseAt = Date.now();
			return true;
		} finally {
			sliderOpen = false;
		}
	}

	const closeActive = () => {
		try {
			active?.dismiss(false);
		} catch {
			// Teardown is best effort.
		}
		active = null;
	};

	const refreshActive = (ctx: ExtensionContext) => {
		if (!active) return;
		const lvl = pi.getThinkingLevel() as EffortLevel;
		active.sync(resolveLevels(supportedLevels(ctx.model), sessionConfig), lvl, shortId(ctx));
	};

	// Shift+Tab is reserved for the built-in thinking cycler, so a plain
	// registerShortcut for it would be skipped. Intercept it earlier via
	// raw terminal input and consume it. This shadows the built-in cycle
	// while the extension is loaded. Rebind app.thinking.cycle in
	// keybindings.json if both behaviors are wanted.
	//
	// The trigger matches only the literal Shift+Tab byte sequence. Cmd
	// never reaches the pty, so Cmd+Tab app switching sends nothing.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Fresh session, fresh state. If a slider was orphaned by a
		// session replacement mid-dialog, its promise belongs to the old
		// UI and must not block new opens.
		sliderOpen = false;
		lastCloseAt = 0;
		active = null;
		let agentDir: string | undefined;
		try {
			agentDir = getAgentDir();
		} catch {
			agentDir = undefined;
		}
		sessionConfig = loadConfig(agentDir);
		if (uninstallInput) {
			try {
				uninstallInput();
			} catch {
				// ignore stale unsubscribe
			}
			uninstallInput = null;
		}
		uninstallInput = ctx.ui.onTerminalInput((data) => {
			// Visible slider routes first. Everything the route does not
			// consume flows to the editor, shortcuts included.
			if (active) return active.route(data);
			if (!matchesKey(data, "shift+tab")) return undefined;
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
		closeActive();
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

	// The slider mirrors outside changes live. Ctrl+P and friends keep
	// working while it is visible, so resync on their events.
	pi.on("model_select", (_event, ctx) => {
		refreshActive(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		refreshActive(ctx);
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
