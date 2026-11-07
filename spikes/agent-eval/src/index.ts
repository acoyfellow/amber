import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { DurableScript, durableObjectStorage, external, type Outcome, read, type Tools, write } from "../../../src";
import wasm from "../../../engine/dq.wasm";
import { answerFor, familyById, score, variantOf, type Variant } from "./tasks";
import { duplicateEffects, EFFECT_TOOLS, ledgerFrom, type Ledger, runFixtureTool, TOOL_DECLARATIONS, TOOL_SCHEMAS } from "./world";

type Env = {
	AI: Ai;
	WORLD: DurableObjectNamespace<World>;
	LOOP: DurableObjectNamespace<LoopHarness>;
	RUNNER: DurableObjectNamespace<ScriptRunner>;
	PROGRAMS: DurableObjectNamespace<ProgramStore>;
	SPEND: DurableObjectNamespace<Spend>;
	SPEND_CAP_USD: string;
};

export type Arm = "loop" | "fresh" | "reuse";

export type RunSpec = { runId: string; family: string; variant: number; arm: Arm; model: string; seed: number };

type Bucket = "loop" | "generate" | "repair" | "llm";

type Usage = Record<Bucket, { calls: number; inputTokens: number; outputTokens: number }>;

type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: Array<ToolCallMessage>; tool_call_id?: string };

type ToolCallMessage = { id: string; type: "function"; function: { name: string; arguments: string } };

type ChatReply = {
	choices?: Array<{ message: { content: string | null; tool_calls?: Array<ToolCallMessage> }; finish_reason: string }>;
	usage?: { prompt_tokens: number; completion_tokens: number };
};

export const PRICES: Record<string, { input: number; output: number }> = {
	"@cf/zai-org/glm-5.3": { input: 1.4, output: 4.4 },
	"@cf/zai-org/glm-5.3-flash": { input: 0.15, output: 0.5 },
};

const priceOf = (model: string) => {
	const price = PRICES[model];
	if (!price) throw new Error(`no price for ${model}`);
	return price;
};

const usd = (model: string, input: number, output: number) => (input * priceOf(model).input + output * priceOf(model).output) / 1_000_000;

const MAX_LOOP_TURNS = 40;
const MAX_SCRIPT_STEPS = 600;
const KILLS_PER_RUN = 2;
const KILL_WINDOW = 6;
const MAX_SOURCE = 12_000;
const MAX_PROGRAM_TOKENS = 32_000;
const MIN_PROGRAM_CHARS = 40;
const LEASE_MS = 20 * 60_000;
let boot: string | undefined;
const bootId = () => (boot ??= crypto.randomUUID());

const killPlan = (seed: number, key: string): Array<number> => {
	let state = [...`${key}:${seed}`].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	const picks = new Set<number>();
	while (picks.size < KILLS_PER_RUN) picks.add(1 + (next() % KILL_WINDOW));
	return [...picks].sort((a, b) => a - b);
};

const RETRYABLE_AI = /\b(3021|3040|3046)\b|rate limit|capacity|timed? ?out/i;
const MAX_AI_ATTEMPTS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class BudgetExceeded extends Error {
	override readonly name = "BudgetExceeded";
}

const chat = async (env: Env, world: DurableObjectStub<World>, bucket: Bucket, messages: ReadonlyArray<Message>, tools?: unknown, maxTokens = 4096): Promise<ChatReply> => {
	const spec = await world.spec();
	const spent = await env.SPEND.getByName("total").total();
	if (spent >= Number(env.SPEND_CAP_USD)) throw new BudgetExceeded(`spend ${spent.toFixed(4)} reached cap ${env.SPEND_CAP_USD}`);
	for (let attempt = 1; ; attempt++) {
		try {
			const reply = (await env.AI.run(spec.model as never, { messages, ...(tools ? { tools } : {}), max_tokens: maxTokens, seed: spec.seed } as never)) as ChatReply;
			const input = reply.usage?.prompt_tokens ?? 0;
			const output = reply.usage?.completion_tokens ?? 0;
			await world.addUsage(bucket, input, output);
			await env.SPEND.getByName("total").add(usd(spec.model, input, output));
			return reply;
		} catch (error) {
			if (attempt >= MAX_AI_ATTEMPTS || !RETRYABLE_AI.test(String(error))) throw error;
			await world.countRetry();
			await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
		}
	}
};

