import { getAgentByName } from "agents";
import { Option, Result, Schema } from "effect";
import {
	answerFor,
	APPROVAL_COUNT,
	type ApprovalsResult,
	type BenchResult,
	type BenchSystem,
	DecidedJson,
	type Decision,
	expectedDecided,
	LOOP_EXPECTED,
	LOOP_LIMIT,
	LoopOutput,
	type LoopResult,
	LoopReplyJson,
	MachineReplyJson,
	percentile,
	ProgressJson,
} from "../../shared/bench";
import { AnswerOutcomeJson, Finished, isRunning, isWaiting, ProgramId, type Snapshot, SnapshotJson } from "../../shared/protocol";
import type { Program } from "../program";
import type { ApprovalsAgent } from "./agent";
import { APPROVALS_PROGRAM, LOOP_PROGRAM } from "./programs";
import type { StateMachineProgram } from "./state-machine";
import type { BenchProgress } from "./workflow";

export type BenchEnv = {
	readonly PROGRAM: DurableObjectNamespace<Program>;
	readonly STATE_MACHINE: DurableObjectNamespace<StateMachineProgram>;
	readonly APPROVALS_AGENT: DurableObjectNamespace<ApprovalsAgent>;
	readonly BENCH_PROGRESS: DurableObjectNamespace<BenchProgress>;
	readonly BENCH_WORKFLOW: Workflow;
};

const POLL_MS = 25;

const LOOP_POLL_MS = 50;

const POLL_LIMIT_MS = 120_000;

const decodeSnapshot = Schema.decodeSync(SnapshotJson);

const decodeAnswer = Schema.decodeSync(AnswerOutcomeJson);

const decodeDecided = Schema.decodeUnknownOption(DecidedJson);

const decodeMachine = Schema.decodeSync(MachineReplyJson);

const decodeLoopReply = Schema.decodeSync(LoopReplyJson);

const decodeProgress = Schema.decodeSync(ProgressJson);

const decodeLoopOutput = Schema.decodeUnknownOption(LoopOutput);

const decodeLoopSum = Schema.decodeUnknownOption(Schema.fromJsonString(LoopOutput));

const decodeWorkflowDecided = Schema.decodeUnknownOption(Schema.Struct({ decided: Schema.Array(Schema.Struct({ id: Schema.Number, ok: Schema.Boolean })) }));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sameDecisions = (actual: ReadonlyArray<Decision>): boolean => JSON.stringify(actual) === JSON.stringify(expectedDecided());

const isOdd = (id: number): boolean => id % 2 === 1;

const average = (values: ReadonlyArray<number>): number => (values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));

const round = (ms: number): number => Math.round(ms * 10) / 10;

const timed = async <A>(work: () => Promise<A>): Promise<{ readonly value: A; readonly ms: number }> => {
	const startedAt = performance.now();
	const value = await work();

	return { value, ms: round(performance.now() - startedAt) };
};

const killed = (kill: () => Promise<void>): Promise<boolean> => kill().then(
	() => false,
	() => true,
);

const pollUntil = async <A>(read: () => Promise<A>, done: (value: A) => boolean, everyMs: number): Promise<A> => {
	const deadline = Date.now() + POLL_LIMIT_MS;

	for (;;) {
		const value = await read();

		if (done(value)) return value;

		if (Date.now() > deadline) throw new Error(`gave up polling after ${POLL_LIMIT_MS} ms`);

		await sleep(everyMs);
	}
};

const approvalsResult = (resumeMs: ReadonlyArray<number>, totalMs: number, kills: number, killable: boolean, correct: boolean, bytesPerPause: number | null, objects: number | null): ApprovalsResult => ({
	answers: resumeMs.length,
	kills,
	killable,
	correct,
	resumeMs,
	p50Ms: percentile(resumeMs, 0.5),
	p95Ms: percentile(resumeMs, 0.95),
	totalMs: round(totalMs),
	bytesPerPause,
	objects,
});

