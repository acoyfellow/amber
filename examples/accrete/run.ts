import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { type CrashPoint, DurableScript, external, memoryStorage, type Outcome, read, SimulatedCrash, write } from "../../src";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const wasm = new Module(readFileSync(fileURLToPath(new URL("../../engine/dq.wasm", import.meta.url))));

const ACCRETE_URL = process.env.ACCRETE_URL ?? "http://127.0.0.1:8799";

const ACCRETE_TOKEN = process.env.ACCRETE_TOKEN ?? "local-dev";

const WORKSPACE = `amber-demo-${Date.now()}`;

const SEED: Record<string, string> = {
	"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", lib: ["es2022"], noEmit: true }, include: ["src"] }),
	"src/total.ts": [
		"export type Line = { readonly sku: string; readonly qty: number; readonly cents: number };",
		"",
		"export const total = (lines: ReadonlyArray<Line>): number => lines.reduce((sum, line) => sum + line.qty * line.cents, 0);",
		"",
		'export const label = (lines: ReadonlyArray<Line>): string => "$" + (total(lines) / 100).toFixed(2);',
		"",
		'export const checkout = (lines: ReadonlyArray<Line>): number => label(lines) + 0;',
		"",
	].join("\n"),
};

const SCRIPT = `
const before = tool("tsc", {});
if (before.clean) throw new Error("expected a type error to fix");

const file = "src/total.ts";
const source = tool("read_file", { path: file });
const broken = "export const checkout = (lines: ReadonlyArray<Line>): number => label(lines) + 0;";
const fixed = "export const checkout = (lines: ReadonlyArray<Line>): number => total(lines);";
if (source.indexOf(broken) < 0) throw new Error("the broken line moved");

tool("write_file", { path: file, content: source.replace(broken, fixed) });

const after = tool("tsc", {});
const approved = tool("ask_human", { question: "tsc is " + (after.clean ? "clean" : "still failing") + ". Apply this patch?", before: before.stdout, after: after.stdout });

if (approved && after.clean) tool("apply_patch", { path: file });

({ errorsBefore: before.errors, cleanAfter: after.clean, approved, applied: approved && after.clean })
`;

type Call = { readonly name: string; readonly key: string; readonly ms: number; readonly containerSeconds: number };

type Ledger = { readonly calls: Array<Call>; readonly applied: Array<{ readonly key: string; readonly sha: string }>; readonly files: Map<string, string>; readonly seen: Map<string, unknown> };

type TaskLog = { readonly op: string; readonly placement: string; readonly containerSeconds: number; readonly ok?: boolean; readonly error?: string; readonly tool?: string; readonly stdout?: string };

