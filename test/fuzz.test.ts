import { writeFileSync } from "node:fs";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { type CrashPoint, DurableScript, external, memoryStorage, type Outcome, read, SimulatedCrash, write } from "../src";
import { wasm } from "./support";

const SEEDS = Number(process.env.AMBER_FUZZ_SEEDS ?? 70);

type Entry = { readonly key: string; readonly name: string; readonly args: string };

type World = { readonly log: Array<Entry>; readonly timeouts: Set<string> };

const hash = (seed: number, text: string): number => {
	let h = 2166136261 ^ seed;

	for (let index = 0; index < text.length; index++) h = Math.imul(h ^ text.charCodeAt(index), 16777619);

	return h >>> 0;
};

const mulberry = (seed: number) => {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let t = state;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const SCRIPTS = {
	approvals: `const items = tool("list", {});
const closed = [];
for (const id of items) {
  const ok = tool("ask", { id });
  if (ok) { tool("close", { id }); closed.push(id); }
}
tool("notify", { text: "closed " + closed.join(",") });
({ closed })`,
	webhook: `const results = [];
for (let pr = 0; pr < 3; pr++) {
  tool("open_pr", { pr });
  let status = "";
  try { status = tool("wait_ci", { pr }).ok ? "green" : "red"; }
  catch (e) { if (e.name !== "Timeout") throw e; status = "timeout"; tool("escalate", { pr }); }
  results.push(status);
}
({ results })`,
	loop: `let sum = 0;
for (let i = 0; i < 1000000; i++) { sum += i % 1000; if (i % 250000 === 249999) tool("checkpoint", { i, sum }); }
({ sum })`,
} as const;

type ScriptName = keyof typeof SCRIPTS;

type Crasher = { readonly hit: (point: CrashPoint | "midTool", step: number) => void; kills: number };

const crasher = (seed: number, rate: number, maxKills: number): Crasher => {
	const random = mulberry(seed);
	const state: Crasher = {
		kills: 0,
		hit: () => {
			if (state.kills < maxKills && random() < rate) {
				state.kills++;
				throw new SimulatedCrash("injected");
			}
		},
	};

	return state;
};

const toolsFor = (world: World, crash: Crasher) => {
	const effect = (name: string) => (args: unknown, context: { readonly key: string; readonly step: number }) => {
		world.log.push({ key: context.key, name, args: JSON.stringify(args) });
		crash.hit("midTool", context.step);

		return { ok: true };
	};

	return {
		list: read(Schema.Struct({}), () => [0, 1, 2, 3, 4, 5]),
		ask: external(Schema.Struct({ id: Schema.Number })),
		close: write(Schema.Struct({ id: Schema.Number }), effect("close")),
		notify: write(Schema.Struct({ text: Schema.String }), effect("notify")),
		open_pr: write(Schema.Struct({ pr: Schema.Number }), effect("open_pr")),
		wait_ci: external(Schema.Struct({ pr: Schema.Number }), { timeoutMs: 3_600_000 }),
		escalate: write(Schema.Struct({ pr: Schema.Number }), effect("escalate")),
		checkpoint: write(Schema.Struct({ i: Schema.Number, sum: Schema.Number }), effect("checkpoint")),
	};
};

type Run = { readonly outcome: Outcome; readonly world: World; readonly kills: number; readonly resumes: number };

const play = async (name: ScriptName, seed: number, rate: number): Promise<Run> => {
	const world: World = { log: [], timeouts: new Set() };
	const storage = memoryStorage();
	const clock = { now: 1_000_000 };
	const crash = crasher(hash(seed, name), rate, 25);
	const tools = toolsFor(world, crash);
	const make = () => new DurableScript({ programId: `${name}-${seed}`, storage, tools, wasm, now: () => clock.now, crash: crash.hit });
	let script = make();
	let next: () => Promise<Outcome> = () => script.run(SCRIPTS[name]);
	let resumes = 0;

	for (let guard = 0; guard < 2000; guard++) {
		let outcome: Outcome;

		try {
			outcome = await next();
		} catch (error) {
			if (!(error instanceof SimulatedCrash)) throw error;

			script = make();
			next = () => script.recover();
			resumes++;
			continue;
		}

		if (outcome._tag === "Finished" || outcome._tag === "Failed") return { outcome, world, kills: crash.kills, resumes };

		if (outcome._tag === "Running") {
			next = () => script.alarm();
			continue;
		}

		const waiting = outcome;
		const args = JSON.stringify(waiting.args);

		if (waiting.name === "wait_ci" && hash(seed, args) % 3 === 0 && waiting.deadline !== null) {
			const deadline = waiting.deadline;

			clock.now = deadline + 1;
			world.timeouts.add(waiting.token);
			next = () => script.alarm();
			continue;
		}

		const answer = waiting.name === "ask" ? hash(seed, args) % 2 === 0 : { ok: hash(seed, args) % 2 === 0 };

		next = () => script.answer(waiting.token, answer);
	}

	throw new Error(`${name} seed ${seed} did not finish`);
};

const byKey = (log: ReadonlyArray<Entry>): Map<string, Entry> => new Map(log.map((entry) => [entry.key, entry]));

test(`kill fuzz: ${SEEDS} seeds x 3 scripts, crashes at every boundary and mid-tool`, async () => {
	const report = { runs: 0, timeouts: 0, kills: 0, recoveries: 0, repeatedWrites: 0, conflictingRepeats: 0, mismatches: [] as Array<string>, byScript: {} as Record<string, { runs: number; kills: number }> };

	for (const name of Object.keys(SCRIPTS) as Array<ScriptName>) {
		report.byScript[name] = { runs: 0, kills: 0 };

		for (let seed = 1; seed <= SEEDS; seed++) {
			const clean = await play(name, seed, 0);
			const killed = await play(name, seed, 0.18);
			const cleanKeys = byKey(clean.world.log);
			const killedKeys = byKey(killed.world.log);
			const label = `${name}#${seed}`;

			report.runs++;
			report.timeouts += killed.world.timeouts.size;
			report.kills += killed.kills;
			report.recoveries += killed.resumes;
			report.byScript[name].runs++;
			report.byScript[name].kills += killed.kills;
			report.repeatedWrites += killed.world.log.length - killedKeys.size;

			for (const entry of killed.world.log) if (killedKeys.get(entry.key)?.args !== entry.args) report.conflictingRepeats++;

			if (JSON.stringify(clean.outcome) !== JSON.stringify(killed.outcome)) report.mismatches.push(`${label} outcome ${JSON.stringify(clean.outcome)} vs ${JSON.stringify(killed.outcome)}`);

			if (JSON.stringify([...cleanKeys.entries()]) !== JSON.stringify([...killedKeys.entries()])) report.mismatches.push(`${label} writes differ`);

			if (clean.world.timeouts.size !== killed.world.timeouts.size) report.mismatches.push(`${label} timeouts ${clean.world.timeouts.size} vs ${killed.world.timeouts.size}`);

			if (clean.outcome._tag !== "Finished") report.mismatches.push(`${label} clean run did not finish: ${JSON.stringify(clean.outcome)}`);
		}
	}

	writeFileSync(new URL("./fuzz-report.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report));

	expect(report.mismatches).toEqual([]);
	expect(report.conflictingRepeats).toBe(0);
	expect(report.runs).toBeGreaterThanOrEqual(200);
	expect(report.kills).toBeGreaterThan(report.runs);
});
