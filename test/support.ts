import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DurableScript, type MemoryStorage, memoryStorage, type ScriptOptions, type Tools } from "../src";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

// SAFETY: Node's WebAssembly.Module is constructible; @cloudflare/workers-types declares it abstract because Workers forbid runtime compilation.
const Module = WebAssembly.Module as unknown as ModuleConstructor;

export const wasm = new Module(readFileSync(fileURLToPath(new URL("../engine/dq.wasm", import.meta.url))));

export type Clock = { now: number };

export const scriptWith = (tools: Tools, overrides: Partial<ScriptOptions> = {}): { readonly script: DurableScript; readonly storage: MemoryStorage; readonly clock: Clock } => {
	const storage = memoryStorage();
	const clock = { now: 1_000_000 };
	const script = new DurableScript({ programId: "p1", storage, tools, wasm, now: () => clock.now, ...overrides });

	return { script, storage, clock };
};
