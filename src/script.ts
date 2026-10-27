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

export class SimulatedCrash extends Error {
	override readonly name = "SimulatedCrash";
}

export type CrashPoint = "read" | "beforeWrite" | "afterEffect" | "afterResult" | "waiting" | "slice";

export type Waiting = { readonly _tag: "Waiting"; readonly name: string; readonly args: unknown; readonly token: string; readonly step: number; readonly deadline: number | null };

export type Outcome =
	| Waiting
	| { readonly _tag: "Running" }
	| { readonly _tag: "Finished"; readonly result: unknown }
	| { readonly _tag: "Failed"; readonly error: string; readonly message: string };

const Pending = Schema.Struct({
	step: Schema.Number,
	name: Schema.String,
	args: Schema.String,
	kind: Schema.Literals(["write", "external"]),
	token: Schema.String,
	result: Schema.NullOr(Schema.String),
	deadline: Schema.NullOr(Schema.Number),
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

const MetaJson = Schema.fromJsonString(Meta);

const encodeMeta = Schema.encodeSync(MetaJson);

const decodeMeta = Schema.decodeUnknownOption(MetaJson);

const Call = Schema.fromJsonString(Schema.Struct({ name: Schema.String, args: Schema.String }));

const decodeCall = Schema.decodeUnknownOption(Call);

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const ScriptError = Schema.fromJsonString(Schema.Struct({ error: Schema.String, stack: Schema.optional(Schema.String) }));

const decodeScriptError = Schema.decodeUnknownOption(ScriptError);

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

	private load(): Option.Option<Meta> {
		return decodeMeta(this.options.storage.get("meta"));
	}

	private saveMeta(meta: Meta): Meta {
		this.options.storage.put("meta", encodeMeta(meta));

		return meta;
	}

	private readSnapshot(meta: Meta): Uint8Array {
		const parts = Array.from({ length: meta.chunks }, (_, index) => this.options.storage.get(`snap:${index}`));
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

	private dropSnapshot(): void {
		for (const key of this.options.storage.keys("snap:")) this.options.storage.delete(key);
	}

	private writeSnapshot(engine: Engine, meta: Meta): Result.Result<Meta, Outcome> {
		const delta = Effect.runSync(engine.saveDelta);
		const cap = this.options.maxSnapshotBytes ?? 8 * 1024 * 1024;

		if (delta.length > cap) return Result.fail(failure("SnapshotTooLarge", `the snapshot is ${delta.length} bytes; the cap is ${cap}`));

		const size = this.options.chunkBytes ?? 100 * 1024;
		const chunks = Math.max(1, Math.ceil(delta.length / size));

		this.dropSnapshot();

		for (let index = 0; index < chunks; index++) this.options.storage.put(`snap:${index}`, delta.slice(index * size, (index + 1) * size));

		return Result.succeed(this.saveMeta({ ...meta, chunks, snapshotBytes: delta.length }));
	}

	private async settle(meta: Meta, outcome: Outcome): Promise<Outcome> {
		this.dropSnapshot();
		this.saveMeta({ ...meta, state: outcome._tag === "Finished" ? "finished" : "failed", pending: null, chunks: 0, outcome: JSON.parse(JSON.stringify(outcome)) });
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

		Effect.runSync(engine.restore(base.bytes, this.readSnapshot(meta)));
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
				const saved = this.writeSnapshot(engine, { ...meta, state: "sliced", pending: null });

				if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

				this.crash("slice", meta.step);
				await this.options.storage.setAlarm(this.now() + (this.options.sliceGapMs ?? 0));

				return { _tag: "Running" };
			}

			const call = decodeCall(ran.output);

			if (Option.isNone(call)) return this.settle(meta, failure("BadToolCall", ran.output));

			const step = meta.step + 1;
			const { name, args } = call.value;
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

				this.crash("read", step);
				meta = { ...meta, step };
				ran = this.resume(engine, Option.some(envelope));
				continue;
			}

			if (tool.kind === "write") {
				const pending: Pending = { step, name, args, kind: "write", token: "", result: null, deadline: null };
				const saved = this.writeSnapshot(engine, { ...meta, step, state: "running", pending });

				if (Result.isFailure(saved)) return this.settle(meta, saved.failure);

				meta = saved.success;
				await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));
				this.crash("beforeWrite", step);

				const envelope = await this.runTool(tool, decoded.success, context);

				this.crash("afterEffect", step);
				meta = this.saveMeta({ ...meta, pending: { ...pending, result: envelope } });
				this.crash("afterResult", step);
				ran = this.resume(engine, Option.some(envelope));
				continue;
			}

			const deadline = tool.timeoutMs === undefined ? null : this.now() + tool.timeoutMs;
			const pending: Pending = { step, name, args, kind: "external", token: crypto.randomUUID(), result: null, deadline };
			const saved = this.writeSnapshot(engine, { ...meta, step, state: "waiting", pending });

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

			const timedOut = this.saveMeta({ ...meta, state: "running", pending: { ...meta.pending, result: thrown("Timeout", `${meta.pending.name} timed out`) } });

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

		const recorded = this.saveMeta({ ...meta, pending: { ...pending, result: envelope } });

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

		const started = this.saveMeta({ ...meta, baseSha: base.sha, step: 0, state: "running", pending: null, chunks: 0 });

		return this.drive(engine, Effect.runSync(engine.start(PRELUDE + meta.source)), started);
	}

	run(source: string): Promise<Outcome> {
		return this.exclusive(async () => {
			this.dropSnapshot();

			const base = await baseFor(this.options.wasm);
			const meta = this.saveMeta({
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
			});

			await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));

			return this.fresh(meta);
		});
	}

	answer(token: string, result: unknown): Promise<Outcome> {
		return this.exclusive(async () => {
			const meta = Option.getOrThrowWith(this.load(), () => new NoProgram({ programId: this.options.programId }));

			if (meta.state !== "waiting" || meta.pending === null) throw new NotWaiting({ state: meta.state });

			if (meta.pending.token !== token) throw new StaleToken({ token });

			const answered = this.saveMeta({ ...meta, state: "running", pending: { ...meta.pending, result: value(result) } });

			await this.options.storage.setAlarm(this.now() + (this.options.recoveryDelayMs ?? 1000));

			return this.continueFrom(answered);
		});
	}

	recover(): Promise<Outcome> {
		return this.exclusive(async () => this.continueFrom(Option.getOrThrowWith(this.load(), () => new NoProgram({ programId: this.options.programId }))));
	}

	alarm(): Promise<Outcome> {
		return this.recover();
	}

	status(): Option.Option<{ readonly state: Meta["state"]; readonly step: number; readonly snapshotBytes: number; readonly chunks: number; readonly baseSha: string }> {
		return Option.map(this.load(), ({ state, step, snapshotBytes, chunks, baseSha }) => ({ state, step, snapshotBytes, chunks, baseSha }));
	}

	exportSnapshot(): Exported {
		const meta = Option.getOrThrowWith(this.load(), () => new NoProgram({ programId: this.options.programId }));

		if (meta.state !== "waiting") throw new NotWaiting({ state: meta.state });

		return { meta: encodeMeta(meta), snapshot: this.readSnapshot(meta) };
	}

	static fork(exported: Exported, options: ScriptOptions & { readonly allowWrites?: boolean; readonly reseed?: number }): DurableScript {
		const writes = Object.entries(options.tools).flatMap(([name, tool]) => (tool.kind === "write" ? [name] : []));

		if (writes.length > 0 && options.allowWrites !== true) throw new WritesRefused({ tools: writes });

		const meta = Option.getOrThrowWith(decodeMeta(exported.meta), () => new NoProgram({ programId: options.programId }));
		const size = options.chunkBytes ?? 100 * 1024;
		const chunks = Math.max(1, Math.ceil(exported.snapshot.length / size));

		for (let index = 0; index < chunks; index++) options.storage.put(`snap:${index}`, exported.snapshot.slice(index * size, (index + 1) * size));

		options.storage.put("meta", encodeMeta({ ...meta, programId: options.programId, chunks, reseed: options.reseed ?? null }));

		return new DurableScript(options);
	}
}
