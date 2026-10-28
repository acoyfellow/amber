import { Schema } from "effect";

export const CodemodeSystem = Schema.Literals(["amber", "replay-strict", "replay-lenient"]);

export type CodemodeSystem = typeof CodemodeSystem.Type;

export const CODEMODE_SYSTEMS: ReadonlyArray<CodemodeSystem> = ["amber", "replay-strict", "replay-lenient"];

export const CODEMODE_LABELS: Readonly<Record<CodemodeSystem, string>> = {
	amber: "amber: pause the running program",
	"replay-strict": "Replay, strict (Dynamic Worker + journal)",
	"replay-lenient": "Replay, lenient (Dynamic Worker + journal)",
};

export const CodemodeVariant = Schema.Literals(["deterministic", "llm"]);

export type CodemodeVariant = typeof CodemodeVariant.Type;

export const CODEMODE_VARIANTS: ReadonlyArray<CodemodeVariant> = ["deterministic", "llm"];

export const VARIANT_LABELS: Readonly<Record<CodemodeVariant, string>> = {
	deterministic: "Deterministic script",
	llm: "LLM-style script (Math.random, Date.now)",
};

export const ISSUE_IDS: ReadonlyArray<number> = [101, 102, 103, 104, 105, 106];

export const approveIssue = (index: number): boolean => index % 3 !== 0;

export const EXPECTED_CLOSED: ReadonlyArray<number> = ISSUE_IDS.filter((_, index) => approveIssue(index));

export const ToolEntry = Schema.Struct({ name: Schema.String, args: Schema.String, result: Schema.String });

export type ToolEntry = typeof ToolEntry.Type;

export const ScriptOutput = Schema.Struct({ closed: Schema.Array(Schema.Number), runId: Schema.optional(Schema.String) });

export type ScriptOutput = typeof ScriptOutput.Type;

export const ScriptOutputJson = Schema.fromJsonString(ScriptOutput);

export const RunIdArgs = Schema.Struct({ runId: Schema.optional(Schema.String), id: Schema.optional(Schema.Number) });

export const RunIdArgsJson = Schema.fromJsonString(RunIdArgs);

export const LoaderKind = Schema.Literals(["done", "pause", "diverged", "error"]);

export type LoaderKind = typeof LoaderKind.Type;

export const LoaderReply = Schema.Struct({
	kind: LoaderKind,
	value: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	args: Schema.NullOr(Schema.String),
	at: Schema.NullOr(Schema.Number),
	reason: Schema.NullOr(Schema.String),
	replayed: Schema.Number,
});

export type LoaderReply = typeof LoaderReply.Type;

export const LoaderReplyJson = Schema.fromJsonString(LoaderReply);

export const ReplayReply = Schema.Struct({ step: LoaderReply, scriptRuns: Schema.Number, replayedCalls: Schema.Number, storedBytes: Schema.Number, object: Schema.String });

export type ReplayReply = typeof ReplayReply.Type;

export const ReplayReplyJson = Schema.fromJsonString(ReplayReply);

export const CodemodeRow = Schema.Struct({
	system: CodemodeSystem,
	variant: CodemodeVariant,
	outcome: Schema.Literals(["finished", "diverged", "failed"]),
	completed: Schema.Boolean,
	consistent: Schema.Boolean,
	divergedAt: Schema.NullOr(Schema.Number),
	closed: Schema.Array(Schema.Number),
	answers: Schema.Number,
	kills: Schema.Number,
	resumeMs: Schema.Array(Schema.Number),
	p50Ms: Schema.NullOr(Schema.Number),
	p95Ms: Schema.NullOr(Schema.Number),
	totalMs: Schema.Number,
	scriptRuns: Schema.Number,
	replayedCalls: Schema.Number,
	sideEffects: Schema.Number,
	bytesPerPause: Schema.NullOr(Schema.Number),
	reason: Schema.NullOr(Schema.String),
});

export type CodemodeRow = typeof CodemodeRow.Type;

export const CodemodeResult = Schema.Struct({ ranAt: Schema.Number, rows: Schema.Array(CodemodeRow), notes: Schema.Array(Schema.String) });

export type CodemodeResult = typeof CodemodeResult.Type;

export const CodemodeResultJson = Schema.fromJsonString(CodemodeResult);

export const CodemodeRun = Schema.Struct({ result: CodemodeResult, cached: Schema.Boolean });

export const CodemodeRunJson = Schema.fromJsonString(CodemodeRun);
