import { DurableObject } from "cloudflare:workers";
import { Match, Option, Result, Schema } from "effect";
import { DurableScript, durableObjectStorage, external, type Outcome as AmberOutcome, type Tools } from "../../src";
import wasm from "../../engine/dq.wasm";
import {
	AnswerOutcomeJson,
	BadAnswer,
	Failed,
	Finished,
	isLive,
	isRunning,
	isWaiting,
	Kill,
	MAX_SLICES,
	NotWaiting,
	Outcome,
	ProgramId,
	Running,
	type Snapshot,
	SnapshotJson,
	Step,
	type Trigger,
	Waiting,
} from "../shared/protocol";

export const BUDGET_TICKS = 50;

export const SLICE_GAP_MS = 120;

const KEEP_STEPS = 60;

const KEEP_OBJECTS = 500;

const ANY_TOOL = external(Schema.Unknown);

const anyTool: Tools = new Proxy({}, { get: () => ANY_TOOL });

const Meta = Schema.Struct({
	id: ProgramId,
	outcome: Schema.OptionFromNullOr(Outcome),
	token: Schema.NullOr(Schema.String),
	steps: Schema.Array(Step),
	totalSteps: Schema.Number,
	kills: Schema.Array(Kill),
	objects: Schema.Array(Schema.String),
	baseSha: Schema.String,
});

type Meta = typeof Meta.Type;

const MetaJson = Schema.fromJsonString(Schema.toCodecJson(Meta));

const encodeMeta = Schema.encodeSync(MetaJson);

const decodeMeta = Schema.decodeUnknownOption(MetaJson);

const encodeSnapshot = Schema.encodeSync(SnapshotJson);

const encodeAnswer = Schema.encodeSync(AnswerOutcomeJson);

const checkJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const META_KEY = "site:meta";

const emptyMeta = (id: ProgramId): Meta => ({ id, outcome: Option.none(), token: null, steps: [], totalSteps: 0, kills: [], objects: [], baseSha: "" });

const stateOf = (outcome: Option.Option<Outcome>): string => Option.match(outcome, { onNone: () => "empty", onSome: (current) => current._tag });

const resultText = (result: Schema.Json): string => (Schema.is(Schema.String)(result) ? result : JSON.stringify(result));

const toProtocol = (outcome: AmberOutcome): Outcome =>
	Match.value(outcome).pipe(
		Match.tagsExhaustive({
			Waiting: ({ name, args }) => Waiting.make({ call: { name, args: JSON.stringify(args ?? null) } }),
			Running: () => Running.make({}),
			Finished: ({ result }) => Finished.make({ result: resultText(Schema.decodeUnknownSync(Schema.Json)(result ?? null)) }),
			Failed: ({ error, message }) => Failed.make({ reason: error === "ScriptError" ? message : `${error}: ${message}` }),
		}),
	);

const tokenOf = (outcome: AmberOutcome): string | null =>
	Match.value(outcome).pipe(
		Match.tag("Waiting", ({ token }) => token),
		Match.orElse(() => null),
	);

const capped = (outcome: Outcome, totalSteps: number): Outcome => (isRunning(outcome) && totalSteps >= MAX_SLICES ? Failed.make({ reason: `stopped after ${MAX_SLICES} slices` }) : outcome);

const thrown = (error: Error): Outcome => Failed.make({ reason: `${error.name}: ${error.message}` });

export class Program extends DurableObject {
	private readonly object = crypto.randomUUID().slice(0, 8);

	private logs: Array<string> = [];

	private readonly script = new DurableScript({
		programId: this.ctx.id.toString(),
		storage: durableObjectStorage(this.ctx.storage),
		wasm,
		budgetTicks: BUDGET_TICKS,
		sliceGapMs: SLICE_GAP_MS,
		tools: anyTool,
		log: (line) => this.logs.push(line),
	});

	private load(id: ProgramId): Meta {
		return Option.getOrElse(decodeMeta(this.ctx.storage.kv.get<string>(META_KEY)), () => emptyMeta(id));
	}

