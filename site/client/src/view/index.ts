import { Option } from "effect";
import type { Document, Html } from "foldkit/html";
import { isWaiting } from "../../../shared/protocol";
import type { Model } from "../model";
import { playground } from "./playground";
import { CARD, code, eyebrow, type H, inline, link, PRIMARY, REPO, SECONDARY, sectionTitle } from "./ui";

const HERO_SNIPPET = `// written by an agent at runtime, not by you
const runId = Math.random().toString(36).slice(2, 8);
for (const issue of tool("list_issues", { runId })) {
  const ok = tool("ask_human", { runId, question: \`close #\${issue.id}?\` });
  if (ok) tool("close_issue", { runId, id: issue.id });
}`;

const HOST_SNIPPET = `const outcome = await script.run(source);

if (outcome._tag === "Waiting") {
  const answer = await askAHuman(outcome.name, outcome.args);
  await script.answer(outcome.token, answer);
}`;

const CURL_SNIPPET = `curl -X POST --data-binary @site/programs/approvals.ts $HOST/api/p/demo/start
curl -X POST -d '[{"id":1,"title":"x","labels":[]}]'  $HOST/api/p/demo/answer
curl -X POST $HOST/api/p/demo/kill        # ctx.abort(); storage survives
curl -X POST -d 'true'                     $HOST/api/p/demo/answer
curl $HOST/api/p/demo`;

const header = (h: H): Html =>
	h.header(
		[h.Class("sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur")],
		[
			h.div(
				[h.Class("mx-auto flex h-14 max-w-6xl items-center gap-3 px-5")],
				[
					h.a(
						[h.Href("/"), h.Class("flex items-center gap-2.5")],
						[h.img([h.Src("/favicon.svg"), h.Alt(""), h.Width("24"), h.Height("24")]), h.span([h.Class("text-[15px] font-semibold tracking-[-0.01em]")], ["amber"])],
					),
					h.nav(
						[h.Class("ml-auto flex items-center gap-1 text-[13.5px]"), h.AriaLabel("Sections")],
						[
							link(h, "Playground", "#playground", "hidden rounded-md px-2.5 py-1.5 text-dim hover:text-ink sm:inline"),
							link(h, "Use it", "#use", "hidden rounded-md px-2.5 py-1.5 text-dim hover:text-ink sm:inline"),
							link(h, "How it works", "#how", "hidden rounded-md px-2.5 py-1.5 text-dim hover:text-ink sm:inline"),
							link(h, "API", "#api", "hidden rounded-md px-2.5 py-1.5 text-dim hover:text-ink sm:inline"),
							link(h, "Limits", "#limits", "hidden rounded-md px-2.5 py-1.5 text-dim hover:text-ink md:inline"),
							link(h, "Benchmarks", "/benchmarks", "rounded-md px-2.5 py-1.5 text-dim hover:text-ink"),
							link(h, "GitHub", REPO, `${SECONDARY} ml-2 h-8 text-[13px]`),
						],
					),
				],
			),
		],
	);

const hero = (h: H): Html =>
	h.section(
		[h.Class("mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-5 pt-12 pb-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-24 [&>*]:min-w-0")],
		[
			h.div(
				[],
				[
					eyebrow(h, "codemode-pause · Durable Objects · open source"),
					h.h1([h.Class("mt-3 text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[56px]")], ["Pause code your agent wrote."]),
					h.p(
						[h.Class("mt-5 max-w-xl text-[17px] text-dim")],
						[
							"An agent writes a script at runtime. Halfway through a loop it needs a human. The script calls ",
							inline(h, "tool()"),
							" and freezes: call stack, loop counters, closures. A Durable Object stores a couple of KB and is free to die. Answer an hour later and ",
							inline(h, "tool()"),
							" returns at the same line. Nothing replays, so the script does not have to be deterministic.",
						],
					),
					h.div([h.Class("mt-7 flex flex-wrap gap-3")], [link(h, "Try it below", "#playground", `${PRIMARY} h-10 px-4`), link(h, "Install", "#use", `${SECONDARY} h-10 px-4`), link(h, "See the benchmark", "/benchmarks", `${SECONDARY} h-10 px-4`)]),
				],
			),
			h.div(
				[h.Class("relative")],
				[
					code(h, HERO_SNIPPET, "bg-bg shadow-[0_1px_3px_rgba(0,0,0,0.06)]"),
					h.p([h.Class("mt-2 text-[12.5px] text-faint")], ["ask_human freezes the whole program into a couple of KB; the server can die and the human can answer tomorrow. No ", inline(h, "await"), ", no step functions, no replay, so ", inline(h, "Math.random()"), " is fine."]),
				],
			),
		],
	);

