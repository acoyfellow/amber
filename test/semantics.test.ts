import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { DurableScript, EngineMismatch, external, memoryStorage, NotWaiting, read, StaleToken, write, WritesRefused, type Outcome, type Waiting } from "../src";
import { scriptWith, wasm } from "./support";

const Id = Schema.Struct({ id: Schema.Number });

const asWaiting = (outcome: Outcome): Waiting => {
	if (outcome._tag !== "Waiting") throw new Error(`expected Waiting, got ${JSON.stringify(outcome)}`);

	return outcome;
};

describe("read tools", () => {
	test("run in the same request and write no snapshot", async () => {
		const { script, storage } = scriptWith({ double: read(Schema.Struct({ n: Schema.Number }), ({ n }) => n * 2) });
		const outcome = await script.run(`const a = tool("double", { n: 2 }); const b = tool("double", { n: a }); ({ b })`);

		expect(outcome).toEqual({ _tag: "Finished", result: { b: 8 } });
		expect(storage.keys("snap:")).toEqual([]);
	});

	test("a thrown error lands in the script as a catchable Error", async () => {
		const { script } = scriptWith({ boom: read(Schema.Struct({}), () => { throw new Error("nope"); }) });
		const outcome = await script.run(`let m = ""; try { tool("boom", {}); } catch (e) { m = e.name + ":" + e.message; } ({ m })`);

		expect(outcome).toEqual({ _tag: "Finished", result: { m: "Error:nope" } });
	});
});

describe("argument validation", () => {
	test("bad arguments throw InvalidArguments into the script before the tool runs", async () => {
		let calls = 0;
		const { script } = scriptWith({ close: write(Id, () => { calls++; }) });
		const outcome = await script.run(`let n = ""; try { tool("close", { id: "seven" }); } catch (e) { n = e.name; } ({ n })`);

		expect(outcome).toEqual({ _tag: "Finished", result: { n: "InvalidArguments" } });
		expect(calls).toBe(0);
	});

	test("an unknown tool throws ToolNotFound", async () => {
		const { script } = scriptWith({});
		const outcome = await script.run(`let n = ""; try { tool("nope", {}); } catch (e) { n = e.name; } ({ n })`);

		expect(outcome).toEqual({ _tag: "Finished", result: { n: "ToolNotFound" } });
	});
});

describe("write tools", () => {
	test("snapshot before running and get a stable idempotency key", async () => {
		const keys: Array<string> = [];
		const { script } = scriptWith({ close: write(Id, ({ id }, { key }) => { keys.push(key); return id; }) });
		const outcome = await script.run(`const a = tool("close", { id: 1 }); const b = tool("close", { id: 2 }); ({ a, b })`);

		expect(outcome).toEqual({ _tag: "Finished", result: { a: 1, b: 2 } });
		expect(keys).toEqual(["p1:1", "p1:2"]);
	});
});

describe("external tools", () => {
	test("pause with a token, and answering resumes at the same line", async () => {
		const { script, storage } = scriptWith({ ask: external(Schema.Struct({ q: Schema.String })) });
		const waiting = asWaiting(await script.run(`const xs = []; for (let i = 0; i < 2; i++) xs.push(tool("ask", { q: "q" + i })); ({ xs })`));

		expect(waiting.args).toEqual({ q: "q0" });
		expect(storage.keys("snap:").length).toBeGreaterThan(0);

		const next = asWaiting(await script.answer(waiting.token, "a"));

		expect(next.args).toEqual({ q: "q1" });
		expect(await script.answer(next.token, "b")).toEqual({ _tag: "Finished", result: { xs: ["a", "b"] } });
	});

	test("a stale token is refused, and so is answering a finished program", async () => {
		const { script } = scriptWith({ ask: external(Schema.Struct({})) });
		const first = asWaiting(await script.run(`tool("ask", {}); tool("ask", {}); 1`));
		const second = asWaiting(await script.answer(first.token, 1));

		await expect(script.answer(first.token, 1)).rejects.toBeInstanceOf(StaleToken);
		await script.answer(second.token, 1);
		await expect(script.answer(second.token, 1)).rejects.toBeInstanceOf(NotWaiting);
	});

	test("a timeout fires through the alarm and throws Timeout into the script", async () => {
		const { script, storage, clock } = scriptWith({ wait: external(Schema.Struct({}), { timeoutMs: 60_000 }) });
		const waiting = asWaiting(await script.run(`let r = "answered"; try { tool("wait", {}); } catch (e) { r = e.name; } ({ r })`));

		expect(storage.alarm()).toBe(waiting.deadline);
		expect(await script.alarm()).toEqual(waiting);
		clock.now += 60_001;
		expect(await script.alarm()).toEqual({ _tag: "Finished", result: { r: "Timeout" } });
	});
});

