import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";
import type { BenchResult, BenchSystem } from "../../../shared/bench";
import { BenchMessage, benchUpdate, initialBenchModel, RunCodemode, RunSystem } from "./app";
import { countLines } from "./sources";

const result = (system: BenchSystem): BenchResult => ({
	system,
	ranAt: 1,
	approvals: { answers: 8, kills: 4, killable: true, correct: true, resumeMs: [1], p50Ms: 1, p95Ms: 1, totalMs: 10, bytesPerPause: 100, objects: 5 },
	loop: { wallMs: 5, cpuMs: null, correct: true, slices: null },
	notes: [],
});

describe("running all benchmarks", () => {
	test("Run all runs codemode-pause first, then every system one at a time", () => {
		story(
			benchUpdate,
			given(initialBenchModel),
			message(BenchMessage.ClickedRunAll()),
			model((current) => expect(current.runningCodemode).toBe(true)),
			Command.resolve(RunCodemode(), BenchMessage.FailedCodemode({ reason: "slow" })),
			model((current) => {
				expect(current.runningCodemode).toBe(false);
				expect(current.running).toEqual(Option.some("amber"));
				expect(current.queue).toEqual(["workflows", "agents", "durable-object"]);
			}),
			Command.resolve(RunSystem({ system: "amber" }), BenchMessage.GotRun({ run: { result: result("amber"), cached: false } })),
			model((current) => {
				expect(current.running).toEqual(Option.some("workflows"));
				expect(current.results.map((r) => r.system)).toEqual(["amber"]);
			}),
			Command.resolve(RunSystem({ system: "workflows" }), BenchMessage.FailedRun({ system: "workflows", reason: "boom" })),
			Command.resolve(RunSystem({ system: "agents" }), BenchMessage.GotRun({ run: { result: result("agents"), cached: true } })),
			Command.resolve(RunSystem({ system: "durable-object" }), BenchMessage.GotRun({ run: { result: result("durable-object"), cached: false } })),
			model((current) => {
				expect(current.running).toEqual(Option.none());
				expect(current.results.map((r) => r.system)).toEqual(["amber", "agents", "durable-object"]);
				expect(current.log.some((line) => line.includes("workflows: failed (boom)"))).toBe(true);
			}),
		);
	});

	test("A second click while a run is in flight does nothing", () => {
		const running = { ...initialBenchModel, running: Option.some<BenchSystem>("agents"), queue: ["durable-object" as const] };

		story(
			benchUpdate,
			given(running),
			message(BenchMessage.ClickedRunAll()),
			model((current) => expect(current).toEqual(running)),
		);
	});
});

describe("lines of code", () => {
	test("counts non-blank, non-import lines", () => {
		expect(countLines('import { a } from "b";\n\nconst x = 1;\n  \nexport { x };\n')).toBe(2);
	});
});