const howCard = (h: H, n: string, title: string, body: ReadonlyArray<string | Html>): Html =>
	h.div(
		[h.Class(`${CARD} p-5`)],
		[h.span([h.Class("font-mono text-[12px] text-amber")], [n]), h.h3([h.Class("mt-1.5 text-[16px] font-semibold")], [title]), h.p([h.Class("mt-2 text-[14px] text-dim")], [...body])],
	);

const how = (h: H): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-12 sm:py-16")],
		[
			sectionTitle(
				h,
				"how",
				"How it works",
				"The engine saves the program, not a log of it",
				"amber runs dquickts, a fork of QuickJS that can serialize a whole running runtime, including a suspended call stack. Compiled to WebAssembly, it fits in a Durable Object.",
			),
			h.div(
				[h.Class("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0")],
				[
					howCard(h, "01", "tool() freezes it", ["The host function returns ", inline(h, "JS_SuspendCall()"), ". The engine moves every JS frame to the heap and unwinds. The script never sees it."]),
					howCard(h, "02", "Only the change is stored", [
						"The base (a fresh runtime) is byte-identical in every isolate, so it is rebuilt, hash-checked, and never stored. Storage holds the delta: about 2 KB.",
					]),
					howCard(h, "03", "Any object can resume", ["A new request gets a new wasm instance, restores base plus delta, and calls ", inline(h, "JS_ResumeWith(answer)"), ". The call returns the answer."]),
					howCard(h, "04", "Loops are sliced", ["A tick budget suspends long synchronous code mid-loop. Durable Object alarms continue it, one slice at a time, across kills."]),
				],
			),
			h.div(
				[h.Class("mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0")],
				[
					h.div([], [h.h3([h.Class("mb-2 text-[14px] font-semibold")], ["The host side of one pause"]), code(h, HOST_SNIPPET)]),
					h.div(
						[h.Class(`${CARD} p-5`)],
						[
							h.h3([h.Class("text-[14px] font-semibold")], ["Why not replay?"]),
							h.p(
								[h.Class("mt-2 text-[14px] text-dim")],
								[
									"Durable execution usually means saving each tool result and re-running the code from the top after every pause. That needs the code to do the same thing every time. Agent-written code often reads ",
									inline(h, "Math.random()"),
									" or ",
									inline(h, "Date.now()"),
									". Strict replay then refuses to resume; lenient replay resumes a different run than the one the human approved. Here nothing between two ",
									inline(h, "tool()"),
									" calls runs again. The tool calls themselves are still yours to make idempotent, because a kill can land after a tool runs and before its answer is saved.",
								],
							),
						],
					),
				],
			),
		],
	);

const proofItem = (h: H, title: string, body: string): Html =>
	h.li([h.Class("border-t border-line py-3 first:border-t-0")], [h.p([h.Class("font-medium")], [title]), h.p([h.Class("mt-0.5 text-[14px] text-dim")], [body])]);

