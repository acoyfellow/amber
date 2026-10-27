import { Effect, Option, Schema } from "effect";

export class EngineFailed extends Schema.TaggedError<EngineFailed>()("EngineFailed", { step: Schema.String, reason: Schema.String }) {}

type Exports = {
	readonly memory: WebAssembly.Memory;
	readonly _initialize: () => void;
	readonly dq_malloc: (size: number) => number;
	readonly dq_free: (pointer: number) => void;
	readonly dq_out: () => number;
	readonly dq_out_len: () => number;
	readonly dq_buf: () => number;
	readonly dq_buf_len: () => number;
	readonly dq_set_budget: (ticks: number) => void;
	readonly dq_init: () => number;
	readonly dq_make_base: () => number;
	readonly dq_save: (delta: number) => number;
	readonly dq_start: (source: number, length: number, typescript: number) => number;
	readonly dq_resume: (json: number, length: number) => number;
	readonly dq_restore: (base: number, baseLength: number, delta: number, deltaLength: number) => number;
};

export const Run = Schema.Literals(["done", "pending", "slice", "error"]);

export type Run = typeof Run.Type;

export type Ran = { readonly run: Run; readonly output: string };

const RUNS: ReadonlyMap<number, Run> = new Map([
	[0, "done"],
	[1, "pending"],
	[2, "slice"],
	[-1, "error"],
]);

const ESPIPE = 70;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

type Memory = { current: Option.Option<WebAssembly.Memory> };

const bytesAt = (memory: Memory, pointer: number, length: number): Uint8Array =>
	Option.match(memory.current, { onNone: () => new Uint8Array(0), onSome: (live) => new Uint8Array(live.buffer, pointer, length) });

const writeClock = (memory: Memory, out: number): number => {
	Option.map(memory.current, (live) => new DataView(live.buffer).setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true));

	return 0;
};

const writeOut = (memory: Memory, log: (line: string) => void, iovs: number, count: number, written: number): number =>
	Option.match(memory.current, {
		onNone: () => 0,
		onSome: (live) => {
			const view = new DataView(live.buffer);
			let total = 0;
			let text = "";

			for (let index = 0; index < count; index++) {
				const pointer = view.getUint32(iovs + index * 8, true);
				const length = view.getUint32(iovs + index * 8 + 4, true);

				text += decoder.decode(new Uint8Array(live.buffer, pointer, length));
				total += length;
			}

			if (text !== "") log(text);
			view.setUint32(written, total, true);

			return 0;
		},
	});

const importsFor = (memory: Memory, log: (line: string) => void): WebAssembly.Imports => ({
	env: { host_log: (pointer: number, length: number) => log(decoder.decode(bytesAt(memory, pointer, length))) },
	wasi_snapshot_preview1: {
		clock_time_get: (_clock: number, _precision: bigint, out: number) => writeClock(memory, out),
		fd_write: (_fd: number, iovs: number, count: number, written: number) => writeOut(memory, log, iovs, count, written),
		fd_close: () => 0,
		fd_seek: () => ESPIPE,
	},
});

const failed = (step: string) => (cause: unknown) => new EngineFailed({ step, reason: String(cause) });

export class Engine {
	private constructor(private readonly exports: Exports) {}

	static readonly load = (module: WebAssembly.Module, log: (line: string) => void): Effect.Effect<Engine, EngineFailed> => {
		const memory: Memory = { current: Option.none() };

		return Effect.tryPromise({ try: () => WebAssembly.instantiate(module, importsFor(memory, log)), catch: failed("instantiate") }).pipe(
			Effect.map((instance) => {
				// SAFETY: dq.wasm is built from engine/dq.c, whose exports are exactly the fields of Exports.
				const exports = instance.exports as Exports;

				memory.current = Option.some(exports.memory);
				exports._initialize();

				return new Engine(exports);
			}),
		);
	};

	private put(bytes: Uint8Array): number {
		const pointer = this.exports.dq_malloc(bytes.length + 1);
		const view = new Uint8Array(this.exports.memory.buffer, pointer, bytes.length + 1);

		view.set(bytes);
		view[bytes.length] = 0;

		return pointer;
	}

	private output(): string {
		return decoder.decode(new Uint8Array(this.exports.memory.buffer, this.exports.dq_out(), this.exports.dq_out_len()));
	}

	private buffer(): Uint8Array<ArrayBuffer> {
		return new Uint8Array(this.exports.memory.buffer, this.exports.dq_buf(), this.exports.dq_buf_len()).slice();
	}

	private ran(code: number): Effect.Effect<Ran, EngineFailed> {
		const run = RUNS.get(code);

		return run === undefined ? Effect.fail(new EngineFailed({ step: "run", reason: `unknown status ${code}` })) : Effect.succeed({ run, output: this.output() });
	}

	private withBytes<A>(bytes: Uint8Array, use: (pointer: number) => A): A {
		const pointer = this.put(bytes);

		try {
			return use(pointer);
		} finally {
			this.exports.dq_free(pointer);
		}
	}

	setBudget(ticks: number): void {
		this.exports.dq_set_budget(ticks);
	}

	init(): void {
		this.exports.dq_init();
	}

	readonly makeBase: Effect.Effect<Uint8Array<ArrayBuffer>, EngineFailed> = Effect.suspend(() =>
		this.exports.dq_make_base() < 0 ? Effect.fail(new EngineFailed({ step: "base", reason: this.output() })) : Effect.succeed(this.buffer()),
	);

	readonly saveDelta: Effect.Effect<Uint8Array<ArrayBuffer>, EngineFailed> = Effect.suspend(() =>
		this.exports.dq_save(1) < 0 ? Effect.fail(new EngineFailed({ step: "save", reason: this.output() })) : Effect.succeed(this.buffer()),
	);

	start(source: string): Effect.Effect<Ran, EngineFailed> {
		const bytes = encoder.encode(source);

		return Effect.suspend(() => this.ran(this.withBytes(bytes, (pointer) => this.exports.dq_start(pointer, bytes.length, 1))));
	}

	resume(json: Option.Option<string>): Effect.Effect<Ran, EngineFailed> {
		const bytes = encoder.encode(Option.getOrElse(json, () => ""));

		return Effect.suspend(() => this.ran(this.withBytes(bytes, (pointer) => this.exports.dq_resume(pointer, bytes.length))));
	}

	restore(base: Uint8Array, delta: Uint8Array): Effect.Effect<void, EngineFailed> {
		return Effect.suspend(() => {
			const code = this.withBytes(base, (basePointer) => this.withBytes(delta, (deltaPointer) => this.exports.dq_restore(basePointer, base.length, deltaPointer, delta.length)));

			return code < 0 ? Effect.fail(new EngineFailed({ step: "restore", reason: this.output() })) : Effect.void;
		});
	}
}

export const sha256 = (bytes: Uint8Array<ArrayBuffer>): Effect.Effect<string, EngineFailed> =>
	Effect.tryPromise({ try: () => crypto.subtle.digest("SHA-256", bytes), catch: failed("sha256") }).pipe(
		Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")),
	);