export class Spend extends DurableObject<Env> {
	add(amount: number): number {
		const total = (this.ctx.storage.kv.get<number>("usd") ?? 0) + amount;
		this.ctx.storage.kv.put("usd", total);
		return total;
	}

	total(): number {
		return this.ctx.storage.kv.get<number>("usd") ?? 0;
	}
}

type StoredProgram = { hash: string; source: string; fromRun: string; repairs: number; history: Array<{ hash: string; fromRun: string; reason: string }> };

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class ProgramStore extends DurableObject<Env> {
	get(key: string): StoredProgram | null {
		return this.ctx.storage.kv.get<StoredProgram>(`p:${key}`) ?? null;
	}

	async put(key: string, source: string, fromRun: string, reason: string): Promise<StoredProgram> {
		const hash = await sha256(source);
		const previous = this.get(key);
		const stored: StoredProgram = {
			hash,
			source,
			fromRun,
			repairs: previous ? previous.repairs + (reason === "repair" ? 1 : 0) : 0,
			history: [...(previous?.history ?? []), { hash, fromRun, reason }],
		};
		this.ctx.storage.kv.put(`p:${key}`, stored);
		this.ctx.storage.kv.put(`h:${hash}`, source);
		return stored;
	}

	all(): Record<string, StoredProgram> {
		return Object.fromEntries(Array.from(this.ctx.storage.kv.list<StoredProgram>({ prefix: "p:" }), ([key, value]) => [key.slice(2), value]));
	}
}

type ScriptState = { attempt: number; programId: string; source: string; hash: string; reused: boolean };

type WorldState = {
	spec: RunSpec;
	ledger: Ledger;
	kills: Array<number>;
	killsDone: Array<number>;
	startedAt: number;
	finishedAt?: number;
	outcome?: string;
	notes: Array<string>;
	usage: Usage;
	retries: number;
	lease?: { token: string; at: number; boot?: string };
	appliedKeys: Record<string, string>;
	keyedRetries: number;
	script?: ScriptState;
};

const emptyUsage = (): Usage => ({
	loop: { calls: 0, inputTokens: 0, outputTokens: 0 },
	generate: { calls: 0, inputTokens: 0, outputTokens: 0 },
	repair: { calls: 0, inputTokens: 0, outputTokens: 0 },
	llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
});

export class World extends DurableObject<Env> {
	private read(): WorldState {
		const stored = this.ctx.storage.kv.get<string>("state");
		if (!stored) throw new Error("world not initialised");
		return JSON.parse(stored);
	}

	private save(state: WorldState): void {
		this.ctx.storage.kv.put("state", JSON.stringify(state));
	}

	init(spec: RunSpec): void {
		if (this.ctx.storage.kv.get("state")) return;
		this.save({
			spec,
			ledger: ledgerFrom(variantOf(spec.family, spec.variant).fixture),
			kills: killPlan(spec.seed, `${spec.family}:${spec.variant}:${spec.arm}`),
			killsDone: [],
			startedAt: Date.now(),
			notes: [],
			usage: emptyUsage(),
			retries: 0,
			appliedKeys: {},
			keyedRetries: 0,
		});
	}

	claim(token: string): "mine" | "busy" | "finished" {
		const state = this.read();
		if (state.finishedAt) return "finished";
		if (state.lease && state.lease.token !== token && state.lease.boot === bootId() && Date.now() - state.lease.at < LEASE_MS) return "busy";
		state.lease = { token, at: Date.now(), boot: bootId() };
		this.save(state);
		return "mine";
	}

	spec(): RunSpec {
		return this.read().spec;
	}

	scriptState(): string | null {
		const script = this.read().script;
		return script ? JSON.stringify(script) : null;
	}

	setScript(script: ScriptState): void {
		const state = this.read();
		state.script = script;
		this.save(state);
	}

	tool(name: string, args: Record<string, unknown>, key?: string): { resultJson: string; killNow: boolean } {
		const state = this.read();
		const variant = variantOf(state.spec.family, state.spec.variant);
		if (state.lease) state.lease.at = Date.now();
		state.ledger.toolCalls += 1;
		let result: unknown;
		const applied = key ? state.appliedKeys[key] : undefined;
		if (applied !== undefined) {
			state.keyedRetries += 1;
			result = JSON.parse(applied);
		} else if (name === "ask_user") {
			const question = String(args.question ?? "");
			const answer = answerFor(variant, question);
			state.ledger.asks.push({ question, answer });
			state.ledger.events.push("ask");
			result = answer;
		} else if (name === "input") {
			result = variant.input;
		} else {
			result = runFixtureTool(state.ledger, name, args);
			if (key && EFFECT_TOOLS.has(name)) state.appliedKeys[key] = JSON.stringify(result ?? null);
		}
		const boundary = state.ledger.toolCalls;
		const killNow = state.kills.includes(boundary) && !state.killsDone.includes(boundary);
		if (killNow) {
			state.killsDone.push(boundary);
			state.ledger.resumed = true;
		}
		this.save(state);
		return { resultJson: JSON.stringify(result ?? null), killNow };
	}

