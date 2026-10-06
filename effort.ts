import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const ALL_LEVELS: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_DESCRIPTIONS: Record<EffortLevel, string> = {
	off: "No reasoning.",
	minimal: "Very brief reasoning.",
	low: "Light reasoning.",
	medium: "Default for most tasks.",
	high: "Deep reasoning.",
	xhigh: "Extra-deep reasoning.",
	max: "Maximum reasoning.",
};

export interface EffortConfig {
	levels?: EffortLevel[];
	descriptions?: Partial<Record<EffortLevel, string>>;
}

export function loadConfig(agentDir: string | undefined): EffortConfig {
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

// Same rules as pi-ai getSupportedThinkingLevels. Avoids the import.
export function supportedLevels(model: unknown): EffortLevel[] {
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

export function resolveLevels(supported: EffortLevel[], config: EffortConfig): EffortLevel[] {
	// Use all supported levels. Use config levels only when set. Drop config levels the model lacks.
	if (config.levels && config.levels.length > 0) {
		const wanted = config.levels.filter((l) => ALL_LEVELS.includes(l));
		const kept = wanted.filter((l) => supported.includes(l));
		if (kept.length > 0) return kept;
	}
	return supported;
}

export function modelNames(ctx: ExtensionContext): { label: string; short: string } {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model) return { label: "no model", short: "no model" };
	return { label: `${model.provider || "?"}/${model.id || "?"}`, short: model.id ?? "no model" };
}
