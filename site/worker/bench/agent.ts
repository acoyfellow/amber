import { Agent } from "agents";
import { Schema } from "effect";
import { type ApprovalState, ApprovalStateJson, LoopReplyJson, MachineReplyJson } from "../../shared/bench";
import { loopSum } from "./state-machine";

const encodeState = Schema.encodeSync(ApprovalStateJson);

const encodeReply = Schema.encodeSync(MachineReplyJson);

const encodeLoop = Schema.encodeSync(LoopReplyJson);

export class ApprovalsAgent extends Agent<Cloudflare.Env, ApprovalState> {
	override initialState: ApprovalState = { total: 0, next: 0, decided: [] };

	private readonly object = crypto.randomUUID().slice(0, 8);

	private commit(state: ApprovalState): string {
		this.setState(state);

		return encodeReply({ state, object: this.object, storedBytes: encodeState(state).length });
	}

	begin(total: number): string {
		return this.commit({ total, next: 0, decided: [] });
	}

	answer(ok: boolean): string {
		const state = this.state;

		if (state.next >= state.total) return encodeReply({ state, object: this.object, storedBytes: 0 });

		return this.commit({ ...state, next: state.next + 1, decided: [...state.decided, { id: state.next, ok }] });
	}

	loop(limit: number): string {
		return encodeLoop({ sum: loopSum(limit), object: this.object });
	}

	kill(): void {
		this.ctx.abort("killed by the benchmark");
	}
}