const runId = (system: BenchSystem): string => `bench-${system}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

const answeredSnapshot = (text: string): Snapshot =>
	Result.match(decodeAnswer(text), {
		onSuccess: (snapshot) => snapshot,
		onFailure: (refused) => {
			throw new Error(`amber refused the answer: ${JSON.stringify(refused)}`);
		},
	});

const isFinished = Schema.is(Finished);

const finishedResult = (snapshot: Snapshot): Option.Option<string> =>
	Option.map(Option.filter(snapshot.outcome, isFinished), (outcome) => outcome.result);

const amberApprovals = async (env: BenchEnv): Promise<ApprovalsResult> => {
	const id = ProgramId.make(runId("amber"));
	const program = () => env.PROGRAM.getByName(id);
	const startedAt = performance.now();
	let current = decodeSnapshot(await program().start(id, APPROVALS_PROGRAM));
	const resumeMs: Array<number> = [];
	const pauseBytes: Array<number> = [current.deltaBytes];
	let kills = 0;

	for (let step = 0; step < APPROVAL_COUNT; step++) {
		if (isOdd(step) && (await killed(() => program().kill(id)))) kills += 1;

		const answered = await timed(() => program().answer(id, JSON.stringify(answerFor(step))));

		current = answeredSnapshot(answered.value);
		resumeMs.push(answered.ms);

		if (Option.exists(current.outcome, isWaiting)) pauseBytes.push(current.deltaBytes);
	}

	const decided = Option.flatMap(finishedResult(current), (result) => decodeDecided(result));
	const correct = Option.exists(decided, ({ decided: actual }) => sameDecisions(actual));

	return approvalsResult(resumeMs, performance.now() - startedAt, kills, true, correct, average(pauseBytes), current.objects);
};

const amberLoop = async (env: BenchEnv): Promise<LoopResult> => {
	const id = ProgramId.make(runId("amber"));
	const program = () => env.PROGRAM.getByName(id);
	const startedAt = performance.now();

	await program().start(id, LOOP_PROGRAM);

	const done = await pollUntil(
		async () => decodeSnapshot(await program().snapshot(id)),
		(snapshot) => Option.isSome(snapshot.outcome) && !Option.exists(snapshot.outcome, isRunning),
		LOOP_POLL_MS,
	);

	const wallMs = round(performance.now() - startedAt);
	const sum = Option.flatMap(finishedResult(done), (result) => decodeLoopSum(result));

	const sliceMs = done.steps.reduce((total, step) => total + step.ms, 0);

	return {
		wallMs,
		cpuMs: sliceMs > 0 ? sliceMs : null,
		correct: Option.exists(sum, (value) => value.sum === LOOP_EXPECTED),
		slices: done.totalSteps,
	};
};

type Machine = {
	readonly begin: (total: number) => Promise<string>;
	readonly answer: (ok: boolean) => Promise<string>;
	readonly loop: (limit: number) => Promise<string>;
	readonly kill: () => Promise<void>;
};

const machineApprovals = async (machine: () => Promise<Machine>): Promise<ApprovalsResult> => {
	const startedAt = performance.now();
	const begun = decodeMachine(await (await machine()).begin(APPROVAL_COUNT));
	const objects = new Set([begun.object]);
	const resumeMs: Array<number> = [];
	const pauseBytes: Array<number> = [];
	let decided: ReadonlyArray<Decision> = [];
	let kills = 0;

	for (let id = 0; id < APPROVAL_COUNT; id++) {
		if (isOdd(id) && (await killed(async () => (await machine()).kill()))) kills += 1;

		const answered = await timed(async () => decodeMachine(await (await machine()).answer(answerFor(id))));

		resumeMs.push(answered.ms);
		pauseBytes.push(answered.value.storedBytes);
		objects.add(answered.value.object);
		decided = answered.value.state.decided;
	}

	return approvalsResult(resumeMs, performance.now() - startedAt, kills, true, sameDecisions(decided), average(pauseBytes), objects.size);
};

const machineLoop = async (machine: () => Promise<Machine>): Promise<LoopResult> => {
	const ran = await timed(async () => decodeLoopReply(await (await machine()).loop(LOOP_LIMIT)));

	return { wallMs: ran.ms, cpuMs: null, correct: ran.value.sum === LOOP_EXPECTED, slices: null };
};

const stateMachine = (env: BenchEnv, name: string) => async (): Promise<Machine> => env.STATE_MACHINE.getByName(name);

const agent = (env: BenchEnv, name: string) => async (): Promise<Machine> => getAgentByName(env.APPROVALS_AGENT, name);

const workflowApprovals = async (env: BenchEnv): Promise<ApprovalsResult> => {
	const name = runId("workflows");
	const progress = () => env.BENCH_PROGRESS.getByName(name);
	const readProgress = async () => decodeProgress(await progress().read());
	const startedAt = performance.now();
	const instance = await env.BENCH_WORKFLOW.create({ id: name, params: { mode: "approvals", progress: name } });
	const resumeMs: Array<number> = [];

	for (let id = 0; id < APPROVAL_COUNT; id++) {
		await pollUntil(readProgress, (current) => current.ready === id, POLL_MS);

		const answered = await timed(async () => {
			await instance.sendEvent({ type: `answer-${id}`, payload: { ok: answerFor(id) } });

			return pollUntil(readProgress, (current) => current.recorded === id + 1, POLL_MS);
		});

		resumeMs.push(answered.ms);
	}

	const finished = await pollUntil(() => instance.status(), (status) => status.status === "complete" || status.status === "errored", POLL_MS);
	const decided = decodeWorkflowDecided(finished.output);

	return approvalsResult(resumeMs, performance.now() - startedAt, 0, false, Option.exists(decided, ({ decided: actual }) => sameDecisions(actual)), null, null);
};

const workflowLoop = async (env: BenchEnv): Promise<LoopResult> => {
	const ran = await timed(async () => {
		const instance = await env.BENCH_WORKFLOW.create({ id: runId("workflows"), params: { mode: "loop", progress: "" } });

		return pollUntil(() => instance.status(), (status) => status.status === "complete" || status.status === "errored", POLL_MS);
	});

	return { wallMs: ran.ms, cpuMs: null, correct: Option.exists(decodeLoopOutput(ran.value.output), ({ sum }) => sum === LOOP_EXPECTED), slices: null };
};

const NOTES: Readonly<Record<BenchSystem, ReadonlyArray<string>>> = {
	amber: [
		"Each answer restores base + delta into a fresh wasm instance and resumes the program at the tool() call.",
		"bytesPerPause is the stored snapshot delta. The base is rebuilt and hash-checked, never stored.",
		"Loop wall time includes a 120 ms alarm gap between slices; cpuMs is the sum of the slices' own run time.",
		"Deployed Workers do not advance Date.now() during pure compute, so slice times read 0 in production. cpuMs is then null (not measurable from inside), not 0.",
	],
	workflows: [
		"Workflows has no external kill API, so this run has no kills (killable=false).",
		"Resume latency is sendEvent until the record step marks progress, observed by polling every 25 ms, so each value can include up to 25 ms of polling delay.",
		"Stored bytes are managed by Workflows and not visible (null). Object count is not knowable.",
		"Loop wall time includes instance creation and 25 ms status polling.",
	],
	agents: ["Agent state is stored with setState; bytesPerPause is the length of that state as JSON.", "kill() calls ctx.abort(); the next call gets a new Agent instance that reloads its state."],
	"durable-object": ["A hand-written state machine: the same JSON in ctx.storage.kv.", "kill() calls ctx.abort(); the next call gets a new object that reloads its state."],
};

type Workloads = { readonly approvals: () => Promise<ApprovalsResult>; readonly loop: () => Promise<LoopResult> };

const workloads = (env: BenchEnv, system: BenchSystem): Workloads => {
	const name = runId(system);

	if (system === "amber") return { approvals: () => amberApprovals(env), loop: () => amberLoop(env) };

	if (system === "workflows") return { approvals: () => workflowApprovals(env), loop: () => workflowLoop(env) };

	if (system === "agents") return { approvals: () => machineApprovals(agent(env, name)), loop: () => machineLoop(agent(env, `${name}-loop`)) };

	return { approvals: () => machineApprovals(stateMachine(env, name)), loop: () => machineLoop(stateMachine(env, `${name}-loop`)) };
};

export const runBench = async (env: BenchEnv, system: BenchSystem): Promise<BenchResult> => {
	const work = workloads(env, system);
	const approvals = await work.approvals();
	const loop = await work.loop();

	return { system, ranAt: Date.now(), approvals, loop, notes: NOTES[system] };
};
