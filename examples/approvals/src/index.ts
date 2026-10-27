import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { DurableScript, durableObjectStorage, external, type Outcome, read, write } from "../../../src";
import wasm from "../../../engine/dq.wasm";

type Env = { readonly SCRIPT: DurableObjectNamespace<Script> };

const ISSUES = [
	{ id: 41, title: "flaky test on main" },
	{ id: 42, title: "typo in README" },
	{ id: 43, title: "dark mode contrast" },
];

const MAX_SOURCE = 16 * 1024;

export class Script extends DurableObject<Env> {
	private readonly script: DurableScript;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.script = new DurableScript({
			programId: ctx.id.toString(),
			storage: durableObjectStorage(ctx.storage),
			wasm,
			tools: {
				list_issues: read(Schema.Struct({}), () => ISSUES),
				close_issue: write(Schema.Struct({ id: Schema.Number }), ({ id }, { key }) => {
					const closed = ctx.storage.kv.get<Array<{ id: number; key: string }>>("closed") ?? [];

					if (!closed.some((entry) => entry.key === key)) ctx.storage.kv.put("closed", [...closed, { id, key }]);

					return { closed: id };
				}),
				ask_human: external(Schema.Struct({ question: Schema.String }), { timeoutMs: 7 * 24 * 60 * 60 * 1000 }),
			},
		});
	}

	run(source: string): Promise<Outcome> {
		return this.script.run(source);
	}

	answer(token: string, value: unknown): Promise<Outcome> {
		return this.script.answer(token, value);
	}

	recover(): Promise<Outcome> {
		return this.script.recover();
	}

	closed(): Array<{ id: number; key: string }> {
		return this.ctx.storage.kv.get<Array<{ id: number; key: string }>>("closed") ?? [];
	}

	kill(): void {
		this.ctx.abort("killed on request");
	}

	override async alarm(): Promise<void> {
		await this.script.alarm();
	}
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const errorBody = (error: unknown): { readonly error: string; readonly message: string } => ({
	error: error instanceof Error ? error.name : "Error",
	message: error instanceof Error ? error.message : String(error),
});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const match = new URL(request.url).pathname.match(/^\/p\/([\w-]{1,64})\/(run|answer|recover|closed|kill)$/);

		if (match === null) return json({ error: "NotFound" }, 404);

		const [, id = "", action] = match;
		const stub = env.SCRIPT.getByName(id);

		try {
			if (action === "run") {
				const source = await request.text();

				return source.length > MAX_SOURCE ? json({ error: "TooLarge" }, 413) : json(await stub.run(source));
			}

			if (action === "answer") {
				const { token, value } = await request.json<{ token: string; value: unknown }>();

				return json(await stub.answer(token, value));
			}

			if (action === "recover") return json(await stub.recover());

			if (action === "closed") return json(await stub.closed());

			await stub.kill().catch(() => undefined);

			return json({ killed: id });
		} catch (error) {
			return json(errorBody(error), 409);
		}
	},
};