describe("a new instance over the same storage", () => {
	test("resumes a waiting program, like a new Durable Object after ctx.abort()", async () => {
		const tools = { ask: external(Schema.Struct({})) };
		const { script, storage } = scriptWith(tools);
		const waiting = asWaiting(await script.run(`let n = 0; const add = () => ++n; add(); const k = tool("ask", {}); add(); ({ n, k })`));
		const reborn = new DurableScript({ programId: "p1", storage, tools, wasm });

		expect(await reborn.answer(waiting.token, "x")).toEqual({ _tag: "Finished", result: { n: 2, k: "x" } });
	});
});

describe("long synchronous loops", () => {
	test("are sliced by the tick budget and continued by alarms", async () => {
		const { script } = scriptWith({});
		let outcome = await script.run(`let s = 0; for (let i = 0; i < 2000000; i++) s += i % 7; ({ s })`);
		let slices = 0;

		while (outcome._tag === "Running") {
			slices++;
			outcome = await script.alarm();
		}

		let expected = 0;

		for (let index = 0; index < 2_000_000; index++) expected += index % 7;

		expect(outcome).toEqual({ _tag: "Finished", result: { s: expected } });
		expect(slices).toBeGreaterThan(1);
	});
});

describe("engine pinning", () => {
	test("a program stored by another engine build is refused with EngineMismatch", async () => {
		const { script, storage } = scriptWith({ ask: external(Schema.Struct({})) });
		const waiting = asWaiting(await script.run(`tool("ask", {})`));
		const meta = JSON.parse(String(storage.get("meta")));

		storage.put("meta", JSON.stringify({ ...meta, baseSha: "0".repeat(64) }));
		await expect(script.answer(waiting.token, 1)).rejects.toBeInstanceOf(EngineMismatch);
	});
});

describe("snapshot size", () => {
	const hoard = `const xs = []; for (let i = 0; i < 4000; i++) xs.push("item-" + i + "-".repeat(40)); const k = tool("ask", {}); ({ n: xs.length, k })`;

	test("a large heap is split across chunks and restores", async () => {
		const { script, storage } = scriptWith({ ask: external(Schema.Struct({})) }, { chunkBytes: 16 * 1024 });
		const waiting = asWaiting(await script.run(hoard));

		expect(storage.keys("snap:").length).toBeGreaterThan(3);
		expect(await script.answer(waiting.token, "ok")).toEqual({ _tag: "Finished", result: { n: 4000, k: "ok" } });
	});

	test("past the cap the program fails loudly with SnapshotTooLarge", async () => {
		const { script } = scriptWith({ ask: external(Schema.Struct({})) }, { maxSnapshotBytes: 32 * 1024 });
		const outcome = await script.run(hoard);

		expect(outcome).toMatchObject({ _tag: "Failed", error: "SnapshotTooLarge" });
	});
});

describe("fork", () => {
	const source = `const first = tool("ask", { q: "pick" }); const roll = Math.random(); const second = tool("ask", { q: "again" }); ({ first, second, roll })`;

	const waitingSource = async () => {
		const tools = { ask: external(Schema.Struct({ q: Schema.String })) };
		const { script } = scriptWith(tools);
		const waiting = asWaiting(await script.run(source));

		return { tools, waiting, exported: script.exportSnapshot() };
	};

	test("five forks from one snapshot diverge with their answers", async () => {
		const { tools, waiting, exported } = await waitingSource();
		const results = await Promise.all(
			["a", "b", "c", "d", "e"].map(async (answer, index) => {
				const fork = DurableScript.fork(exported, { programId: `fork-${index}`, storage: memoryStorage(), tools, wasm });
				const next = asWaiting(await fork.answer(waiting.token, answer));
				const done = await fork.answer(next.token, answer.toUpperCase());

				return done._tag === "Finished" ? done.result : done;
			}),
		);

		expect(results.map((result) => (result as { first: string }).first)).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("forks refuse write tools unless allowWrites is set", async () => {
		const { exported } = await waitingSource();
		const tools = { ask: external(Schema.Struct({ q: Schema.String })), close: write(Id, () => undefined) };

		expect(() => DurableScript.fork(exported, { programId: "f", storage: memoryStorage(), tools, wasm })).toThrow(WritesRefused);
		expect(() => DurableScript.fork(exported, { programId: "f", storage: memoryStorage(), tools, wasm, allowWrites: true })).not.toThrow();
	});

	test("without reseed forks draw the same Math.random; with reseed they differ", async () => {
		const { tools, waiting, exported } = await waitingSource();
		const roll = async (programId: string, reseed?: number) => {
			const fork = DurableScript.fork(exported, { programId, storage: memoryStorage(), tools, wasm, ...(reseed === undefined ? {} : { reseed }) });
			const next = asWaiting(await fork.answer(waiting.token, "x"));
			const done = await fork.answer(next.token, "y");

			return (done as { result: { roll: number } }).result.roll;
		};

		expect(await roll("same-1")).toBe(await roll("same-2"));
		expect(await roll("seed-1", 11)).not.toBe(await roll("seed-2", 99));
	});
});
