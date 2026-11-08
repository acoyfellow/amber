import { Effect, Option, Result, Schema } from "effect";
import { Engine, type Ran, sha256 } from "./engine";
import { PRELUDE, reseeded, thrown, value } from "./prelude";
import type { ScriptStorage } from "./storage";
import type { Tool, ToolContext, Tools } from "./tools";

export class StaleToken extends Schema.TaggedError<StaleToken>()("StaleToken", { token: Schema.String }) {}

export class NotWaiting extends Schema.TaggedError<NotWaiting>()("NotWaiting", { state: Schema.String }) {}

export class NoProgram extends Schema.TaggedError<NoProgram>()("NoProgram", { programId: Schema.String }) {}

export class EngineMismatch extends Schema.TaggedError<EngineMismatch>()("EngineMismatch", { stored: Schema.String, current: Schema.String }) {}

export class WritesRefused extends Schema.TaggedError<WritesRefused>()("WritesRefused", { tools: Schema.Array(Schema.String) }) {}

export class IllegalTransition extends Schema.TaggedError<IllegalTransition>()("IllegalTransition", { from: Schema.String, to: Schema.String }) {}

export class SimulatedCrash extends Error {
	override readonly name = "SimulatedCrash";
}

export type CrashPoint = "read" | "beforeWrite" | "afterEffect" | "afterResult" | "waiting" | "slice" | "held";

export type HistoryEntry = {
	readonly step: number;
	readonly name: string;
	readonly kind: "read" | "write" | "external" | "denied" | "held";
	readonly args: unknown;
	readonly result: unknown;
	readonly line: number | null;
};

export type Plan = {
	readonly programId: string;
	readonly step: number;
	readonly tool: string;
	readonly args: unknown;
	readonly line: number | null;
	readonly source: string;
	readonly history: ReadonlyArray<HistoryEntry>;
};

export type Decision = { readonly allow: true } | { readonly deny: string } | { readonly hold: string };

export type Gate = (plan: Plan) => Decision | Promise<Decision>;

export type Inspection = {
	readonly state: string;
	readonly step: number;
	readonly source: string;
	readonly line: number | null;
	readonly pending: { readonly kind: "write" | "external" | "hold"; readonly name: string; readonly args: unknown; readonly reason: string | null } | null;
	readonly history: ReadonlyArray<HistoryEntry>;
	readonly snapshotBytes: number;
};

export type Waiting = {
	readonly _tag: "Waiting";
	readonly kind: "external" | "hold";
	readonly name: string;
	readonly args: unknown;
	readonly token: string;
	readonly step: number;
	readonly deadline: number | null;
	readonly line: number | null;
	readonly reason: string | null;
};

export type Outcome =
	| Waiting
	| { readonly _tag: "Running" }
	| { readonly _tag: "Finished"; readonly result: unknown }
	| { readonly _tag: "Failed"; readonly error: string; readonly message: string };

const Pending = Schema.Struct({
	step: Schema.Number,
	name: Schema.String,
	args: Schema.String,
	kind: Schema.Literals(["write", "external", "hold"]),
	token: Schema.String,
	result: Schema.NullOr(Schema.String),
	deadline: Schema.NullOr(Schema.Number),
	line: Schema.optional(Schema.NullOr(Schema.Number)),
	reason: Schema.optional(Schema.NullOr(Schema.String)),
});

type Pending = typeof Pending.Type;

const Meta = Schema.Struct({
	programId: Schema.String,
	source: Schema.String,
	baseSha: Schema.String,
	step: Schema.Number,
	state: Schema.Literals(["running", "waiting", "sliced", "finished", "failed"]),
	pending: Schema.NullOr(Pending),
	outcome: Schema.NullOr(Schema.Json),
	chunks: Schema.Number,
	snapshotBytes: Schema.Number,
	reseed: Schema.NullOr(Schema.Number),
});

type Meta = typeof Meta.Type;

export type ProgramState = Meta["state"];

export const TRANSITIONS: { readonly [From in ProgramState]: ReadonlyArray<ProgramState> } = {
	running: ["running", "sliced", "waiting", "finished", "failed"],
	sliced: ["running", "sliced", "waiting", "finished", "failed"],
	waiting: ["running"],
	finished: [],
	failed: [],
};

