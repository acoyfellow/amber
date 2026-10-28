import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { AnswerEvent, APPROVAL_COUNT, type Decision, LOOP_LIMIT, type Progress, ProgressJson, type WorkflowParams } from "../../shared/bench";
import { loopSum } from "./state-machine";

const encodeProgress = Schema.encodeSync(ProgressJson);

const decodeProgress = Schema.decodeUnknownOption(ProgressJson);

const decodeAnswer = Schema.decodeUnknownSync(AnswerEvent);

export class BenchProgress extends DurableObject {
	private load(): Progress {
		return Option.getOrElse(decodeProgress(this.ctx.storage.kv.get<string>("progress")), () => ({ ready: -1, recorded: 0 }));
	}

	markReady(id: number): void {
		this.ctx.storage.kv.put("progress", encodeProgress({ ...this.load(), ready: id }));
	}

	markRecorded(recorded: number): void {
		this.ctx.storage.kv.put("progress", encodeProgress({ ...this.load(), recorded }));
	}

	read(): string {
		return encodeProgress(this.load());
	}
}

type BenchEnv = { readonly BENCH_PROGRESS: DurableObjectNamespace<BenchProgress> };

export class BenchWorkflow extends WorkflowEntrypoint<BenchEnv, WorkflowParams> {
	override async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<{ readonly decided?: ReadonlyArray<Decision>; readonly sum?: number }> {
		if (event.payload.mode === "loop") return { sum: await step.do("loop", async () => loopSum(LOOP_LIMIT)) };

		const progress = this.env.BENCH_PROGRESS.getByName(event.payload.progress);
		const decided: Array<Decision> = [];

		for (let id = 0; id < APPROVAL_COUNT; id++) {
			await step.do(`ready ${id}`, async () => progress.markReady(id));

			const answer = await step.waitForEvent<{ ok: boolean }>(`answer ${id}`, { type: `answer-${id}`, timeout: "1 hour" });
			const { ok } = decodeAnswer(answer.payload);

			decided.push(
				await step.do(`record ${id}`, async () => {
					await progress.markRecorded(id + 1);

					return { id, ok };
				}),
			);
		}

		return { decided };
	}
}