type TaskResult = { readonly logs: ReadonlyArray<TaskLog>; readonly files: Readonly<Record<string, string>>; readonly stdout?: string };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const task = async (steps: ReadonlyArray<Record<string, unknown>>, files: ReadonlyMap<string, string>): Promise<TaskResult> => {
	const response = await fetch(`${ACCRETE_URL}/task`, {
		method: "POST",
		headers: { authorization: `Bearer ${ACCRETE_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ workspace: WORKSPACE, seed: Object.fromEntries(files), steps }),
	});

	if (!response.ok) throw new Error(`accrete ${response.status}: ${await response.text()}`);

	return (await response.json()) as TaskResult;
};

const tscIn = async (ledger: Ledger, key: string) => {
	const started = Date.now();
	const result = await task([{ op: "tool", name: "tsc", args: ["-p", "tsconfig.json"], inputs: Array.from(ledger.files.keys()), stdoutTo: "tsc.out" }], ledger.files);
	const log = result.logs[0];

	if (log === undefined || log.ok === false) throw new Error(`tsc failed to run: ${log?.error ?? "no log"}`);

	const stdout = result.files["tsc.out"] ?? "";
	const errors = (stdout.match(/error TS\d+/g) ?? []).length;

	ledger.calls.push({ name: "tsc", key, ms: Date.now() - started, containerSeconds: log.containerSeconds });

	return { clean: errors === 0, errors, stdout: stdout.trim(), tool: log.tool ?? "", placement: log.placement };
};

const toolsFor = (ledger: Ledger, crash: (point: CrashPoint | "midTool", step: number) => void) => ({
	tsc: read(Schema.Struct({}), (_args, context) => tscIn(ledger, context.key)),
	read_file: read(Schema.Struct({ path: Schema.String }), ({ path }) => {
		const content = ledger.files.get(path);

		if (content === undefined) throw new Error(`no such file: ${path}`);

		return content;
	}),
	write_file: write(Schema.Struct({ path: Schema.String, content: Schema.String }), ({ path, content }, context) => {
		ledger.calls.push({ name: "write_file", key: context.key, ms: 0, containerSeconds: 0 });

		if (!ledger.seen.has(context.key)) {
			ledger.files.set(path, content);
			ledger.seen.set(context.key, { sha: sha(content) });
		}

		crash("midTool", context.step);

		return ledger.seen.get(context.key);
	}),
	ask_human: external(Schema.Struct({ question: Schema.String, before: Schema.String, after: Schema.String })),
	apply_patch: write(Schema.Struct({ path: Schema.String }), ({ path }, context) => {
		const content = ledger.files.get(path) ?? "";

		ledger.calls.push({ name: "apply_patch", key: context.key, ms: 0, containerSeconds: 0 });

		if (!ledger.seen.has(context.key)) {
			ledger.applied.push({ key: context.key, sha: sha(content) });
			ledger.seen.set(context.key, { applied: path });
		}

		crash("midTool", context.step);

		return ledger.seen.get(context.key);
	}),
});

type Plan = { readonly label: string; readonly killAt: ReadonlySet<string>; readonly random?: () => boolean };

const play = async (plan: Plan) => {
	const ledger: Ledger = { calls: [], applied: [], files: new Map(Object.entries(SEED)), seen: new Map() };
	const storage = memoryStorage();
	const remaining = new Set(plan.killAt);
	const kills: Array<string> = [];
	const crash = (point: CrashPoint | "midTool", step: number) => {
		const at = `${point}@${step}`;

		if (remaining.delete(at) || (plan.random !== undefined && kills.length < 12 && plan.random())) {
			kills.push(at);
			throw new SimulatedCrash(at);
		}
	};
	const make = () => new DurableScript({ programId: `accrete-${plan.label}`, storage, tools: toolsFor(ledger, crash), wasm, crash });
	const question: Array<string> = [];
	let script = make();
	let next: () => Promise<Outcome> = () => script.run(SCRIPT);
	let instances = 1;
	const started = Date.now();

	for (let guard = 0; guard < 100; guard++) {
		let outcome: Outcome;

		try {
			outcome = await next();
		} catch (error) {
			if (!(error instanceof SimulatedCrash)) throw error;

			script = make();
			instances++;
			next = () => script.recover();
			continue;
		}

		if (outcome._tag === "Running") {
			next = () => script.alarm();
			continue;
		}

		if (outcome._tag === "Waiting") {
			const waiting = outcome;

			question.push(JSON.stringify(waiting.args));
			next = () => script.answer(waiting.token, true);
			continue;
		}

		return { label: plan.label, outcome, kills, instances, ms: Date.now() - started, ledger, question: question[0] ?? "" };
	}

	throw new Error(`${plan.label} did not finish`);
};

const PLANS: ReadonlyArray<Plan> = [
	{ label: "clean", killAt: new Set() },
	{ label: "killed", killAt: new Set(["afterResult@1", "midTool@3", "afterEffect@3", "waiting@5", "midTool@6", "afterResult@6"]) },
];

const summarize = (run: Awaited<ReturnType<typeof play>>) => {
	const writes = run.ledger.calls.filter((call) => call.name !== "tsc");
	const keys = writes.map((call) => call.key);
	const tscCalls = run.ledger.calls.filter((call) => call.name === "tsc");

	return {
		run: run.label,
		outcome: run.outcome._tag,
		result: run.outcome._tag === "Finished" ? run.outcome.result : run.outcome,
		kills: run.kills,
		durableObjectInstances: run.instances,
		tscCalls: tscCalls.map((call) => ({ ms: call.ms, containerSeconds: call.containerSeconds })),
		writeDeliveries: writes.map((call) => call.name),
		distinctWriteKeys: new Set(keys).size,
		writeEffects: run.ledger.seen.size,
		appliedPatches: run.ledger.applied.map((entry) => entry.sha),
		finalFileSha: sha(run.ledger.files.get("src/total.ts") ?? ""),
		containerSeconds: run.ledger.calls.reduce((sum, call) => sum + call.containerSeconds, 0),
		ms: run.ms,
	};
};

const mulberry = (seed: number) => {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let t = state;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < 0.3;
	};
};

const SWEEP_SEEDS = Number(process.env.SWEEP_SEEDS ?? 40);

const sweep = async (reference: string) => {
	const rows = [];

	for (let seed = 1; seed <= SWEEP_SEEDS; seed++) rows.push(summarize(await play({ label: `sweep-${seed}`, killAt: new Set(), random: mulberry(seed) })));

	return {
		seeds: rows.length,
		finished: rows.filter((row) => row.outcome === "Finished").length,
		totalKills: rows.reduce((sum, row) => sum + row.kills.length, 0),
		maxKillsInOneRun: Math.max(...rows.map((row) => row.kills.length)),
		samePatchAsClean: rows.filter((row) => row.finalFileSha === reference).length,
		appliedExactlyOnce: rows.filter((row) => row.appliedPatches.length === 1).length,
		extraWriteDeliveries: rows.reduce((sum, row) => sum + row.writeDeliveries.length - row.distinctWriteKeys, 0),
		duplicateEffects: rows.reduce((sum, row) => sum + row.writeEffects - row.distinctWriteKeys, 0),
		tscCalls: rows.reduce((sum, row) => sum + row.tscCalls.length, 0),
		containerSeconds: rows.reduce((sum, row) => sum + row.containerSeconds, 0),
		tscMedianMs: median(rows.flatMap((row) => row.tscCalls.map((call) => call.ms))),
	};
};

const median = (values: ReadonlyArray<number>): number => {
	const sorted = [...values].sort((a, b) => a - b);

	return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const main = async () => {
	const runs = [];

	for (const plan of PLANS) runs.push(await play(plan));

	const [clean, killed] = runs.map(summarize);

	if (clean === undefined || killed === undefined) throw new Error("missing run");

	const firstTsc = runs[0]?.ledger.calls.find((call) => call.name === "tsc");
	const receipt = {
		kind: "amber-accrete-demo",
		at: new Date().toISOString(),
		accrete: ACCRETE_URL,
		workspace: WORKSPACE,
		question: runs[0]?.question,
		clean,
		killed,
		samePatch: clean.finalFileSha === killed.finalFileSha && JSON.stringify(clean.appliedPatches) === JSON.stringify(killed.appliedPatches),
		appliedOnceEach: clean.appliedPatches.length === 1 && killed.appliedPatches.length === 1,
		firstTscKey: firstTsc?.key,
		sweep: await sweep(clean.finalFileSha),
	};
	const out = fileURLToPath(new URL("./receipt.json", import.meta.url));

	mkdirSync(fileURLToPath(new URL(".", import.meta.url)), { recursive: true });
	writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
	console.log(JSON.stringify(receipt, null, 2));
};

await main();
