import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ProgramId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(Schema.brand("ProgramId"));

export type ProgramId = typeof ProgramId.Type;

export const MAX_SOURCE = 8000;

export const MAX_ANSWER = 16000;

export const MAX_SLICES = 2000;

export const Source = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SOURCE));

export const AnswerText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANSWER));

export const ToolCall = Schema.Struct({ name: Schema.String, args: Schema.String });

export type ToolCall = typeof ToolCall.Type;

export const Waiting = Schema.TaggedStruct("Waiting", { call: ToolCall });

export const Running = Schema.TaggedStruct("Running", {});

export const Finished = Schema.TaggedStruct("Finished", { result: Schema.String });

export const Failed = Schema.TaggedStruct("Failed", { reason: Schema.String });

export const Outcome = Schema.Union([Waiting, Running, Finished, Failed]);

export type Outcome = typeof Outcome.Type;

export const isWaiting = Schema.is(Waiting);

export const isRunning = Schema.is(Running);

export const isLive = (outcome: Outcome): boolean => isWaiting(outcome) || isRunning(outcome);

export const Trigger = Schema.Literals(["start", "answer", "alarm"]);

export type Trigger = typeof Trigger.Type;

export const Step = Schema.Struct({
	n: Schema.Number,
	at: Schema.Number,
	trigger: Trigger,
	answer: Schema.OptionFromNullOr(Schema.String),
	outcome: Outcome,
	deltaBytes: Schema.Number,
	object: Schema.String,
	ms: Schema.Number,
	logs: Schema.Array(Schema.String),
});

export type Step = typeof Step.Type;

export const Kill = Schema.Struct({ at: Schema.Number, afterStep: Schema.Number, object: Schema.String });

export type Kill = typeof Kill.Type;

export const Snapshot = Schema.Struct({
	id: ProgramId,
	outcome: Schema.OptionFromNullOr(Outcome),
	steps: Schema.Array(Step),
	totalSteps: Schema.Number,
	kills: Schema.Array(Kill),
	objects: Schema.Number,
	current: Schema.String,
	deltaBytes: Schema.Number,
	baseSha: Schema.String,
});

export type Snapshot = typeof Snapshot.Type;

export class NotWaiting extends Schema.TaggedError<NotWaiting>()("NotWaiting", { state: Schema.String }) {}

export class BadAnswer extends Schema.TaggedError<BadAnswer>()("BadAnswer", { reason: Schema.String }) {}

export class ProgramUnavailable extends Schema.TaggedError<ProgramUnavailable>()("ProgramUnavailable", { reason: Schema.String }) {}

export const SnapshotJson = Schema.fromJsonString(Schema.toCodecJson(Snapshot));

export const AnswerOutcomeJson = Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Snapshot, Schema.Union([NotWaiting, BadAnswer]))));

const target = { id: ProgramId };

export const ProgramRpcs = RpcGroup.make(
	Rpc.make("Snapshot", { payload: target, success: Snapshot, error: ProgramUnavailable }),
	Rpc.make("Start", { payload: { ...target, source: Source }, success: Snapshot, error: ProgramUnavailable }),
	Rpc.make("Answer", { payload: { ...target, answer: AnswerText }, success: Snapshot, error: Schema.Union([NotWaiting, BadAnswer, ProgramUnavailable]) }),
	Rpc.make("Kill", { payload: target, error: ProgramUnavailable }),
);

export type ProgramRpcs = typeof ProgramRpcs;

export const RPC_PATH = "/api/rpc";
