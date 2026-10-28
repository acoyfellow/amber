import { Schema } from "effect";
import approvals from "../../programs/approvals.ts?raw";
import dungeon from "../../programs/dungeon.ts?raw";
import counter from "../../programs/counter.ts?raw";
import loop from "../../programs/loop.ts?raw";
import type { ToolCall } from "../../shared/protocol";

export const PresetKey = Schema.Literals(["dungeon", "approvals", "counter", "loop"]);

export type PresetKey = typeof PresetKey.Type;

export type Preset = { readonly key: PresetKey; readonly label: string; readonly blurb: string; readonly source: string };

export const PRESETS: ReadonlyArray<Preset> = [
	{
		key: "dungeon",
		label: "Dungeon",
		blurb: "A whole dungeon crawl written as one while loop. Every choice freezes the game into a couple of KB. Kill the Durable Object between moves; the loop never notices.",
		source: dungeon,
	},
	{
		key: "approvals",
		label: "Approvals",
		blurb: "An agent script that lists issues, then asks you about each one. Every tool() call freezes the whole program until you answer.",
		source: approvals,
	},
	{
		key: "counter",
		label: "Closure",
		blurb: "A counter inside a closure. Kill the object between answers: the count is still there, because the heap is.",
		source: counter,
	},
	{
		key: "loop",
		label: "Long loop",
		blurb: "Three million iterations and no tool calls. A tick budget slices it; Durable Object alarms continue each slice. Kill it mid-loop.",
		source: loop,
	},
];

export const presetFor = (key: PresetKey): Preset => PRESETS.find((preset) => preset.key === key) ?? PRESETS[0] ?? { key, label: key, blurb: "", source: "" };

const SAMPLE_ISSUES = [
	{ id: 41, title: "desk card flicker", labels: [] },
	{ id: 42, title: "duplicate recipe", labels: ["bug"] },
	{ id: 43, title: "voice clip cuts off", labels: [] },
];

export const suggestedAnswer = (call: ToolCall): string => {
	if (call.name === "gh.list_issues") return JSON.stringify(SAMPLE_ISSUES, null, 2);

	if (call.name === "ask_user") return "true";

	if (call.name === "choose") return "0";

	return "null";
};