	private save(meta: Meta): Meta {
		this.ctx.storage.kv.put(META_KEY, encodeMeta(meta));

		return meta;
	}

	private snapshotOf(meta: Meta): Snapshot {
		const status = this.script.status();

		return {
			id: meta.id,
			outcome: meta.outcome,
			steps: meta.steps,
			totalSteps: meta.totalSteps,
			kills: meta.kills,
			objects: new Set(meta.objects).size,
			current: this.object,
			deltaBytes: Option.match(status, { onNone: () => 0, onSome: (current) => (Option.exists(meta.outcome, isLive) ? current.snapshotBytes : 0) }),
			baseSha: Option.match(status, { onNone: () => meta.baseSha, onSome: (current) => current.baseSha }),
		};
	}

	private async record(previous: Meta, trigger: Trigger, answer: Option.Option<string>, work: () => Promise<AmberOutcome>): Promise<Meta> {
		const startedAt = Date.now();

		this.logs = [];

		const ran = await work().then(
			(amber) => ({ outcome: capped(toProtocol(amber), previous.totalSteps + 1), token: tokenOf(amber) }),
			(error: Error) => ({ outcome: thrown(error), token: null }),
		);

		const outcome = ran.outcome;

		if (!isLive(outcome)) await this.ctx.storage.deleteAlarm();

		const status = this.script.status();

		const step: Step = {
			n: previous.totalSteps + 1,
			at: startedAt,
			trigger,
			answer,
			outcome,
			deltaBytes: isLive(outcome) ? Option.match(status, { onNone: () => 0, onSome: (current) => current.snapshotBytes }) : 0,
			object: this.object,
			ms: Date.now() - startedAt,
			logs: this.logs,
		};

		return this.save({
			...previous,
			outcome: Option.some(outcome),
			token: ran.token,
			steps: [...previous.steps, step].slice(-KEEP_STEPS),
			totalSteps: step.n,
			objects: [...previous.objects, this.object].slice(-KEEP_OBJECTS),
			baseSha: Option.match(status, { onNone: () => previous.baseSha, onSome: (current) => current.baseSha }),
		});
	}

	private exclusive<A>(work: () => Promise<A>): Promise<A> {
		return this.ctx.blockConcurrencyWhile(work);
	}

	snapshot(id: ProgramId): Promise<string> {
		return this.exclusive(async () => encodeSnapshot(this.snapshotOf(this.load(id))));
	}

	start(id: ProgramId, source: string): Promise<string> {
		return this.exclusive(async () => {
			const meta = await this.record(emptyMeta(id), "start", Option.none(), () => this.script.run(source));

			return encodeSnapshot(this.snapshotOf(meta));
		});
	}

	answer(id: ProgramId, answer: string): Promise<string> {
		return this.exclusive(async () => {
			const meta = this.load(id);

			if (!Option.exists(meta.outcome, isWaiting) || meta.token === null) return encodeAnswer(Result.fail(new NotWaiting({ state: stateOf(meta.outcome) })));

			const parsed = checkJson(answer);

			if (Option.isNone(parsed)) return encodeAnswer(Result.fail(new BadAnswer({ reason: "not JSON" })));

			const token = meta.token;
			const next = await this.record(meta, "answer", Option.some(answer), () => this.script.answer(token, parsed.value));

			return encodeAnswer(Result.succeed(this.snapshotOf(next)));
		});
	}

	async kill(id: ProgramId): Promise<void> {
		await this.exclusive(async () => {
			const meta = this.load(id);

			this.save({ ...meta, kills: [...meta.kills, { at: Date.now(), afterStep: meta.totalSteps, object: this.object }] });
		});
		this.ctx.abort("killed on request");
	}

	override async alarm(): Promise<void> {
		const stored = decodeMeta(this.ctx.storage.kv.get<string>(META_KEY));

		if (Option.isNone(stored)) return;

		const meta = stored.value;

		await this.exclusive(async () => {
			if (Option.exists(meta.outcome, isRunning)) await this.record(meta, "alarm", Option.none(), () => this.script.alarm());
			else await this.script.alarm().catch(() => undefined);
		});
	}
}
