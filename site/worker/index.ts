import { Effect, Layer, Option, Result, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AnswerOutcomeJson, AnswerText, ProgramId, ProgramRpcs, ProgramUnavailable, RPC_PATH, SnapshotJson, Source } from "../shared/protocol";
import { BENCH_PATH, BenchResultJson, BenchRunJson, BenchSystem } from "../shared/bench";
import { CodemodeResultJson, CodemodeRunJson } from "../shared/codemode";
import { ApprovalsAgent } from "./bench/agent";
import { runCodemode } from "./bench/codemode";
import { ReplayRunner } from "./bench/replay";
import { type BenchEnv, runBench } from "./bench/run";
import { StateMachineProgram } from "./bench/state-machine";
import { BenchStore } from "./bench/store";
import { BenchProgress, BenchWorkflow } from "./bench/workflow";
import { Program } from "./program";

export { ReplayRunner };

export { ApprovalsAgent, BenchProgress, BenchStore, BenchWorkflow, Program, StateMachineProgram };

type Env = BenchEnv & { readonly REPLAY: DurableObjectNamespace<ReplayRunner> } & { readonly BENCH_STORE: DurableObjectNamespace<BenchStore>; readonly ASSETS: Fetcher };

const decodeSnapshot = Schema.decodeEffect(SnapshotJson);

const decodeAnswer = Schema.decodeEffect(AnswerOutcomeJson);

const decodeId = Schema.decodeUnknownOption(ProgramId);

const decodeSource = Schema.decodeUnknownOption(Source);

const decodeAnswerText = Schema.decodeUnknownOption(AnswerText);

const unavailable = (cause: unknown) => new ProgramUnavailable({ reason: String(cause) });

const call = <A>(promise: () => Promise<A>): Effect.Effect<A, ProgramUnavailable> => Effect.tryPromise({ try: promise, catch: unavailable });

const programFor = (env: Env, id: ProgramId) => env.PROGRAM.getByName(id);

const snapshot = (env: Env, id: ProgramId) => call(() => programFor(env, id).snapshot(id)).pipe(Effect.flatMap(decodeSnapshot), Effect.catchTag("SchemaError", Effect.die));

const kills = (env: Env, id: ProgramId) => snapshot(env, id).pipe(Effect.map((current) => current.kills.length));

const kill = (env: Env, id: ProgramId) =>
	Effect.gen(function* () {
		const before = yield* kills(env, id);

		yield* call(() => programFor(env, id).kill(id)).pipe(
			Effect.catchTag("ProgramUnavailable", (dropped) => kills(env, id).pipe(Effect.flatMap((after) => (after > before ? Effect.void : Effect.fail(dropped))))),
		);
	});

const handlers = (env: Env) =>
	ProgramRpcs.toLayer({
		Snapshot: ({ id }) => snapshot(env, id),
		Start: ({ id, source }) => call(() => programFor(env, id).start(id, source)).pipe(Effect.flatMap(decodeSnapshot), Effect.catchTag("SchemaError", Effect.die)),
		Answer: ({ id, answer }) =>
			call(() => programFor(env, id).answer(id, answer)).pipe(Effect.flatMap(decodeAnswer), Effect.catchTag("SchemaError", Effect.die), Effect.flatMap(Effect.fromResult)),
		Kill: ({ id }) => kill(env, id),
	});

const buildRpcHandler = (env: Env) =>
	HttpRouter.toWebHandler(
		RpcServer.layerHttp({ group: ProgramRpcs, path: RPC_PATH, protocol: "http" }).pipe(Layer.provide(handlers(env)), Layer.provide(RpcSerialization.layerJson)),
		{ disableLogger: true },
	).handler;

const rpcHandlers = new WeakMap<Env, ReturnType<typeof buildRpcHandler>>();

const rpcHandler = (env: Env): ReturnType<typeof buildRpcHandler> => {
	const cached = rpcHandlers.get(env);

	if (cached !== undefined) return cached;

	const built = buildRpcHandler(env);

	rpcHandlers.set(env, built);

	return built;
};

const json = (status: number, body: string): Response => new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

const refuse = (status: number, reason: string): Response => json(status, JSON.stringify({ error: reason }));

const REST_ROUTE = /^\/api\/p\/([^/]+)(?:\/(start|answer|kill))?$/;

const USAGE = "GET /api/p/:id, POST /api/p/:id/start (body: program), POST /api/p/:id/answer (body: JSON), POST /api/p/:id/kill";