export const canTransition = (from: ProgramState, to: ProgramState): boolean => TRANSITIONS[from].includes(to);

const MetaJson = Schema.fromJsonString(Meta);

const encodeMeta = Schema.encodeSync(MetaJson);

const decodeMeta = Schema.decodeUnknownOption(MetaJson);

const Call = Schema.fromJsonString(Schema.Struct({ name: Schema.String, args: Schema.String }));

const decodeCall = Schema.decodeUnknownOption(Call);

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const ScriptError = Schema.fromJsonString(Schema.Struct({ error: Schema.String, stack: Schema.optional(Schema.String) }));

const decodeScriptError = Schema.decodeUnknownOption(ScriptError);

const Wrapped = Schema.fromJsonString(Schema.Struct({ a: Schema.Json, at: Schema.Number }));

const decodeWrapped = Schema.decodeUnknownOption(Wrapped);

const unwrap = (args: string): { readonly args: string; readonly line: number | null } =>
	Option.match(decodeWrapped(args), {
		onNone: () => ({ args, line: null }),
		onSome: ({ a, at }) => ({ args: JSON.stringify(a), line: at > 0 ? at : null }),
	});

const History = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			step: Schema.Number,
			name: Schema.String,
			kind: Schema.Literals(["read", "write", "external", "denied", "held"]),
			args: Schema.Json,
			result: Schema.Json,
			line: Schema.NullOr(Schema.Number),
		}),
	),
);

const decodeHistory = Schema.decodeUnknownOption(History);

const HISTORY_LIMIT = 200;

const RESULT_PREVIEW = 400;

const preview = (envelope: string): unknown => {
	const text = envelope.length > RESULT_PREVIEW ? `${envelope.slice(0, RESULT_PREVIEW)}…` : envelope;

	return Option.getOrElse(parseJson(text), () => text);
};

export type ScriptOptions = {
	readonly programId: string;
	readonly storage: ScriptStorage;
	readonly tools: Tools;
	readonly wasm: WebAssembly.Module;
	readonly budgetTicks?: number;
	readonly sliceGapMs?: number;
	readonly recoveryDelayMs?: number;
	readonly chunkBytes?: number;
	readonly maxSnapshotBytes?: number;
	readonly now?: () => number;
	readonly crash?: (point: CrashPoint, step: number) => void;
	readonly gate?: Gate;
	readonly log?: (line: string) => void;
};

export type Exported = { readonly meta: string; readonly snapshot: Uint8Array };

type Base = { readonly bytes: Uint8Array<ArrayBuffer>; readonly sha: string };

const bases = new WeakMap<WebAssembly.Module, Base>();

const baseFor = async (wasm: WebAssembly.Module): Promise<Base> => {
	const cached = bases.get(wasm);

	if (cached !== undefined) return cached;

	const engine = await Effect.runPromise(Engine.load(wasm, () => undefined));

	engine.init();

	const bytes = Effect.runSync(engine.makeBase);
	const base = { bytes, sha: await Effect.runPromise(sha256(bytes)) };

	bases.set(wasm, base);

	return base;
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "Error");

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const toJson = (text: string): unknown => Option.getOrElse(parseJson(text), () => text);

const failure = (error: string, message: string): Outcome => ({ _tag: "Failed", error, message });

const scriptFailure = (output: string): Outcome =>
	Option.match(decodeScriptError(output), {
		onNone: () => failure("ScriptError", output),
		onSome: ({ error, stack }) => failure("ScriptError", stack === undefined ? error : `${error}\n${stack.split("\n")[0] ?? ""}`),
	});

const waitingOf = (meta: Meta, pending: Pending): Waiting => ({
	_tag: "Waiting",
	kind: pending.kind === "hold" ? "hold" : "external",
	line: pending.line ?? null,
	reason: pending.reason ?? null,
	name: pending.name,
	args: toJson(pending.args),
	token: pending.token,
	step: pending.step,
	deadline: pending.deadline,
});

export class DurableScript {
	private queue: Promise<unknown> = Promise.resolve();

	private readonly now: () => number;

	constructor(private readonly options: ScriptOptions) {
		this.now = options.now ?? Date.now;
	}

