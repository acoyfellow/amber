import { Effect, Option, Schema } from "effect";
import type { Update } from "foldkit";
import { Command } from "foldkit";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { CodemodeResult, CodemodeRun } from "../../../shared/codemode";
import { BENCH_PATH, BENCH_SYSTEMS, BenchBoard, BenchResult, BenchRun, BenchSystem } from "../../../shared/bench";

export const BenchPhase = defineTaggedUnion({
	Idle: {},
	RunningCodemode: { queue: Schema.Array(BenchSystem) },
	RunningSystem: { system: BenchSystem, queue: Schema.Array(BenchSystem) },
});

export type BenchPhase = typeof BenchPhase.Type;

export const isBenchBusy = (phase: BenchPhase): boolean => !BenchPhase.isAnyOf(["Idle"])(phase);

export const BenchModel = Schema.Struct({
	results: Schema.Array(BenchResult),
	codemode: Schema.Option(CodemodeResult),
	phase: BenchPhase,
	log: Schema.Array(Schema.String),
	error: Schema.Option(Schema.String),
});

export type BenchModel = typeof BenchModel.Type;

export const BenchMessage = defineMessageUnion({
	GotBoard: { board: BenchBoard },
	GotCodemode: { result: CodemodeResult },
	GotCodemodeRun: { run: CodemodeRun },
	FailedCodemode: { reason: Schema.String },
	NoCodemodeYet: {},
	ClickedRunAll: {},
	GotRun: { run: BenchRun },
	FailedRun: { system: BenchSystem, reason: Schema.String },
	FailedBoard: { reason: Schema.String },
});

export type BenchMessage = typeof BenchMessage.Type;

const reasonOf = (error: { readonly message: string }) => error.message;

export const LoadBoard = Command.define("LoadBoard", {
	messages: [BenchMessage.GotBoard, BenchMessage.FailedBoard],
	execute: HttpClient.get(BENCH_PATH).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(BenchBoard)),
		Effect.map((board) => BenchMessage.GotBoard({ board })),
		Effect.catch((error) => Effect.succeed(BenchMessage.FailedBoard({ reason: reasonOf(error) }))),
		Effect.provide(FetchHttpClient.layer),
	),
});

export const LoadCodemode = Command.define("LoadCodemode", {
	messages: [BenchMessage.GotCodemode, BenchMessage.NoCodemodeYet],
	execute: HttpClient.get(`${BENCH_PATH}/codemode`).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(CodemodeResult)),
		Effect.map((result) => BenchMessage.GotCodemode({ result })),
		Effect.catch(() => Effect.succeed(BenchMessage.NoCodemodeYet())),
		Effect.provide(FetchHttpClient.layer),
	),
});

export const RunCodemode = Command.define("RunCodemode", {
	messages: [BenchMessage.GotCodemodeRun, BenchMessage.FailedCodemode],
	execute: HttpClient.post(`${BENCH_PATH}/codemode`).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(CodemodeRun)),
		Effect.map((run) => BenchMessage.GotCodemodeRun({ run })),
		Effect.catch((error) => Effect.succeed(BenchMessage.FailedCodemode({ reason: reasonOf(error) }))),
		Effect.provide(FetchHttpClient.layer),
	),
});

export const RunSystem = Command.define("RunSystem", {
	args: { system: BenchSystem },
	messages: [BenchMessage.GotRun, BenchMessage.FailedRun],
	execute: ({ system }) =>
		HttpClient.post(`${BENCH_PATH}/${system}`).pipe(
			Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap(HttpClientResponse.schemaBodyJson(BenchRun)),
			Effect.map((run) => BenchMessage.GotRun({ run })),
			Effect.catch((error) => Effect.succeed(BenchMessage.FailedRun({ system, reason: reasonOf(error) }))),
			Effect.provide(FetchHttpClient.layer),
		),
});

export const initialBenchModel: BenchModel = { results: [], codemode: Option.none(), phase: BenchPhase.Idle(), log: [], error: Option.none() };

type BenchReturn = Update.Return<BenchModel, BenchMessage>;

const replaceResult = (results: ReadonlyArray<BenchResult>, result: BenchResult): ReadonlyArray<BenchResult> =>
	BENCH_SYSTEMS.flatMap((system) => (system === result.system ? [result] : results.filter((current) => current.system === system)));

const queueOf = (phase: BenchPhase): ReadonlyArray<BenchSystem> =>
	BenchPhase.match(phase, { Idle: () => [], RunningCodemode: ({ queue }) => queue, RunningSystem: ({ queue }) => queue });

const next = (model: BenchModel): BenchReturn => {
	const [head, ...rest] = queueOf(model.phase);

	if (head === undefined) return { model: modifyFields(model, { phase: () => BenchPhase.Idle(), log: (log) => [...log, "All systems done."] }) };

	return {
		model: modifyFields(model, { phase: () => BenchPhase.RunningSystem({ system: head, queue: rest }), log: (log) => [...log, `Running ${head}…`] }),
		commands: [RunSystem({ system: head })],
	};
};

export const benchUpdate = (model: BenchModel, message: BenchMessage): BenchReturn =>
	BenchMessage.match<BenchReturn>(message, {
		GotBoard: ({ board }) => ({ model: modifyFields(model, { results: () => board.latest }) }),
		FailedBoard: ({ reason }) => ({ model: modifyFields(model, { error: () => Option.some(`Could not load results: ${reason}`) }) }),
		GotCodemode: ({ result }) => ({ model: modifyFields(model, { codemode: () => Option.some(result) }) }),
		NoCodemodeYet: () => ({ model }),
		GotCodemodeRun: ({ run }) =>
			next(
				modifyFields(model, {
					codemode: () => Option.some(run.result),
					log: (log) => [...log, `codemode-pause: ${run.cached ? "cached (ran under 20 s ago)" : "done"}, ${run.result.rows.filter((row) => row.completed && row.consistent).length} of ${run.result.rows.length} runs finished correctly and consistently`],
				}),
			),
		FailedCodemode: ({ reason }) => next(modifyFields(model, { log: (log) => [...log, `codemode-pause: failed (${reason})`] })),
		ClickedRunAll: () =>
			isBenchBusy(model.phase)
				? { model }
				: {
						model: modifyFields(model, { phase: () => BenchPhase.RunningCodemode({ queue: BENCH_SYSTEMS }), log: () => ["Running codemode-pause…"], error: () => Option.none() }),
						commands: [RunCodemode()],
					},
		GotRun: ({ run }) =>
			next(
				modifyFields(model, {
					results: (results) => replaceResult(results, run.result),
					log: (log) => [...log, `${run.result.system}: ${run.cached ? "cached (ran under 20 s ago)" : "done"}, approvals ${run.result.approvals.totalMs} ms, loop ${run.result.loop.wallMs} ms`],
				}),
			),
		FailedRun: ({ system, reason }) => next(modifyFields(model, { log: (log) => [...log, `${system}: failed (${reason})`] })),
	});