const rest = async (request: Request, env: Env, rawId: string, action: string | undefined): Promise<Response> => {
	const id = decodeId(rawId);

	if (Option.isNone(id)) return refuse(400, "bad program id: use lowercase letters, digits and dashes");

	const stub = programFor(env, id.value);

	if (action === undefined && request.method === "GET") return json(200, await stub.snapshot(id.value));

	if (request.method !== "POST") return refuse(405, USAGE);

	if (action === "start") {
		const source = decodeSource(await request.text());

		return Option.isNone(source) ? refuse(400, "the program must be 1 to 8000 characters") : json(200, await stub.start(id.value, source.value));
	}

	if (action === "answer") {
		const answer = decodeAnswerText(await request.text());

		if (Option.isNone(answer)) return refuse(400, "the answer must be 1 to 16000 characters of JSON");

		const outcome = await Effect.runPromise(decodeAnswer(await stub.answer(id.value, answer.value)).pipe(Effect.result));

		return Result.match(outcome, {
			onFailure: () => refuse(500, "could not read the answer outcome"),
			onSuccess: (answered) =>
				Result.match(answered, {
					onSuccess: (snapshot) => json(200, Schema.encodeSync(SnapshotJson)(snapshot)),
					onFailure: (refused) => refuse(409, JSON.stringify(refused)),
				}),
		});
	}

	if (action === "kill") {
		const killed = await Effect.runPromise(kill(env, id.value).pipe(Effect.result));

		return Result.match(killed, { onSuccess: () => json(200, JSON.stringify({ killed: true })), onFailure: (failure) => refuse(503, failure.reason) });
	}

	return refuse(404, USAGE);
};

const BENCH_ROUTE = /^\/api\/bench(?:\/([^/]+))?\/?$/;

const decodeSystem = Schema.decodeUnknownOption(BenchSystem);

const decodeResult = Schema.decodeSync(BenchResultJson);

const encodeResult = Schema.encodeSync(BenchResultJson);

const encodeRun = Schema.encodeSync(BenchRunJson);

const benchStore = (env: Env) => env.BENCH_STORE.getByName("board");

const decodeCodemode = Schema.decodeSync(CodemodeResultJson);

const encodeCodemode = Schema.encodeSync(CodemodeResultJson);

const encodeCodemodeRun = Schema.encodeSync(CodemodeRunJson);

const codemode = async (request: Request, env: Env): Promise<Response> => {
	if (request.method === "GET") {
		const stored = await benchStore(env).codemode();

		return stored === null ? refuse(404, "no codemode run yet: POST /api/bench/codemode") : json(200, stored);
	}

	if (request.method !== "POST") return refuse(405, `GET or POST ${BENCH_PATH}/codemode`);

	const cached = await benchStore(env).freshCodemode(Date.now());

	if (cached !== null) return json(200, encodeCodemodeRun({ result: decodeCodemode(cached), cached: true }));

	const result = await runCodemode(env);

	await benchStore(env).recordCodemode(encodeCodemode(result));

	return json(200, encodeCodemodeRun({ result, cached: false }));
};

const bench = async (request: Request, env: Env, rawSystem: string | undefined): Promise<Response> => {
	if (rawSystem === "codemode") return codemode(request, env);

	if (rawSystem === undefined) return request.method === "GET" ? json(200, await benchStore(env).board()) : refuse(405, `GET ${BENCH_PATH}, POST ${BENCH_PATH}/:system`);

	const system = decodeSystem(rawSystem);

	if (Option.isNone(system)) return refuse(404, "systems: amber, workflows, agents, durable-object");

	if (request.method !== "POST") return refuse(405, `POST ${BENCH_PATH}/${system.value}`);

	const cached = await benchStore(env).fresh(system.value, Date.now());

	if (cached !== null) return json(200, encodeRun({ result: decodeResult(cached), cached: true }));

	const result = await runBench(env, system.value);

	await benchStore(env).record(encodeResult(result));

	return json(200, encodeRun({ result, cached: false }));
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === RPC_PATH) return rpcHandler(env)(request);

		if (url.pathname === `${RPC_PATH}/`) return rpcHandler(env)(new Request(new URL(RPC_PATH, url), request));

		const route = REST_ROUTE.exec(url.pathname);

		if (route !== null) return rest(request, env, route[1] ?? "", route[2]);

		const benchRoute = BENCH_ROUTE.exec(url.pathname);

		if (benchRoute !== null) return bench(request, env, benchRoute[1]);

		if (url.pathname.startsWith("/api/")) return refuse(404, USAGE);

		return env.ASSETS.fetch(request);
	},
};
