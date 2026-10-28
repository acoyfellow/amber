import { Schema } from "effect";

export const BenchSystem = Schema.Literals(["amber", "workflows", "agents", "durable-object"]);

export type BenchSystem = typeof BenchSystem.Type;

export const BENCH_SYSTEMS: ReadonlyArray<BenchSystem> = ["amber", "workflows", "agents", "durable-object"];

export const SYSTEM_LABELS: Readonly<Record<BenchSystem, string>> = {
	amber: "amber (DurableScript)",
	workflows: "Cloudflare Workflows",
	agents: "Agents SDK",
	"durable-object": "Plain Durable Object",
};

export const APPROVAL_COUNT = 8;

export const LOOP_LIMIT = 3_000_000;

export const LOOP_EXPECTED = 1_498_500_000;

export const BENCH_COOLDOWN_MS = 20_000;

export const answerFor = (id: number): boolean => id % 3 !== 0;

export const Decision = Schema.Struct({ id: Schema.Number, ok: Schema.Boolean });

export type Decision = typeof Decision.Type;

export const Decided = Schema.Struct({ decided: Schema.Array(Decision) });

export const DecidedJson = Schema.fromJsonString(Decided);

export const expectedDecided = (): ReadonlyArray<Decision> => Array.from({ length: APPROVAL_COUNT }, (_, id) => ({ id, ok: answerFor(id) }));

export const ApprovalState = Schema.Struct({ total: Schema.Number, next: Schema.Number, decided: Schema.Array(Decision) });

export type ApprovalState = typeof ApprovalState.Type;

export const ApprovalStateJson = Schema.fromJsonString(ApprovalState);

export const MachineReply = Schema.Struct({ state: ApprovalState, object: Schema.String, storedBytes: Schema.Number });

export type MachineReply = typeof MachineReply.Type;

export const MachineReplyJson = Schema.fromJsonString(MachineReply);

export const LoopReply = Schema.Struct({ sum: Schema.Number, object: Schema.String });

export const LoopReplyJson = Schema.fromJsonString(LoopReply);

export const Progress = Schema.Struct({ ready: Schema.Number, recorded: Schema.Number });

export type Progress = typeof Progress.Type;

export const ProgressJson = Schema.fromJsonString(Progress);

export const WorkflowMode = Schema.Literals(["approvals", "loop"]);

export const WorkflowParams = Schema.Struct({ mode: WorkflowMode, progress: Schema.String });

export type WorkflowParams = typeof WorkflowParams.Type;

export const AnswerEvent = Schema.Struct({ ok: Schema.Boolean });

export const LoopOutput = Schema.Struct({ sum: Schema.Number });

export const ApprovalsResult = Schema.Struct({
	answers: Schema.Number,
	kills: Schema.Number,
	killable: Schema.Boolean,
	correct: Schema.Boolean,
	resumeMs: Schema.Array(Schema.Number),
	p50Ms: Schema.Number,
	p95Ms: Schema.Number,
	totalMs: Schema.Number,
	bytesPerPause: Schema.NullOr(Schema.Number),
	objects: Schema.NullOr(Schema.Number),
});

export type ApprovalsResult = typeof ApprovalsResult.Type;

export const LoopResult = Schema.Struct({
	wallMs: Schema.Number,
	cpuMs: Schema.NullOr(Schema.Number),
	correct: Schema.Boolean,
	slices: Schema.NullOr(Schema.Number),
});

export type LoopResult = typeof LoopResult.Type;

export const BenchResult = Schema.Struct({
	system: BenchSystem,
	ranAt: Schema.Number,
	approvals: ApprovalsResult,
	loop: LoopResult,
	notes: Schema.Array(Schema.String),
});

export type BenchResult = typeof BenchResult.Type;

export const BenchResultJson = Schema.fromJsonString(BenchResult);

export const BenchRun = Schema.Struct({ result: BenchResult, cached: Schema.Boolean });

export type BenchRun = typeof BenchRun.Type;

export const BenchRunJson = Schema.fromJsonString(BenchRun);

export const BenchBoard = Schema.Struct({ latest: Schema.Array(BenchResult), runs: Schema.Array(BenchResult) });

export type BenchBoard = typeof BenchBoard.Type;

export const BenchBoardJson = Schema.fromJsonString(BenchBoard);

export const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
	const sorted = [...values].sort((a, b) => a - b);

	if (sorted.length === 0) return 0;

	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
};

export const BENCH_PATH = "/api/bench";
