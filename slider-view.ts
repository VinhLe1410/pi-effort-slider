import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_DESCRIPTIONS, type EffortConfig, type EffortLevel } from "./effort.js";

export class EffortSliderComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private levels: EffortLevel[];
	private index: number;
	private config: EffortConfig;
	private shortModel: string;
	private onPick: (level: EffortLevel) => void;

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
	}

	get level(): EffortLevel {
		return this.levels[this.index]!;
	}

	private targetFill(): number {
		if (this.levels.length <= 1) return 1;
		return this.index / (this.levels.length - 1);
	}

	move(dir: -1 | 1): void {
		const next = Math.min(this.levels.length - 1, Math.max(0, this.index + dir));
		if (next === this.index) return;
		this.index = next;
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	cycle(): void {
		if (this.levels.length <= 1) return;
		this.index = (this.index + 1) % this.levels.length;
		this.onPick(this.levels[this.index]!);
		this.tui.requestRender();
	}

	sync(levels: EffortLevel[], level: EffortLevel, shortModel: string): void {
		this.shortModel = shortModel;
		this.levels = levels;
		const pos = levels.indexOf(level);
		this.index = pos === -1 ? 0 : pos;
		this.tui.requestRender();
	}

	private dotsLine(innerW: number): string {
		// One bullet per column. U+2022 renders in every font.
		const total = innerW;
		const filled = Math.round(this.targetFill() * total);
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
		// Pin first label left and last label right. Space the rest evenly.
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
			border("│") + truncateToWidth(` ${th.fg("dim", this.config.descriptions?.[level] || DEFAULT_DESCRIPTIONS[level])}`, innerW, "...", true) + border("│"),
		);

		const hints = th.fg("dim", "← → · ⇧tab · esc");
		const status = `${th.fg("muted", this.shortModel)} ${th.fg("success", level)}`;
		const gap = Math.max(1, innerW - 2 - visibleWidth(hints) - visibleWidth(status));
		lines.push(border("│") + pad(`${hints}${" ".repeat(gap)}${status} `) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {}
}
