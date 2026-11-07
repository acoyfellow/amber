export type StoredValue = string | Uint8Array;

type MaybePromise<A> = A | Promise<A>;

export type Change = { readonly put?: ReadonlyArray<readonly [string, StoredValue]>; readonly delete?: ReadonlyArray<string> };

export type ScriptStorage = {
	readonly get: (key: string) => MaybePromise<StoredValue | undefined>;
	readonly keys: (prefix: string) => MaybePromise<ReadonlyArray<string>>;
	readonly commit: (change: Change) => MaybePromise<void>;
	readonly setAlarm: (at: number) => Promise<void>;
	readonly clearAlarm: () => Promise<void>;
};

export type StorageMethods = {
	readonly get: (key: string) => StoredValue | undefined;
	readonly keys: (prefix: string) => ReadonlyArray<string>;
	readonly commit: (change: Change) => void;
};

export const storageMethods = (storage: DurableObjectStorage, prefix = "amber:"): StorageMethods => ({
	get: (key) => storage.kv.get<StoredValue>(prefix + key),
	keys: (start) => Array.from(storage.kv.list({ prefix: prefix + start }), ([key]) => key.slice(prefix.length)),
	commit: (change) =>
		storage.transactionSync(() => {
			for (const key of change.delete ?? []) storage.kv.delete(prefix + key);
			for (const [key, value] of change.put ?? []) storage.kv.put(prefix + key, value);
		}),
});

export const durableObjectStorage = (storage: DurableObjectStorage, prefix = "amber:"): ScriptStorage => ({
	...storageMethods(storage, prefix),
	setAlarm: (at) => storage.setAlarm(at),
	clearAlarm: () => storage.deleteAlarm(),
});

export type RemoteStore = {
	readonly get: (key: string) => Promise<StoredValue | undefined>;
	readonly keys: (prefix: string) => Promise<ReadonlyArray<string>>;
	readonly commit: (change: Change) => Promise<void>;
};

export type Alarms = { readonly setAlarm: (at: number) => Promise<void>; readonly clearAlarm: () => Promise<void> };

export const remoteStorage = (store: RemoteStore, alarms: Alarms): ScriptStorage => ({
	get: (key) => store.get(key),
	keys: (prefix) => store.keys(prefix),
	commit: (change) => store.commit(change),
	setAlarm: alarms.setAlarm,
	clearAlarm: alarms.clearAlarm,
});

export type MemoryStorage = ScriptStorage & { readonly data: Map<string, StoredValue>; readonly alarm: () => number | undefined };

export const memoryStorage = (): MemoryStorage => {
	const data = new Map<string, StoredValue>();
	let alarmAt: number | undefined;

	return {
		data,
		alarm: () => alarmAt,
		get: (key) => data.get(key),
		keys: (prefix) => Array.from(data.keys()).filter((key) => key.startsWith(prefix)),
		commit: (change) => {
			for (const key of change.delete ?? []) data.delete(key);
			for (const [key, value] of change.put ?? []) data.set(key, value);
		},
		setAlarm: async (at) => {
			alarmAt = at;
		},
		clearAlarm: async () => {
			alarmAt = undefined;
		},
	};
};
