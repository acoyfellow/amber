import { DurableScript, type ScriptOptions } from "./script";
import { durableObjectStorage, type ScriptStorage } from "./storage";

export type AgentLike = {
	readonly ctx: DurableObjectState;
	readonly schedule: (when: Date, callback: string) => Promise<{ readonly id: string }>;
	readonly cancelSchedule: (id: string) => Promise<boolean>;
};

const SCHEDULE_KEY = "amber:schedule";

export const agentStorage = (agent: AgentLike, callback: string): ScriptStorage => {
	const base = durableObjectStorage(agent.ctx.storage);
	const cancel = async (): Promise<void> => {
		const id = agent.ctx.storage.kv.get<string>(SCHEDULE_KEY);

		if (id !== undefined) await agent.cancelSchedule(id);

		agent.ctx.storage.kv.delete(SCHEDULE_KEY);
	};

	return {
		...base,
		setAlarm: async (at) => {
			await cancel();

			const scheduled = await agent.schedule(new Date(at), callback);

			agent.ctx.storage.kv.put(SCHEDULE_KEY, scheduled.id);
		},
		clearAlarm: cancel,
	};
};

export const attachScript = (agent: AgentLike, options: Omit<ScriptOptions, "storage"> & { readonly callback?: string }): DurableScript =>
	new DurableScript({ ...options, storage: agentStorage(agent, options.callback ?? "amberAlarm") });
