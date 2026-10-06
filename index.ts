/**
 * Reasoning effort picker for Pi.
 *
 * Run: pi --extension ./effort-slider.ts
 * Use: /effort [level] opens the slider or sets the level directly.
 * Shift+Tab opens the slider. Press again inside to cycle effort.
 * Ctrl+Shift+E opens the slider.
 *
 * The slider is a bottom-right overlay above the input box. It does not take focus. Typing, enter, and shortcuts reach the editor.
 *
 * Keys while visible:
 *   shift+tab         - open the slider, cycle effort forward
 *   left/right or h/l - change effort, applied at once
 *   typing or enter   - close the slider, send input to the editor
 *   esc               - close the slider, does not cancel a run
 *
 * Optional config: ~/.pi/agent/effort-slider.json
 * {
 *   "levels": ["low", "medium", "high"],
 *   "descriptions": { "medium": "Default for most tasks, balancing quality, speed, and cost." }
 * }
 * Config levels intersect with levels the current model supports. Without config the slider uses all supported levels.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { ALL_LEVELS, loadConfig, modelNames, resolveLevels, supportedLevels, type EffortConfig, type EffortLevel } from "./effort.js";
import { isPrintableText, isReleaseEvent } from "./keys.js";
import { EffortSliderComponent } from "./slider-view.js";

interface SliderSession {
	dismiss: () => void;
	route: (data: string) => { consume?: boolean } | undefined;
	sync: (levels: EffortLevel[], level: EffortLevel, shortModel: string) => void;
}

// Return null when nothing showed. Return the live session plus a promise for close.
function openEffortSlider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: EffortConfig,
): { session: SliderSession; closed: Promise<boolean> } | null {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Effort slider needs interactive mode. Use /thinking <level> instead.", "warning");
		return null;
	}

	// Read levels from the model at open. model_select resyncs later changes.
	const names = modelNames(ctx);
	const levels = resolveLevels(supportedLevels(ctx.model), config);
	const current = pi.getThinkingLevel() as EffortLevel;
	let startIndex = levels.indexOf(current);
	if (startIndex === -1) startIndex = 0;

	if (levels.length <= 1 && levels[0] === "off") {
		ctx.ui.notify("Current model does not support reasoning effort.", "warning");
		return null;
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
				shortModel: names.short,
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
				// Keep focus in the editor. The input handler below consumes only slider keys.
				nonCapturing: true,
			},
		},
	);
	if (!comp || !doneFn) return null;
	const done = doneFn;

	const dismiss = (confirm: boolean) => {
		done(confirm ? comp!.level : null);
	};

	const session: SliderSession = {
		dismiss: () => dismiss(false),
		route: (data: string) => {
			// Consume esc and ctrl+c. They close the slider. Passing them through cancels a run or clears input.
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				dismiss(false);
				return { consume: true };
			}
			// Enter confirms. Typing closes and sends input to the editor. Pass through all other keys.
			if (matchesKey(data, "return")) {
				dismiss(true);
				return undefined;
			}
			if (isPrintableText(data)) {
				dismiss(false);
				return undefined;
			}
			if (matchesKey(data, "shift+tab")) {
				// Cycle once per press. Ignore the release event.
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
	};

	const closed = (async () => {
		const result = await promise;
		if (result) {
			ctx.ui.notify(`Effort: ${result} · ${names.label}`, "info");
		}
		return true;
	})();
	return { session, closed };
}

export default function (pi: ExtensionAPI) {
	let uninstallInput: (() => void) | null = null;
	let active: SliderSession | null = null;
	let sliderOpen = false;
	let lastCloseAt = 0;
	let sessionConfig: EffortConfig = {};
	const REOPEN_DEBOUNCE_MS = 350;

	// Allow one slider at a time. This stops stacked overlays from two triggers.
	const cooling = () => Date.now() - lastCloseAt < REOPEN_DEBOUNCE_MS;
	async function tryOpen(ctx: ExtensionContext): Promise<boolean> {
		if (sliderOpen || cooling()) return false;
		sliderOpen = true;
		const opened = openEffortSlider(pi, ctx, sessionConfig);
		if (!opened) {
			sliderOpen = false;
			return false;
		}
		active = opened.session;
		try {
			const showed = await opened.closed;
			if (!showed) return false;
			lastCloseAt = Date.now();
			return true;
		} finally {
			if (active === opened.session) active = null;
			sliderOpen = false;
		}
	}

	const refreshActive = (ctx: ExtensionContext) => {
		if (!active) return;
		const lvl = pi.getThinkingLevel() as EffortLevel;
		active.sync(resolveLevels(supportedLevels(ctx.model), sessionConfig), lvl, modelNames(ctx).short);
	};

	// Shift+Tab is reserved for the built-in thinking cycler. Registering it as a shortcut fails. Read raw terminal input instead. This replaces the built-in cycle while installed. Rebind app.thinking.cycle to keep both.
	//
	// Match only the Shift+Tab bytes. Cmd+Tab never reaches the pty.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Clear state on session start. A replaced session must not block new opens.
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
				// Ignore errors from old handlers.
			}
			uninstallInput = null;
		}
		uninstallInput = ctx.ui.onTerminalInput((data) => {
			// Send input to the open slider first. Send the rest to the editor.
			if (active) return active.route(data);
			if (!matchesKey(data, "shift+tab")) return undefined;
			// Ignore releases. The press already acted. Passing a release through triggers the built-in cycler.
			if (isReleaseEvent(data)) return { consume: true };
			// During cooldown pass the key to the built-in cycler.
			if (cooling()) return undefined;
			void tryOpen(ctx);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		try {
			active?.dismiss();
		} catch {
			// Ignore teardown errors.
		}
		active = null;
		if (uninstallInput) {
			try {
				uninstallInput();
			} catch {
				// Ignore errors from old handlers.
			}
			uninstallInput = null;
		}
		sliderOpen = false;
		lastCloseAt = 0;
	});

	// Resync when the model or level changes elsewhere.
	pi.on("model_select", (_event, ctx) => {
		refreshActive(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		refreshActive(ctx);
	});

	pi.registerCommand("effort", {
		description: "Reasoning effort slider",
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

	// Shift+Tab uses the raw-input handler above. Pi blocks extension shortcuts on that key. Ctrl+Shift+E works without interception.
	pi.registerShortcut(Key.ctrlShift("e"), {
		description: "Open effort slider",
		handler: async (ctx) => {
			await tryOpen(ctx);
		},
	});
}
