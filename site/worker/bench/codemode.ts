import { Option, Result, Schema } from "effect";
import {
	approveIssue,
	type CodemodeResult,
	type CodemodeRow,
	type CodemodeSystem,
	type CodemodeVariant,
	EXPECTED_CLOSED,
	ISSUE_IDS,
	type LoaderReply,
	ReplayReplyJson,
	RunIdArgsJson,
	ScriptOutputJson,
} from "../../shared/codemode";
import { percentile } from "../../shared/bench";
import { AnswerOutcomeJson, Finished, Failed, ProgramId, type Snapshot, SnapshotJson, Waiting } from "../../shared/protocol";
import type { Program } from "../program";
import { DETERMINISTIC_SCRIPT, LLM_SCRIPT } from "./codemode-scripts";
import type { ReplayRunner } from "./replay";

export type CodemodeEnv = { readonly PROGRAM: DurableObjectNamespace<Program>; readonly REPLAY: DurableObjectNamespace<ReplayRunner> };

const decodeSnapshot = Schema.decodeSync(SnapshotJson);

const decodeAnswer = Schema.decodeSync(AnswerOutcomeJson);

const decodeReplay = Schema.decodeSync(ReplayReplyJson);

const decodeArgs = Schema.decodeUnknownOption(RunIdArgsJson);

const decodeOutput = Schema.decodeUnknownOption(ScriptOutputJson);

const isWaiting = Schema.is(Waiting);

const isFinished = Schema.is(Finished);

const isFailed = Schema.is(Failed);

const MAX_PAUSES = 40;

const scriptFor = (variant: CodemodeVariant): string => (variant === "llm" ? LLM_SCRIPT : DETERMINISTIC_SCRIPT);

const round = (ms: number): number => Math.round(ms * 10) / 10;

class World {
	private asks = 0;

	readonly closed: Array<number> = [];

	readonly runIds = new Set<string>();

	answer(name: string, args: string): string {
		Option.map(
			Option.flatMap(decodeArgs(args), (decoded) => Option.fromNullishOr(decoded.runId)),
			(runId) => this.runIds.add(runId),
		);

		if (name === "list_issues") return JSON.stringify(ISSUE_IDS.map((id) => ({ id })));

		if (name === "ask_human") {
			const ok = approveIssue(this.asks);

			this.asks += 1;

			return JSON.stringify(ok);
		}

		if (name === "close_issue") {
			Option.map(
				Option.flatMap(decodeArgs(args), (decoded) => Option.fromNullishOr(decoded.id)),
				(id) => this.closed.push(id),
			);

			return "true";
		}

		return "null";
	}

	get humanAnswers(): number {
		return this.asks;
	}
}

type Tally = {
	readonly resumeMs: Array<number>;
	readonly pauseBytes: Array<number>;
	kills: number;
};

const killed = (kill: () => Promise<void>): Promise<boolean> =>
	kill().then(
		() => false,
		() => true,
	);

const average = (values: ReadonlyArray<number>): number | null => (values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));

type Ending = {
	readonly outcome: CodemodeRow["outcome"];
	readonly value: Option.Option<string>;
	readonly divergedAt: number | null;
	readonly reason: string | null;
	readonly scriptRuns: number;
	readonly replayedCalls: number;
};

const rowOf = (system: CodemodeSystem, variant: CodemodeVariant, world: World, tally: Tally, ending: Ending, totalMs: number): CodemodeRow => {
	const output = Option.flatMap(ending.value, (value) => decodeOutput(value));
	const outputRunId = Option.flatMap(output, (decoded) => Option.fromNullishOr(decoded.runId));
	const runIds = new Set(world.runIds);

	Option.map(outputRunId, (runId) => runIds.add(runId));

	const closedRight = JSON.stringify(world.closed) === JSON.stringify(EXPECTED_CLOSED) && Option.exists(output, (decoded) => JSON.stringify(decoded.closed) === JSON.stringify(EXPECTED_CLOSED));

	return {
		system,
		variant,
		outcome: ending.outcome,
		completed: ending.outcome === "finished" && closedRight,
		consistent: ending.outcome === "finished" && runIds.size <= 1,
		divergedAt: ending.divergedAt,
		closed: world.closed,
		answers: world.humanAnswers,
		kills: tally.kills,
		resumeMs: tally.resumeMs,
		p50Ms: tally.resumeMs.length === 0 ? null : percentile(tally.resumeMs, 0.5),
		p95Ms: tally.resumeMs.length === 0 ? null : percentile(tally.resumeMs, 0.95),
		totalMs: round(totalMs),
		scriptRuns: ending.scriptRuns,
		replayedCalls: ending.replayedCalls,
		sideEffects: world.closed.length,
		bytesPerPause: average(tally.pauseBytes),
		reason: ending.reason,
	};
};

const wrapped = (script: string): string => `(() => {\n${script}\n})();`;