	private exclusive<A>(work: () => Promise<A>): Promise<A> {
		const next = this.queue.then(work, work);

		this.queue = next.catch(() => undefined);

		return next;
	}

	private crash(point: CrashPoint, step: number): void {
		this.options.crash?.(point, step);
	}

	private lastState: ProgramState | null = null;

	private async load(): Promise<Option.Option<Meta>> {
		const meta = decodeMeta(await this.options.storage.get("meta"));

		this.lastState = Option.match(meta, { onNone: () => null, onSome: ({ state }) => state });

		return meta;
	}

	private guard(meta: Meta): void {
		const from = this.lastState;

		if (from !== null && !canTransition(from, meta.state)) throw new IllegalTransition({ from, to: meta.state });
	}

	private async saveMeta(meta: Meta): Promise<Meta> {
		this.guard(meta);
		await this.options.storage.commit({ put: [["meta", encodeMeta(meta)]] });
		this.lastState = meta.state;

		return meta;
	}

	private async history(): Promise<ReadonlyArray<HistoryEntry>> {
		return Option.getOrElse(decodeHistory(await this.options.storage.get("history")), () => []);
	}

	private async record(entry: HistoryEntry): Promise<void> {
		const kept = (await this.history()).filter((existing) => existing.step !== entry.step || existing.kind !== entry.kind);

		await this.options.storage.commit({ put: [["history", JSON.stringify([...kept, entry].slice(-HISTORY_LIMIT))]] });
	}

	private async snapshotKeys(): Promise<ReadonlyArray<string>> {
		return this.options.storage.keys("snap:");
	}

