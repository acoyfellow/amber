import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { CodemodeResultJson } from "../../shared/codemode";
import { BENCH_COOLDOWN_MS, BENCH_SYSTEMS, type BenchBoard, BenchBoardJson, BenchResult, BenchResultJson, type BenchSystem } from "../../shared/bench";

const KEEP_RUNS = 20;

const decodeResult = Schema.decodeUnknownOption(BenchResultJson);

const encodeResult = Schema.encodeSync(BenchResultJson);

const decodeRuns = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(BenchResult)));

const encodeRuns = Schema.encodeSync(Schema.fromJsonString(Schema.Array(BenchResult)));

const decodeCodemode = Schema.decodeUnknownOption(CodemodeResultJson);

const encodeCodemode = Schema.encodeSync(CodemodeResultJson);

const encodeBoard = Schema.encodeSync(BenchBoardJson);

export class BenchStore extends DurableObject {
	private latest(system: BenchSystem): Option.Option<BenchResult> {
		return decodeResult(this.ctx.storage.kv.get<string>(`latest:${system}`));
	}

	private runs(): ReadonlyArray<BenchResult> {
		return Option.getOrElse(decodeRuns(this.ctx.storage.kv.get<string>("runs")), () => []);
	}

	fresh(system: BenchSystem, now: number): string | null {
		return Option.match(Option.filter(this.latest(system), (result) => now - result.ranAt < BENCH_COOLDOWN_MS), { onNone: () => null, onSome: encodeResult });
	}

	record(text: string): void {
		Option.match(decodeResult(text), {
			onNone: () => undefined,
			onSome: (result) => {
				this.ctx.storage.kv.put(`latest:${result.system}`, encodeResult(result));
				this.ctx.storage.kv.put("runs", encodeRuns([result, ...this.runs()].slice(0, KEEP_RUNS)));
			},
		});
	}

	freshCodemode(now: number): string | null {
		return Option.match(
			Option.filter(decodeCodemode(this.ctx.storage.kv.get<string>("codemode")), (result) => now - result.ranAt < BENCH_COOLDOWN_MS),
			{ onNone: () => null, onSome: encodeCodemode },
		);
	}

	recordCodemode(text: string): void {
		Option.map(decodeCodemode(text), (result) => this.ctx.storage.kv.put("codemode", encodeCodemode(result)));
	}

	codemode(): string | null {
		return this.ctx.storage.kv.get<string>("codemode") ?? null;
	}

	board(): string {
		const board: BenchBoard = { latest: BENCH_SYSTEMS.flatMap((system) => Option.toArray(this.latest(system))), runs: this.runs() };

		return encodeBoard(board);
	}
}