	countRetry(): void {
		const state = this.read();
		state.retries += 1;
		this.save(state);
	}

	addUsage(bucket: Bucket, input: number, output: number): void {
		const state = this.read();
		state.usage[bucket].calls += 1;
		state.usage[bucket].inputTokens += input;
		state.usage[bucket].outputTokens += output;
		if (state.lease) state.lease.at = Date.now();
		this.save(state);
	}

	note(text: string): void {
		const state = this.read();
		state.notes.push(text.slice(0, 1500));
		this.save(state);
	}

	finish(outcome: string): void {
		const state = this.read();
		if (state.finishedAt) return;
		state.finishedAt = Date.now();
		state.outcome = outcome;
		this.save(state);
	}

	finished(): boolean {
		return Boolean(this.read().finishedAt);
	}

	report() {
		const state = this.read();
		const variant = variantOf(state.spec.family, state.spec.variant);
		const graded = score(variant.check(state.ledger));
		const dupes = duplicateEffects(state.ledger);
		const buckets = Object.entries(state.usage) as Array<[Bucket, Usage[Bucket]]>;
		const total = buckets.reduce((sum, [, u]) => ({ calls: sum.calls + u.calls, inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens }), { calls: 0, inputTokens: 0, outputTokens: 0 });
		const cost = (u: { inputTokens: number; outputTokens: number }) => usd(state.spec.model, u.inputTokens, u.outputTokens);
		return {
			...state.spec,
			outcome: state.outcome ?? "unfinished",
			pass: graded.pass,
			score: graded.score,
			failedChecks: graded.failed,
			llmCalls: total.calls,
			inputTokens: total.inputTokens,
			outputTokens: total.outputTokens,
			usd: cost(total),
			usage: Object.fromEntries(buckets.map(([bucket, u]) => [bucket, { ...u, usd: cost(u) }])),
			wallMs: (state.finishedAt ?? Date.now()) - state.startedAt,
			killsPlanned: state.kills,
			killsInjected: state.killsDone.length,
			repeatedEffects: dupes.total,
			repeatedEffectsAfterKill: dupes.afterKill,
			keyedRetries: state.keyedRetries,
			humanPrompts: state.ledger.asks.length,
			toolCalls: state.ledger.toolCalls,
			aiRetries: state.retries,
			program: state.script ? { hash: state.script.hash.slice(0, 12), reused: state.script.reused, attempt: state.script.attempt, chars: state.script.source.length } : null,
			notes: state.notes,
		};
	}
}

const LOOP_SYSTEM = `You are an operations agent working on a software project through tools.
Use the tools to complete the task fully. Never invent tool results. When the task says to ask the user, call ask_user and wait for the answer before acting.
When everything is done, reply with a short summary and no tool call.`;

const toolsForLoop = TOOL_SCHEMAS.map((t) => ({
	type: "function",
	function: { name: t.name, description: t.description, parameters: { type: "object", properties: t.parameters, required: [...t.required] } },
}));

