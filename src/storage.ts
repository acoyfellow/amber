export type ScriptStorage = {
	readonly get: (key: string) => string | Uint8Array | undefined;
	readonly put: (key: string, value: string | Uint8Array) => void;
	readonly delete: (key: string) => void;
	readonly keys: (prefix: string) => ReadonlyArray<string>;
	readonly setAlarm: (at: number) => Promise<void>;
	readonly clearAlarm: () => Promise<void>;
};

export const durableObjectStorage = (storage: DurableObjectStorage, prefix = "amber:"): ScriptStorage => ({
	get: (key) => storage.kv.get<string | Uint8Array>(prefix + key),
	put: (key, value) => storage.kv.put(prefix + key, value),
	delete: (key) => void storage.kv.delete(prefix + key),
	keys: (start) => Array.from(storage.kv.list({ prefix: prefix + start }), ([key]) => key.slice(prefix.length)),
	setAlarm: (at) => storage.setAlarm(at),
	clearAlarm: () => storage.deleteAlarm(),
});

export type MemoryStorage = ScriptStorage & { readonly data: Map<string, string | Uint8Array>; readonly alarm: () => number | undefined };

export const memoryStorage = (): MemoryStorage => {
	const data = new Map<string, string | Uint8Array>();
	let alarmAt: number | undefined;

	return {
		data,
		alarm: () => alarmAt,
		get: (key) => data.get(key),
		put: (key, value) => void data.set(key, value),
		delete: (key) => void data.delete(key),
		keys: (prefix) => Array.from(data.keys()).filter((key) => key.startsWith(prefix)),
		setAlarm: async (at) => {
			alarmAt = at;
		},
		clearAlarm: async () => {
			alarmAt = undefined;
		},
	};
};