	private async readSnapshot(meta: Meta): Promise<Uint8Array> {
		const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, index) => this.options.storage.get(`snap:${index}`)));
		const total = parts.reduce((size, part) => size + (part instanceof Uint8Array ? part.length : 0), 0);
		const bytes = new Uint8Array(total);
		let offset = 0;

		for (const part of parts) {
			if (part instanceof Uint8Array) {
				bytes.set(part, offset);
				offset += part.length;
			}
		}

		return bytes;
	}

	private async writeSnapshot(engine: Engine, meta: Meta): Promise<Result.Result<Meta, Outcome>> {
		const delta = Effect.runSync(engine.saveDelta);
		const cap = this.options.maxSnapshotBytes ?? 8 * 1024 * 1024;

		if (delta.length > cap) return Result.fail(failure("SnapshotTooLarge", `the snapshot is ${delta.length} bytes; the cap is ${cap}`));

		const size = this.options.chunkBytes ?? 100 * 1024;
		const chunks = Math.max(1, Math.ceil(delta.length / size));

		const next = { ...meta, chunks, snapshotBytes: delta.length };
		const parts = Array.from({ length: chunks }, (_, index) => [`snap:${index}`, delta.slice(index * size, (index + 1) * size)] as const);
		const stale = (await this.snapshotKeys()).filter((key) => Number(key.slice("snap:".length)) >= chunks);

		this.guard(next);
		await this.options.storage.commit({ put: [...parts, ["meta", encodeMeta(next)]], delete: stale });
		this.lastState = next.state;

		return Result.succeed(next);
	}

	private async settle(meta: Meta, outcome: Outcome): Promise<Outcome> {
		const settled: Meta = { ...meta, state: outcome._tag === "Finished" ? "finished" : "failed", pending: null, chunks: 0, outcome: JSON.parse(JSON.stringify(outcome)) };

		this.guard(settled);
		await this.options.storage.commit({ put: [["meta", encodeMeta(settled)]], delete: await this.snapshotKeys() });
		this.lastState = settled.state;
		await this.options.storage.clearAlarm();

		return outcome;
	}

	private async engine(): Promise<Engine> {
		const engine = await Effect.runPromise(Engine.load(this.options.wasm, (line) => this.options.log?.(line)));

		return engine;
	}

	private async restore(meta: Meta): Promise<Engine> {
		const base = await baseFor(this.options.wasm);

		if (meta.baseSha !== base.sha) throw new EngineMismatch({ stored: meta.baseSha, current: base.sha });

		const engine = await this.engine();

		Effect.runSync(engine.restore(base.bytes, await this.readSnapshot(meta)));
		engine.setBudget(this.options.budgetTicks ?? 50);

		return engine;
	}

	private resume(engine: Engine, envelope: Option.Option<string>): Ran {
		return Effect.runSync(engine.resume(envelope));
	}

	private async runTool(tool: Tool, args: unknown, context: ToolContext): Promise<string> {
		if (tool.kind === "external") return thrown("ToolError", "external tools cannot run");

		try {
			// SAFETY: args was decoded by this tool's own Schema in decodeArgs.
			const result = await (tool.run as (input: unknown, context: ToolContext) => unknown)(args, context);

			return value(result);
		} catch (error) {
			if (error instanceof SimulatedCrash) throw error;

			return thrown(errorName(error), errorMessage(error));
		}
	}

	private decodeArgs(tool: Tool, args: string): Result.Result<unknown, string> {
		const parsed = toJson(args);
		const decoded = Schema.decodeUnknownResult(tool.args)(parsed);

		return Result.match(decoded, { onSuccess: (ok) => Result.succeed(ok), onFailure: (error) => Result.fail(String(error.message ?? error)) });
	}

	private async drive(engine: Engine, first: Ran, start: Meta): Promise<Outcome> {
		let ran = first;
		let meta = start;

		for (;;) {
			if (ran.run === "done") return this.settle(meta, { _tag: "Finished", result: toJson(ran.output) });

			if (ran.run === "error") return this.settle(meta, scriptFailure(ran.output));

			if (ran.run === "slice") {
				const saved = await this.writeSnapshot(engine, { ...meta, state: "sliced", pending: null });

				if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

				this.crash("slice", meta.step);
				await this.options.storage.setAlarm(this.now() + (this.options.sliceGapMs ?? 0));

				return { _tag: "Running" };
			}

			const call = decodeCall(ran.output);

			if (Option.isNone(call)) return this.settle(meta, failure("BadToolCall", ran.output));

			const step = meta.step + 1;
			const { name } = call.value;
			const { args, line } = unwrap(call.value.args);
			const tool = this.options.tools[name];

			if (tool === undefined) {
				meta = { ...meta, step };
				ran = this.resume(engine, Option.some(thrown("ToolNotFound", `no tool named ${name}`)));
				continue;
			}

			const decoded = this.decodeArgs(tool, args);

			if (Result.isFailure(decoded)) {
				meta = { ...meta, step };
				ran = this.resume(engine, Option.some(thrown("InvalidArguments", `${name}: ${decoded.failure}`)));
				continue;
			}

			const context: ToolContext = { programId: this.options.programId, step, key: `${this.options.programId}:${step}` };

			if (tool.kind === "read") {
				const envelope = await this.runTool(tool, decoded.success, context);

				await this.record({ step, name, kind: "read", args: decoded.success, result: preview(envelope), line });
				this.crash("read", step);
				meta = { ...meta, step };
				ran = this.resume(engine, Option.some(envelope));
				continue;
			}

			if (tool.kind === "write") {
				const decision = this.options.gate === undefined ? { allow: true as const } : await this.options.gate({ programId: this.options.programId, step, tool: name, args: decoded.success, line, source: meta.source, history: await this.history() });

				if ("deny" in decision) {
					await this.record({ step, name, kind: "denied", args: decoded.success, result: decision.deny, line });
					meta = { ...meta, step };
					ran = this.resume(engine, Option.some(thrown("Denied", `${name}: ${decision.deny}`)));
					continue;
				}

				if ("hold" in decision) {
					const held: Pending = { step, name, args, kind: "hold", token: crypto.randomUUID(), result: null, deadline: null, line, reason: decision.hold };
					const saved = await this.writeSnapshot(engine, { ...meta, step, state: "waiting", pending: held });

					if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

					await this.record({ step, name, kind: "held", args: decoded.success, result: decision.hold, line });
					await this.options.storage.clearAlarm();
					this.crash("held", step);

					return waitingOf(saved.success, held);
				}

				const pending: Pending = { step, name, args, kind: "write", token: "", result: null, deadline: null, line };
				const saved = await this.writeSnapshot(engine, { ...meta, step, state: "running", pending });

				if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

				meta = saved.success;
				await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));
				this.crash("beforeWrite", step);

				const envelope = await this.runTool(tool, decoded.success, context);

				this.crash("afterEffect", step);
				meta = await this.saveMeta({ ...meta, pending: { ...pending, result: envelope } });
				await this.record({ step, name, kind: "write", args: decoded.success, result: preview(envelope), line });
				this.crash("afterResult", step);
				ran = this.resume(engine, Option.some(envelope));
				continue;
			}

			const deadline = tool.timeoutMs === undefined ? null : this.now() + tool.timeoutMs;
			const pending: Pending = { step, name, args, kind: "external", token: crypto.randomUUID(), result: null, deadline, line };
			const saved = await this.writeSnapshot(engine, { ...meta, step, state: "waiting", pending });

			if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

			if (deadline === null) await this.options.storage.clearAlarm();
			else await this.options.storage.setAlarm(deadline);

			this.crash("waiting", step);

			return waitingOf(saved.success, pending);
		}
	}

	private async continueFrom(meta: Meta): Promise<Outcome> {
		if (meta.state === "finished" || meta.state === "failed") {
			// SAFETY: outcome was written by settle() from an Outcome value.
			return (meta.outcome ?? failure("Lost", "no stored outcome")) as Outcome;
		}

		if (meta.state === "waiting" && meta.pending !== null) {
			if (meta.pending.deadline === null || this.now() < meta.pending.deadline) return waitingOf(meta, meta.pending);

			const timedOut = await this.saveMeta({ ...meta, state: "running", pending: { ...meta.pending, result: thrown("Timeout", `${meta.pending.name} timed out`) } });

			return this.continueFrom(timedOut);
		}

		if (meta.chunks === 0) return this.fresh(meta);

		const engine = await this.restore(meta);

		if (meta.state === "sliced" || meta.pending === null) return this.drive(engine, this.resume(engine, Option.none()), meta);

		const pending = meta.pending;

		if (pending.result !== null) {
			const envelope = meta.reseed === null ? pending.result : reseeded(pending.result, meta.reseed);

			return this.drive(engine, this.resume(engine, Option.some(envelope)), { ...meta, reseed: null });
		}

		const tool = this.options.tools[pending.name];

		if (tool === undefined || tool.kind !== "write") return this.settle(meta, failure("Lost", `cannot recover ${pending.name}`));

		const decoded = this.decodeArgs(tool, pending.args);

		if (Result.isFailure(decoded)) return this.settle(meta, failure("InvalidArguments", decoded.failure));

		const context: ToolContext = { programId: this.options.programId, step: pending.step, key: `${this.options.programId}:${pending.step}` };

		this.crash("beforeWrite", pending.step);

		const envelope = await this.runTool(tool, decoded.success, context);

		this.crash("afterEffect", pending.step);

		const recorded = await this.saveMeta({ ...meta, pending: { ...pending, result: envelope } });

		await this.record({ step: pending.step, name: pending.name, kind: "write", args: decoded.success, result: preview(envelope), line: pending.line ?? null });

		this.crash("afterResult", pending.step);

		return this.drive(engine, this.resume(engine, Option.some(envelope)), recorded);
	}

	private async fresh(meta: Meta): Promise<Outcome> {
		const base = await baseFor(this.options.wasm);
		const engine = await this.engine();

		engine.init();

		const own = await Effect.runPromise(sha256(Effect.runSync(engine.makeBase)));

		if (own !== base.sha) throw new EngineMismatch({ stored: base.sha, current: own });

		engine.setBudget(this.options.budgetTicks ?? 50);

		const started = await this.saveMeta({ ...meta, baseSha: base.sha, step: 0, state: "running", pending: null, chunks: 0 });

		return this.drive(engine, Effect.runSync(engine.start(PRELUDE + meta.source)), started);
	}

	run(source: string): Promise<Outcome> {
		return this.exclusive(async () => {
			const base = await baseFor(this.options.wasm);
			const meta: Meta = {
				programId: this.options.programId,
				source,
				baseSha: base.sha,
				step: 0,
				state: "running",
				pending: null,
				outcome: null,
				chunks: 0,
				snapshotBytes: 0,
				reseed: null,
			};

			await this.options.storage.commit({ put: [["meta", encodeMeta(meta)]], delete: [...(await this.snapshotKeys()), "history"] });
			this.lastState = meta.state;
			await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));

			return this.fresh(meta);
		});
	}

	answer(token: string, result: unknown): Promise<Outcome> {
		return this.exclusive(async () => {
			const meta = Option.getOrThrowWith(await this.load(), () => new NoProgram({ programId: this.options.programId }));

			if (meta.state !== "waiting" || meta.pending === null) throw new NotWaiting({ state: meta.state });

			if (meta.pending.token !== token) throw new StaleToken({ token });

			const pending = meta.pending;

			if (pending.kind === "hold") {
				const approved = result === true;
				const next: Pending = approved ? { ...pending, kind: "write", token: "" } : { ...pending, result: thrown("Denied", `${pending.name}: ${typeof result === "string" ? result : "denied by the reviewer"}`) };

				if (!approved) await this.record({ step: pending.step, name: pending.name, kind: "denied", args: toJson(pending.args), result: typeof result === "string" ? result : "denied by the reviewer", line: pending.line ?? null });

				const decided = await this.saveMeta({ ...meta, state: "running", pending: next });

				await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));

				return this.continueFrom(decided);
			}

			if (pending.kind === "external") await this.record({ step: pending.step, name: pending.name, kind: "external", args: toJson(pending.args), result: result ?? null, line: pending.line ?? null });

			const answered = await this.saveMeta({ ...meta, state: "running", pending: { ...pending, result: value(result) } });

			await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));

			return this.continueFrom(answered);
		});
	}

	recover(): Promise<Outcome> {
		return this.exclusive(async () => this.continueFrom(Option.getOrThrowWith(await this.load(), () => new NoProgram({ programId: this.options.programId }))));
	}

	alarm(): Promise<Outcome> {
		return this.recover();
	}

	async status(): Promise<Option.Option<{ readonly state: Meta["state"]; readonly step: number; readonly snapshotBytes: number; readonly chunks: number; readonly baseSha: string }>> {
		return Option.map(await this.load(), ({ state, step, snapshotBytes, chunks, baseSha }) => ({ state, step, snapshotBytes, chunks, baseSha }));
	}

	async inspect(): Promise<Option.Option<Inspection>> {
		const loaded = await this.load();
		const history = await this.history();

		return Option.map(loaded, (meta) => {
			const pending = meta.pending;

			return {
				state: meta.state,
				step: meta.step,
				source: meta.source,
				line: pending?.line ?? history.at(-1)?.line ?? null,
				pending: pending === null ? null : { kind: pending.kind, name: pending.name, args: toJson(pending.args), reason: pending.reason ?? null },
				history,
				snapshotBytes: meta.snapshotBytes,
			};
		});
	}

	async exportSnapshot(): Promise<Exported> {
		const meta = Option.getOrThrowWith(await this.load(), () => new NoProgram({ programId: this.options.programId }));

		if (meta.state !== "waiting") throw new NotWaiting({ state: meta.state });

		return { meta: encodeMeta(meta), snapshot: await this.readSnapshot(meta) };
	}

	static async fork(exported: Exported, options: ScriptOptions & { readonly allowWrites?: boolean; readonly reseed?: number }): Promise<DurableScript> {
		const writes = Object.entries(options.tools).flatMap(([name, tool]) => (tool.kind === "write" ? [name] : []));

		if (writes.length > 0 && options.allowWrites !== true) throw new WritesRefused({ tools: writes });

		const meta = Option.getOrThrowWith(decodeMeta(exported.meta), () => new NoProgram({ programId: options.programId }));
		const size = options.chunkBytes ?? 100 * 1024;
		const chunks = Math.max(1, Math.ceil(exported.snapshot.length / size));

		const parts = Array.from({ length: chunks }, (_, index) => [`snap:${index}`, exported.snapshot.slice(index * size, (index + 1) * size)] as const);

		await options.storage.commit({ put: [...parts, ["meta", encodeMeta({ ...meta, programId: options.programId, chunks, reseed: options.reseed ?? null })]] });

		return new DurableScript(options);
	}
}