const parseArgs = (raw: string): Record<string, unknown> => {
	try {
		const parsed = JSON.parse(raw || "{}");
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
};

export class LoopHarness extends DurableObject<Env> {
	private transcript(): Array<Message> {
		return JSON.parse(this.ctx.storage.kv.get<string>("transcript") ?? "[]");
	}

	private save(messages: ReadonlyArray<Message>): void {
		this.ctx.storage.kv.put("transcript", JSON.stringify(messages));
	}

	async run(runId: string): Promise<string> {
		const world = this.env.WORLD.getByName(runId);
		const spec = await world.spec();
		const variant = variantOf(spec.family, spec.variant);
		let messages = this.transcript();
		if (messages.length === 0) {
			messages = [
				{ role: "system", content: LOOP_SYSTEM },
				{ role: "user", content: variant.prompt },
			];
			this.save(messages);
		}
		for (let turn = 0; turn < MAX_LOOP_TURNS * 4; turn++) {
			const last = messages.at(-1);
			if (!last) throw new Error("empty transcript");
			const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
			const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
			const open = (lastAssistant?.tool_calls ?? []).filter((call) => !answered.has(call.id));
			if (open.length > 0) {
				const [call] = open;
				if (!call) throw new Error("no open call");
				const { resultJson, killNow } = await world.tool(call.function.name, parseArgs(call.function.arguments));
				if (killNow) this.ctx.abort("injected kill");
				messages = [...messages, { role: "tool", tool_call_id: call.id, content: resultJson }];
				this.save(messages);
				continue;
			}
			if (last.role === "assistant") return "done";
			if (messages.filter((m) => m.role === "assistant").length >= MAX_LOOP_TURNS) return "turn-limit";
			const reply = await chat(this.env, world, "loop", messages, toolsForLoop);
			const message = reply.choices?.[0]?.message;
			if (!message) {
				await world.note(`empty model reply: ${JSON.stringify(reply).slice(0, 400)}`);
				return "model-error";
			}
			messages = [...messages, { role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }];
			this.save(messages);
		}
		return "step-limit";
	}
}

const Loose = Schema.Unknown;

const asArgs = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const READ_TOOLS = ["list_issues", "get_issue", "list_prs", "fetch_ci", "input"] as const;

const WRITE_TOOLS = ["label", "close", "post_comment", "merge_pr", "create_release", "notify"] as const;

export class ScriptRunner extends DurableObject<Env> {
	private readonly script: DurableScript;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const world = () => env.WORLD.getByName(ctx.storage.kv.get<string>("runId") ?? "");
		const call = async (name: string, args: Record<string, unknown>, key?: string) => {
			const done = await world().tool(name, args, key);
			if (done.killNow) ctx.abort("injected kill");
			return JSON.parse(done.resultJson) as unknown;
		};
		const tools: Tools = {
			...Object.fromEntries(READ_TOOLS.map((name) => [name, read(Loose, (args) => call(name, asArgs(args)))])),
			...Object.fromEntries(WRITE_TOOLS.map((name) => [name, write(Loose, (args, { key }) => call(name, asArgs(args), key))])),
			llm: read(Loose, async (args) => {
				const reply = await chat(env, world(), "llm", [{ role: "user", content: String(asArgs(args).prompt ?? "") }]);
				return reply.choices?.[0]?.message?.content ?? "";
			}),
			ask_user: external(Loose, { timeoutMs: 3_600_000 }),
		};
		this.script = new DurableScript({ programId: ctx.id.toString(), storage: durableObjectStorage(ctx.storage), wasm, tools, recoveryDelayMs: 5_000 });
	}

	start(runId: string, source: string): Promise<Outcome> {
		this.ctx.storage.kv.put("runId", runId);
		return this.script.run(source);
	}

	recover(): Promise<Outcome> {
		return this.script.recover();
	}

	answer(token: string, value: unknown): Promise<Outcome> {
		return this.script.answer(token, value);
	}

	kill(): void {
		this.ctx.abort("injected kill");
	}

	doneCalls(): Array<string> {
		const seen = Option.getOrNull(this.script.inspect());
		return (seen?.history ?? []).filter((h) => h.kind === "write" || h.kind === "external").map((h) => `${h.name}(${JSON.stringify(h.args)})`);
	}

	override async alarm(): Promise<void> {
		await this.script.alarm();
	}
}

const shapeOf = (input: Record<string, unknown>) => `type Input = { ${Object.entries(input).map(([key, value]) => `${key}: ${typeof value}`).join("; ")} };`;

const SCRIPT_RULES = `You write ONE JavaScript program that completes an operations task. The program runs in a durable sandbox.
Rules:
- The only way to reach the outside world is the synchronous function tool(name, args). It returns the result directly. Do NOT use await, async, Promise, fetch, setTimeout, imports, or console.
- Read the task parameters with tool("input", {}).
- tool("ask_user", { question }) asks the human and returns their answer as a string. Interpret the answer with your own string checks or with tool("llm", ...).
- tool("llm", { prompt }) asks a language model for a judgment and returns its text answer. Use it for classification or writing text; ask it to answer in a strict format and parse that.
- The program body is wrapped in a function, so end with: return { done: true, summary: "..." };
- Plain JavaScript only, no type annotations. Keep it under 8000 characters. Reply with only the program in one \`\`\`js code block.`;

