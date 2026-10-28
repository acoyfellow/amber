import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const PORT = Number(process.env.PORT ?? 8799);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STATE = "site/.wrangler/e2e-state";
const program = (name) => readFileSync(new URL(`../programs/${name}.ts`, import.meta.url), "utf8");

let server = null;
let boots = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const up = async () => {
	boots += 1;
	server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", STATE, "-c", "site/wrangler.jsonc"], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
	});
	let log = "";
	server.stdout.on("data", (chunk) => (log += chunk));
	server.stderr.on("data", (chunk) => (log += chunk));
	for (let attempt = 0; attempt < 120; attempt++) {
		const ready = await fetch(`${ORIGIN}/api/`).then((response) => response.status === 404, () => false);
		if (ready) return;
		await sleep(500);
	}
	throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
};

const down = async () => {
	if (server === null) return;
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {}
	server = null;
	await sleep(800);
};

const api = async (path, body, method = "POST") => {
	const response = await fetch(`${ORIGIN}/api/p/${path}`, { method, body });
	return { status: response.status, body: await response.json() };
};

const state = (id) => api(id, undefined, "GET").then((reply) => reply.body);

const outcome = (snapshot) => snapshot.outcome;

const show = (label, snapshot) => {
	const step = snapshot.steps.at(-1);
	const value = snapshot.outcome?._tag === "Waiting" ? `${snapshot.outcome.call.name} ${snapshot.outcome.call.args}` : JSON.stringify(snapshot.outcome).slice(0, 80);
	console.log(`  ${label.padEnd(18)} ${String(snapshot.outcome?._tag).padEnd(9)} ${value.slice(0, 70).padEnd(72)} delta=${step?.deltaBytes}B obj=${step?.object} ${step?.ms}ms`);
	for (const line of step?.logs ?? []) console.log(`${"".padEnd(22)}[script] ${line}`);
};

rmSync(STATE, { recursive: true, force: true });
mkdirSync("site/.wrangler", { recursive: true });

try {
	console.log("== approvals.ts: tool() calls, with workerd SIGKILLed and ctx.abort() between steps");
	await up();
	let snap = (await api("e2e-approvals/start", program("approvals"))).body;
	show("start", snap);
	assert.equal(outcome(snap)._tag, "Waiting");
	assert.equal(outcome(snap).call.name, "gh.list_issues");

	await down();
	await up();
	snap = (await api("e2e-approvals/answer", JSON.stringify([{ id: 41, title: "desk card flicker", labels: [] }, { id: 42, title: "dup recipe", labels: ["bug"] }]))).body;
	show("answer(issues)", snap);
	assert.equal(outcome(snap).call.name, "ask_user");
	assert.match(outcome(snap).call.args, /#41/);

	const killed = await api("e2e-approvals/kill");
	assert.equal(killed.body.killed, true);
	snap = (await api("e2e-approvals/answer", "true")).body;
	show("answer(true)", snap);
	assert.match(outcome(snap).call.args, /#42/);

	snap = (await api("e2e-approvals/answer", "false")).body;
	show("answer(false)", snap);
	assert.equal(outcome(snap)._tag, "Finished");
	assert.deepEqual(JSON.parse(outcome(snap).result).decided, [
		{ id: 41, action: "close" },
		{ id: 42, action: "triage" },
	]);
	assert.equal(snap.kills.length, 1);
	assert.ok(snap.objects >= 3, `expected at least 3 Durable Object instances, got ${snap.objects}`);
	console.log(`  -> finished across ${snap.objects} Durable Object instances, ${snap.kills.length} ctx.abort(), 1 workerd SIGKILL`);

	const late = await api("e2e-approvals/answer", "true");
	assert.equal(late.status, 409);
	assert.equal(JSON.parse(late.body.error)._tag, "NotWaiting");
	console.log("  -> answering a finished program is refused: NotWaiting");

	const bad = await api("e2e-approvals/start", "const x: number = ;");
	assert.equal(outcome(bad.body)._tag, "Failed");
	console.log(`  -> a syntax error is a Failed outcome: ${outcome(bad.body).reason.split("\n")[0]}`);

	console.log("\n== loop.ts: a CPU-bound loop, sliced by a tick budget and continued by alarms; workerd SIGKILLed mid-run");
	snap = (await api("e2e-loop/start", program("loop"))).body;
	show("start", snap);
	assert.equal(outcome(snap)._tag, "Running");
	for (let wait = 0; wait < 40 && (await state("e2e-loop")).totalSteps < 6; wait++) await sleep(100);
	const before = await state("e2e-loop");
	assert.equal(outcome(before)._tag, "Running", "the loop finished before the kill; widen the slice gap");
	await down();
	console.log(`  workerd SIGKILLed at step ${before.totalSteps}`);
	await up();
	for (let wait = 0; wait < 240; wait++) {
		snap = await state("e2e-loop");
		if (outcome(snap)._tag !== "Running") break;
		await sleep(250);
	}
	show("final", snap);
	assert.equal(outcome(snap)._tag, "Finished");
	let sum = 0n;
	for (let index = 0; index < 3_000_000; index++) sum += BigInt(index % 1000);
	assert.equal(JSON.parse(outcome(snap).result).sum, sum.toString());
	assert.ok(snap.totalSteps > before.totalSteps);
	console.log(`  -> ${snap.totalSteps} slices across ${snap.objects} Durable Object instances; sum ${sum} matches V8`);

	console.log(`\nworkerd processes started: ${boots}`);
	console.log("e2e passed");
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await down();
}
