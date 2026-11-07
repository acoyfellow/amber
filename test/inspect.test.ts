import { Schema } from "effect";
import { Option } from "effect";
import { describe, expect, test } from "vitest";
import { type Decision, DurableScript, external, type Outcome, type Plan, read, type Waiting, write } from "../src";
import { scriptWith, wasm } from "./support";

const Id = Schema.Struct({ id: Schema.Number });

const asWaiting = (outcome: Outcome): Waiting => {
	if (outcome._tag !== "Waiting") throw new Error(`expected Waiting, got ${JSON.stringify(outcome)}`);

	return outcome;
};

const SOURCE = `const items = tool("list", {});
const closed = [];
for (const id of items) {
  const ok = tool("ask", { id });
  if (ok) {
    try { tool("close", { id }); closed.push(id); }
    catch (e) { closed.push(e.name + ":" + id); }
  }
}
({ closed })`;

const effects = () => {
	const done: Array<number> = [];

	return {
		done,
		tools: {
			list: read(Schema.Struct({}), () => [1, 2, 3]),
			ask: external(Id),
			close: write(Id, ({ id }) => {
				done.push(id);

				return id;
			}),
		},
	};
};

describe("inspect", () => {
	test("a paused program shows its source, the frozen line, the pending call and its history", async () => {
		const { tools } = effects();
		const { script } = scriptWith(tools);
		const waiting = asWaiting(await script.run(SOURCE));

		expect(waiting.line).toBe(4);

		const seen = Option.getOrThrow(script.inspect());

		expect(seen.state).toBe("waiting");
		expect(seen.line).toBe(4);
		expect(seen.source).toBe(SOURCE);
		expect(seen.pending).toEqual({ kind: "external", name: "ask", args: { id: 1 }, reason: null });
		expect(seen.history).toEqual([{ step: 1, name: "list", kind: "read", args: {}, result: { v: [1, 2, 3] }, line: 1 }]);

		await script.answer(waiting.token, true);

		const later = Option.getOrThrow(script.inspect());

		expect(later.history.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["read:list", "external:ask", "write:close"]);
		expect(later.history.find((entry) => entry.name === "close")?.line).toBe(6);
	});
});

describe("gate", () => {
	test("the gate sees the plan, and a denied write never runs and surfaces as Denied", async () => {
		const { tools, done } = effects();
		const plans: Array<Plan> = [];
		const gate = (plan: Plan): Decision => {
			plans.push(plan);

			return (plan.args as { id: number }).id === 2 ? { deny: "keep #2 open" } : { allow: true };
		};
		const { script } = scriptWith(tools, { gate });
		let outcome = await script.run(SOURCE);

		while (outcome._tag === "Waiting") outcome = await script.answer(outcome.token, true);

		expect(outcome).toEqual({ _tag: "Finished", result: { closed: [1, "Denied:2", 3] } });
		expect(done).toEqual([1, 3]);
		expect(plans.map((plan) => [plan.tool, plan.line, plan.history.length])).toEqual([
			["close", 6, 2],
			["close", 6, 4],
			["close", 6, 6],
		]);
		expect(plans[0]?.source).toBe(SOURCE);
	});

	test("a held write pauses like an external call; approving runs it, refusing throws Denied", async () => {
		const { tools, done } = effects();
		const { script } = scriptWith(tools, { gate: (plan) => (plan.tool === "close" ? { hold: "closing needs a reviewer" } : { allow: true }) });
		const ask1 = asWaiting(await script.run(SOURCE));
		const hold1 = asWaiting(await script.answer(ask1.token, true));

		expect(hold1).toMatchObject({ kind: "hold", name: "close", args: { id: 1 }, reason: "closing needs a reviewer", line: 6 });
		expect(done).toEqual([]);

		const ask2 = asWaiting(await script.answer(hold1.token, true));

		expect(done).toEqual([1]);

		const hold2 = asWaiting(await script.answer(ask2.token, true));
		const ask3 = asWaiting(await script.answer(hold2.token, "not #2"));

		expect(done).toEqual([1]);

		const hold3 = asWaiting(await script.answer(ask3.token, true));
		const outcome = await script.answer(hold3.token, true);

		expect(outcome).toEqual({ _tag: "Finished", result: { closed: [1, "Denied:2", 3] } });
		expect(done).toEqual([1, 3]);
	});

	test("a held write survives a new instance over the same storage", async () => {
		const { tools, done } = effects();
		const gate = (plan: Plan): Decision => (plan.tool === "close" ? { hold: "review" } : { allow: true });
		const { script, storage } = scriptWith(tools, { gate });
		const ask = asWaiting(await script.run(SOURCE));
		const hold = asWaiting(await script.answer(ask.token, true));
		const reborn = new DurableScript({ programId: "p1", storage, tools, wasm, gate });

		expect(asWaiting(await reborn.recover())).toEqual(hold);
		expect(asWaiting(await reborn.answer(hold.token, true)).name).toBe("ask");
		expect(done).toEqual([1]);
	});
});