const proof = (h: H): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-12 sm:py-16")],
		[
			sectionTitle(h, "proof", "Tested by killing it", "What npm run check proves", "The end-to-end test runs the real Worker under workerd and kills it while programs are mid-flight."),
			h.ul(
				[h.Class(`${CARD} px-5 py-2`)],
				[
					proofItem(h, "A tool-call program survives a process kill and ctx.abort()", "The approvals program runs four steps on at least three Durable Object instances. The whole workerd process is SIGKILLed between two steps, and ctx.abort() is called between two others. It finishes with the right decisions."),
					proofItem(h, "A CPU-bound loop survives a kill mid-loop", "Three million iterations in 25 alarm slices. workerd is SIGKILLed after slice 6; after the restart the alarms resume on their own and the sum matches V8."),
					proofItem(h, "A kill fuzz finds no wrong outcomes", "Three scripts × 70 seeds, with crashes injected at every boundary and in the middle of tools: 210 runs, 1,044 crashes, 1,044 recoveries, 0 outcomes that differ from a clean run. 390 writes repeated, every one with the same key and arguments: delivery is at least once."),
					proofItem(h, "Errors are loud", "Answering a finished program is refused (NotWaiting). A syntax error is a Failed outcome with the engine's message."),
				],
			),
		],
	);

const INSTALL_SNIPPET = `npm install github:acoyfellow/amber effect@4.0.0`;

const USE_SNIPPET = `import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { DurableScript, durableObjectStorage, external, read, write } from "@acoyfellow/amber";
import wasm from "@acoyfellow/amber/dq.wasm";

export class Script extends DurableObject<Env> {
  script = new DurableScript({
    programId: this.ctx.id.toString(),
    storage: durableObjectStorage(this.ctx.storage),
    wasm,
    tools: {
      list_issues: read(Schema.Struct({ repo: Schema.String }), ({ repo }) => github.list(repo)),
      close_issue: write(Schema.Struct({ id: Schema.Number }), ({ id }, { key }) => github.close(id, { idempotencyKey: key })),
      ask_human: external(Schema.Struct({ question: Schema.String }), { timeoutMs: 7 * 86_400_000 }),
    },
  });

  run(source: string) { return this.script.run(source); }
  answer(token: string, value: unknown) { return this.script.answer(token, value); }
  override alarm() { return this.script.alarm(); }
}`;

const toolKind = (h: H, name: string, body: string): Html => h.div([h.Class(`${CARD} p-4`)], [h.p([h.Class("font-mono text-[13px] text-amber")], [name]), h.p([h.Class("mt-1.5 text-[14px] text-dim")], [body])]);

const use = (h: H): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-12 sm:py-16")],
		[
			sectionTitle(h, "use", "Use it", "One class in your own Durable Object", "amber is a library. Give it storage, the engine and your tools; it returns Waiting, Running, Finished or Failed."),
			code(h, INSTALL_SNIPPET),
			h.div([h.Class("mt-4")], [code(h, USE_SNIPPET)]),
			h.div(
				[h.Class("mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 [&>*]:min-w-0")],
				[
					toolKind(h, "read(schema, fn)", "Runs inline. No snapshot. After a crash the script re-runs from its last snapshot, so reads can repeat."),
					toolKind(h, "write(schema, fn)", "Snapshots before it runs and gets an idempotency key. Delivery is at least once: deduplicate on the key."),
					toolKind(h, "external(schema, { timeoutMs })", "Does not run at all. The program pauses until you call answer(token, value), or a Timeout is thrown into it."),
				],
			),
			h.p([h.Class("mt-4 text-[13.5px] text-dim")], ["Arguments are checked with the tool's Schema. Bad arguments and tool errors arrive in the script as ordinary catchable errors. ", link(h, "Read the full README", REPO, "underline hover:text-ink"), "."]),
		],
	);

