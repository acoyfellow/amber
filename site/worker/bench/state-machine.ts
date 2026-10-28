import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { type ApprovalState, ApprovalStateJson, LoopReplyJson, MachineReplyJson } from "../../shared/bench";

const encodeState = Schema.encodeSync(ApprovalStateJson);

const decodeState = Schema.decodeUnknownOption(ApprovalStateJson);

const encodeReply = Schema.encodeSync(MachineReplyJson);

const encodeLoop = Schema.encodeSync(LoopReplyJson);

export const loopSum = (limit: number): number => {
	let sum = 0;

	for (let i = 0; i < limit; i++) sum += i % 1000;

	return sum;
};

export class StateMachineProgram extends DurableObject {
	private readonly object = crypto.randomUUID().slice(0, 8);

	private load(): ApprovalState {
		return Option.getOrElse(decodeState(this.ctx.storage.kv.get<string>("state")), () => ({ total: 0, next: 0, decided: [] }));
	}

	private save(state: ApprovalState): string {
		const stored = encodeState(state);

		this.ctx.storage.kv.put("state", stored);

		return encodeReply({ state, object: this.object, storedBytes: stored.length });
	}

	begin(total: number): string {
		return this.save({ total, next: 0, decided: [] });
	}

	answer(ok: boolean): string {
		const state = this.load();

		if (state.next >= state.total) return encodeReply({ state, object: this.object, storedBytes: 0 });

		return this.save({ ...state, next: state.next + 1, decided: [...state.decided, { id: state.next, ok }] });
	}

	loop(limit: number): string {
		return encodeLoop({ sum: loopSum(limit), object: this.object });
	}

	kill(): void {
		this.ctx.abort("killed by the benchmark");
	}
}