const runDquickts = async (env: CodemodeEnv, variant: CodemodeVariant): Promise<CodemodeRow> => {
	const id = ProgramId.make(`codemode-${variant}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`);
	const program = () => env.PROGRAM.getByName(id);
	const world = new World();
	const tally: Tally = { resumeMs: [], pauseBytes: [], kills: 0 };
	const startedAt = performance.now();
	let current: Snapshot = decodeSnapshot(await program().start(id, wrapped(scriptFor(variant))));

	for (let pause = 0; pause < MAX_PAUSES; pause++) {
		const waiting = Option.filter(current.outcome, isWaiting);

		if (Option.isNone(waiting)) break;

		tally.pauseBytes.push(current.deltaBytes);

		const answer = world.answer(waiting.value.call.name, waiting.value.call.args);

		if (pause % 2 === 1 && (await killed(() => program().kill(id)))) tally.kills += 1;

		const resumedAt = performance.now();
		const answered = decodeAnswer(await program().answer(id, answer));

		tally.resumeMs.push(round(performance.now() - resumedAt));
		current = Result.match(answered, {
			onSuccess: (snapshot) => snapshot,
			onFailure: (refused) => {
				throw new Error(`amber refused the answer: ${JSON.stringify(refused)}`);
			},
		});
	}

	const finished = Option.filter(current.outcome, isFinished);
	const failed = Option.filter(current.outcome, isFailed);

	return rowOf(
		"amber",
		variant,
		world,
		tally,
		{
			outcome: Option.isSome(finished) ? "finished" : "failed",
			value: Option.map(finished, (outcome) => outcome.result),
			divergedAt: null,
			reason: Option.getOrNull(Option.map(failed, (outcome) => outcome.reason)),
			scriptRuns: 1,
			replayedCalls: 0,
		},
		performance.now() - startedAt,
	);
};

const endingOf = (step: LoaderReply, scriptRuns: number, replayedCalls: number): Ending => {
	if (step.kind === "done") return { outcome: "finished", value: Option.fromNullishOr(step.value), divergedAt: null, reason: null, scriptRuns, replayedCalls };

	if (step.kind === "diverged") return { outcome: "diverged", value: Option.none(), divergedAt: step.at, reason: `re-run asked for a different tool call at journal entry ${step.at}`, scriptRuns, replayedCalls };

	return { outcome: "failed", value: Option.none(), divergedAt: null, reason: step.reason ?? `stopped while ${step.kind}`, scriptRuns, replayedCalls };
};

const runReplay = async (env: CodemodeEnv, variant: CodemodeVariant, strict: boolean): Promise<CodemodeRow> => {
	const system: CodemodeSystem = strict ? "replay-strict" : "replay-lenient";
	const name = `codemode-${system}-${variant}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
	const runner = () => env.REPLAY.getByName(name);
	const world = new World();
	const tally: Tally = { resumeMs: [], pauseBytes: [], kills: 0 };
	const startedAt = performance.now();
	let current = decodeReplay(await runner().begin(scriptFor(variant), strict));

	for (let pause = 0; pause < MAX_PAUSES && current.step.kind === "pause"; pause++) {
		tally.pauseBytes.push(current.storedBytes);

		const answer = world.answer(current.step.name ?? "", current.step.args ?? "null");

		if (pause % 2 === 1 && (await killed(() => runner().kill()))) tally.kills += 1;

		const resumedAt = performance.now();

		current = decodeReplay(await runner().answer(answer));
		tally.resumeMs.push(round(performance.now() - resumedAt));
	}

	return rowOf(system, variant, world, tally, endingOf(current.step, current.scriptRuns, current.replayedCalls), performance.now() - startedAt);
};

const NOTES: ReadonlyArray<string> = [
	"The workload is one script an LLM could write at runtime: list issues, ask a human about each one, close the approved ones. Every tool() call pauses for an answer from outside.",
	"Each system is killed (ctx.abort) before every second answer.",
	"amber runs the script once. The paused program, heap and call stack included, is stored and resumed. Nothing re-runs.",
	"Replay is how durable execution works without a snapshotting engine: the script runs in a Dynamic Worker (Worker Loader) and is re-run from the top on every answer, with past tool results fed back from a journal in a Durable Object.",
	"Strict replay checks that each re-run asks for the same tool call with the same arguments, so a non-deterministic script is caught and stopped. Lenient replay checks only the tool name, so it keeps going on values the human never saw.",
	"consistent means every tool call and the final result saw one runId: the human approved the run that actually did the work.",
];

export const runCodemode = async (env: CodemodeEnv): Promise<CodemodeResult> => {
	const rows: Array<CodemodeRow> = [];

	for (const variant of ["deterministic", "llm"] as const) {
		rows.push(await runDquickts(env, variant));
		rows.push(await runReplay(env, variant, true));
		rows.push(await runReplay(env, variant, false));
	}

	return { ranAt: Date.now(), rows, notes: NOTES };
};