const REUSE_RULES = `This program is stored and reused on many different inputs with zero changes. Never hardcode issue ids, PR ids, versions, CI run ids, channels, counts, thresholds or answers. Get every specific value from tool("input", {}) or from the other tools at run time.`;

const declarations = (variant: Variant) => `Tool declarations:\n${TOOL_DECLARATIONS}\n${shapeOf(variant.input)}\ndeclare function tool(name: "input", args: {}): Input;`;

const extractCode = (text: string): string => {
	const fenced = text.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/);
	return (fenced?.[1] ?? text).trim();
};

const wrapProgram = (code: string): string => `(() => {\n${code}\n})();`;

const generate = async (env: Env, world: DurableObjectStub<World>, spec: RunSpec, bucket: Bucket, repair?: { source: string; error: string; doneCalls: Array<string> }): Promise<string> => {
	const variant = variantOf(spec.family, spec.variant);
	const reuse = spec.arm === "reuse";
	const task = reuse ? familyById(spec.family).template : variant.prompt;
	const messages: Array<Message> = [
		{ role: "system", content: `${SCRIPT_RULES}${reuse ? `\n${REUSE_RULES}` : ""}\n\n${declarations(variant)}` },
		{ role: "user", content: `Task:\n${task}` },
	];
	if (repair) {
		messages.push({ role: "assistant", content: `\`\`\`js\n${repair.source}\n\`\`\`` });
		messages.push({
			role: "user",
			content: `The program failed with:\n${repair.error}\n\nThese side-effect calls already ran before the failure and are real:\n${repair.doneCalls.join("\n") || "(none)"}\n\nWrite a corrected complete program.${reuse ? " It will be reused on other inputs, so keep it general, and before each action check the current state (labels, comments, state) so it does not repeat work that is already done." : " Do not repeat side effects that already happened."}`,
		});
	}
	const reply = await chat(env, world, bucket, messages, undefined, MAX_PROGRAM_TOKENS);
	if (reply.choices?.[0]?.finish_reason === "length") await world.note(`${bucket} reply hit max_tokens`);
	return extractCode(reply.choices?.[0]?.message?.content ?? "");
};

const isKill = (error: unknown) => /injected kill|abort|Network connection lost|object reset|was reset|exceeded/i.test(String(error));

const runnerFor = (env: Env, programId: string) => env.RUNNER.getByName(programId);

const withRecovery = async (env: Env, programId: string, step: () => Promise<Outcome>, world: DurableObjectStub<World>): Promise<Outcome> => {
	for (let attempt = 0; attempt < 12; attempt++) {
		try {
			return attempt === 0 ? await step() : await runnerFor(env, programId).recover();
		} catch (error) {
			if (!isKill(error)) throw error;
			await world.note(`runner restarted after: ${String(error).slice(0, 120)}`);
			await sleep(200);
		}
	}
	throw new Error("runner did not recover after 12 restarts");
};

const programKey = (spec: RunSpec) => `${spec.model}:${spec.family}`;

const failureText = (outcome: Outcome) => (outcome._tag === "Failed" ? `${outcome.error}: ${outcome.message}` : "");

const runScript = async (env: Env, world: DurableObjectStub<World>, spec: RunSpec): Promise<string> => {
	const saved = await world.scriptState();
	let state: ScriptState | null = saved ? (JSON.parse(saved) as ScriptState) : null;
	const store = env.PROGRAMS.getByName("global");
	let outcome: Outcome;
	if (!state) {
		const found = spec.arm === "reuse" ? await store.get(programKey(spec)) : null;
		const stored = found && found.source.length >= MIN_PROGRAM_CHARS ? found : null;
		const source = stored?.source ?? (await generate(env, world, spec, "generate"));
		const hash = stored?.hash ?? (spec.arm === "reuse" ? (await store.put(programKey(spec), source, spec.runId, "generate")).hash : await sha256(source));
		state = { attempt: 0, programId: `${spec.runId}-a0`, source, hash, reused: Boolean(stored) };
		await world.setScript(state);
		await world.note(`program a0 ${state.reused ? "reused" : "generated"} ${hash.slice(0, 12)} (${source.length} chars)`);
		outcome = await startProgram(env, world, spec.runId, state.programId, source);
	} else {
		const programId = state.programId;
		outcome = await withRecovery(env, programId, () => runnerFor(env, programId).recover(), world);
	}
	for (let step = 0; step < MAX_SCRIPT_STEPS; step++) {
		if (outcome._tag === "Finished") return "done";
		if (outcome._tag === "Failed") {
			await world.note(`attempt ${state.attempt} failed: ${failureText(outcome).slice(0, 600)}`);
			if (state.attempt >= 1) return "script-failed";
			const doneCalls = await runnerFor(env, state.programId).doneCalls();
			const source = await generate(env, world, spec, "repair", { source: state.source, error: failureText(outcome), doneCalls });
			const hash = spec.arm === "reuse" ? (await store.put(programKey(spec), source, spec.runId, "repair")).hash : await sha256(source);
			state = { attempt: 1, programId: `${spec.runId}-a1`, source, hash, reused: state.reused };
			await world.setScript(state);
			await world.note(`program a1 repaired ${hash.slice(0, 12)} (${source.length} chars)`);
			outcome = await startProgram(env, world, spec.runId, state.programId, source);
			continue;
		}
		const programId = state.programId;
		if (outcome._tag === "Running") {
			await sleep(100);
			outcome = await withRecovery(env, programId, () => runnerFor(env, programId).recover(), world);
			continue;
		}
		const waiting = outcome;
		const args = (waiting.args ?? {}) as Record<string, unknown>;
		const done = await world.tool(waiting.name, args);
		if (done.killNow) await runnerFor(env, programId).kill().catch(() => undefined);
		const answer = JSON.parse(done.resultJson) as unknown;
		outcome = await withRecovery(env, programId, () => runnerFor(env, programId).answer(waiting.token, answer), world);
	}
	return "step-limit";
};

