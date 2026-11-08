import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { canTransition, DurableScript, external, type MemoryStorage, memoryStorage, TRANSITIONS, type ProgramState, write } from "../src";
import { scriptWith, wasm } from "./support";

const STATES: ReadonlyArray<ProgramState> = ["running", "sliced", "waiting", "finished", "failed"];

describe("program state machine", () => {
	test("finished and failed are terminal", () => {
		for (const to of STATES) {
			expect(canTransition("finished", to)).toBe(false);
			expect(canTransition("failed", to)).toBe(false);
		}
	});

	test("waiting only leaves by becoming running", () => {
		expect(TRANSITIONS.waiting).toEqual(["running"]);
	});

	test("every state change on real runs is an allowed edge", async () => {
		const edges = new Set<string>();
		const watch = (storage: MemoryStorage): MemoryStorage => ({
			...storage,
			commit: (change) => {
				const next = change.put?.find(([key]) => key === "meta")?.[1];
				const before = storage.data.get("meta");
				if (typeof next === "string" && typeof before === "string") {
					const from = (JSON.parse(before) as { state: ProgramState }).state;
					const to = (JSON.parse(next) as { state: ProgramState }).state;
					edges.add(`${from}>${to}`);
				}
				storage.commit(change);
			},
		});
		const tools = {
			ask: external(Schema.Unknown),
			slow: external(Schema.Unknown, { timeoutMs: 10 }),
			save: write(Schema.Unknown, () => "ok"),
		};
		const storage = watch(memoryStorage());
		const clock = { now: 1_000_000 };
		const script = new DurableScript({ programId: "t", storage, tools, wasm, now: () => clock.now, budgetTicks: 1 });
		const first = await script.run(`let n = 0; for (let i = 0; i < 20000; i++) n += i; tool("save", {}); const a = tool("ask", {}); let t = ""; try { tool("slow", {}); } catch (e) { t = e.name; } ({ a, t, n })`);
		let outcome = first;
		while (outcome._tag === "Running") outcome = await script.alarm();
		if (outcome._tag !== "Waiting") throw new Error(JSON.stringify(outcome));
		outcome = await script.answer(outcome.token, 7);
		clock.now += 100;
		while (outcome._tag !== "Finished" && outcome._tag !== "Failed") outcome = await script.alarm();

		expect(outcome).toEqual({ _tag: "Finished", result: { a: 7, t: "Timeout", n: 199990000 } });
		expect(edges.size).toBeGreaterThan(2);
		for (const edge of edges) {
			const [from, to] = edge.split(">") as [ProgramState, ProgramState];
			expect(canTransition(from, to), edge).toBe(true);
		}
	});

	test("run() may restart a finished program", async () => {
		const { script } = scriptWith({});

		expect((await script.run(`1`))._tag).toBe("Finished");
		expect((await script.run(`2`))._tag).toBe("Finished");
	});
});