const api = (h: H): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-12 sm:py-16")],
		[
			sectionTitle(h, "api", "Demo API", "Drive this demo from anywhere", "The playground talks Effect RPC. The same demo object also answers plain HTTP, so curl works too."),
			code(h, CURL_SNIPPET),
			h.div(
				[h.Class("mt-4 grid grid-cols-1 gap-3 text-[14px] sm:grid-cols-2 [&>*]:min-w-0")],
				[
					h.p([h.Class("text-dim")], [inline(h, "POST /api/p/:id/start"), " body is the program (TypeScript, up to 8000 characters). Starts over if the id is taken."]),
					h.p([h.Class("text-dim")], [inline(h, "POST /api/p/:id/answer"), " body is JSON. It becomes the return value of the pending ", inline(h, "tool()"), " call."]),
					h.p([h.Class("text-dim")], [inline(h, "POST /api/p/:id/kill"), " records the kill, then ", inline(h, "ctx.abort()"), ". The next request gets a new object."]),
					h.p([h.Class("text-dim")], [inline(h, "GET /api/p/:id"), " returns the snapshot: outcome, steps, kills, object count, stored bytes."]),
				],
			),
		],
	);

const limit = (h: H, title: string, body: string): Html => h.li([h.Class("text-[14px] text-dim")], [h.span([h.Class("font-medium text-ink")], [`${title}. `]), body]);

const limits = (h: H): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-12 sm:py-16")],
		[
			sectionTitle(h, "limits", "Limits", "What it is not", "Experimental, version 0.1. These are the edges."),
			h.ul(
				[h.Class("grid list-disc grid-cols-1 gap-2.5 pl-5 sm:grid-cols-2")],
				[
					limit(h, "Same build only", "A snapshot loads only into the dq.wasm that wrote it. A new engine build makes stored programs unreadable; programs in flight need draining or a pinned engine."),
					limit(h, "Interpreter speed", "QuickJS is much slower than V8. Fine for agent glue code, not for heavy computation."),
					limit(h, "Code you write yourself", "If you write the workflow ahead of time, Workflows, the Agents SDK or a plain Durable Object resume faster. See /benchmarks."),
					limit(h, "A small world", "No network, timers, Intl or Temporal inside the program. tool() is the only way out."),
					limit(h, "One program per object", "A runtime holds one suspended execution."),
					limit(h, "Snapshots are trusted", "They are read only from the object's own storage, never from a request."),
					limit(h, "Public demo caps", "8000-character programs, 16000-character answers, a 50-tick budget per slice and at most 2000 slices per program."),
				],
			),
		],
	);

const footer = (h: H): Html =>
	h.footer(
		[h.Class("border-t border-line")],
		[
			h.div(
				[h.Class("mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-8 text-[13px] text-faint")],
				[
					h.span([], ["Built on ", link(h, "amber", "https://github.com/stencil-hq/dquickts", "underline hover:text-ink"), ", a QuickJS fork by Stencil. QuickJS by Fabrice Bellard and Charlie Gordon."]),
					h.span([h.Class("ml-auto")], ["Effect v4 · Foldkit · Cloudflare Durable Objects · MIT"]),
				],
			),
		],
	);

export const view = (model: Model, h: H): Document => ({
	title: Option.exists(Option.flatMap(model.snapshot, (snapshot) => snapshot.outcome), isWaiting) ? "amber · waiting for you" : "amber: pause code your agent wrote",
	body: h.div(
		[h.Class("min-h-full")],
		[
			header(h),
			h.main(
				[],
				[
					hero(h),
					h.section(
						[h.Class("mx-auto max-w-6xl px-5 pb-8")],
						[
							sectionTitle(h, "playground", "Playground", "Play a dungeon. Kill the server between moves.", "Each run gets its own Durable Object. Every time you hit kill, ctx.abort() throws away its memory and its wasm instance. Your next move lands on a brand new object, and the game carries on mid-loop."),
							playground(h, model),
						],
					),
					use(h),
					how(h),
					proof(h),
					api(h),
					limits(h),
				],
			),
			footer(h),
		],
	),
});