const startProgram = async (env: Env, world: DurableObjectStub<World>, runId: string, programId: string, source: string): Promise<Outcome> => {
	const wrapped = wrapProgram(source);
	if (source.length < MIN_PROGRAM_CHARS) return { _tag: "Failed", error: "EmptyProgram", message: `the model returned ${source.length} characters of code, likely cut off at max_tokens` };
	if (wrapped.length > MAX_SOURCE) return { _tag: "Failed", error: "TooLong", message: `program is ${wrapped.length} characters; the limit is ${MAX_SOURCE}` };
	return withRecovery(env, programId, () => runnerFor(env, programId).start(runId, wrapped), world);
};

const drive = async (env: Env, spec: RunSpec): Promise<void> => {
	const world = env.WORLD.getByName(spec.runId);
	const errors: Array<string> = [];
	for (let attempt = 0; attempt <= 10; attempt++) {
		try {
			const outcome = spec.arm === "loop" ? await env.LOOP.getByName(spec.runId).run(spec.runId) : await runScript(env, world, spec);
			await world.finish(outcome);
			return;
		} catch (error) {
			if (error instanceof BudgetExceeded || /BudgetExceeded/.test(String(error))) {
				await world.note(String(error));
				await world.finish("budget-stop");
				return;
			}
			if (isKill(error)) continue;
			errors.push(String(error).slice(0, 300));
			await world.note(`harness error: ${String(error).slice(0, 500)}`);
			if (errors.length >= 2) {
				await world.finish("harness-error");
				return;
			}
		}
	}
	await world.finish("restart-limit");
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/run") {
			const spec: RunSpec = {
				runId: url.searchParams.get("runId") ?? crypto.randomUUID(),
				family: url.searchParams.get("family") ?? "triage",
				variant: Number(url.searchParams.get("variant") ?? 1),
				arm: (url.searchParams.get("arm") ?? "loop") as Arm,
				model: url.searchParams.get("model") ?? "@cf/zai-org/glm-5.3",
				seed: Number(url.searchParams.get("seed") ?? 1),
			};
			priceOf(spec.model);
			const world = env.WORLD.getByName(spec.runId);
			await world.init(spec);
			const token = crypto.randomUUID();
			let claim = await world.claim(token);
			for (let waited = 0; claim === "busy" && waited < 3_600_000; waited += 5_000) {
				await sleep(5_000);
				claim = await world.claim(token);
			}
			if (claim === "mine") await drive(env, spec);
			return Response.json({ ...(await world.report()), claim });
		}
		if (url.pathname === "/report") return Response.json(await env.WORLD.getByName(url.searchParams.get("runId") ?? "").report());
		if (url.pathname === "/programs") return Response.json(await env.PROGRAMS.getByName("global").all());
		if (url.pathname === "/spend") return Response.json({ usd: await env.SPEND.getByName("total").total(), cap: Number(env.SPEND_CAP_USD) });
		return new Response("GET /run?family=&variant=&arm=loop|fresh|reuse&model=&runId=  /report?runId=  /programs  /spend", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
