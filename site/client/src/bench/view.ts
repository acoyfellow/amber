import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { CODEMODE_LABELS, type CodemodeResult, type CodemodeRow, VARIANT_LABELS } from "../../../shared/codemode";
import { APPROVAL_COUNT, BENCH_SYSTEMS, type BenchResult, type BenchSystem, LOOP_LIMIT, SYSTEM_LABELS } from "../../../shared/bench";
import { code, eyebrow, inline, link, PRIMARY, REPO, SECONDARY, sectionTitle } from "../view/ui";
import { BenchMessage, type BenchModel } from "./app";
import { CODEMODE_SCRIPTS, countLines, IMPLEMENTATIONS } from "./sources";

type B = HtmlBuilder<BenchMessage>;

type Direction = "low" | "high";

type Column = { readonly label: string; readonly hint: string; readonly value: (result: BenchResult) => number | null; readonly show: (result: BenchResult) => string; readonly best: Option.Option<Direction> };

const ms = (value: number): string => `${value} ms`;

const nullable = (value: number | null, format: (present: number) => string): string => (value === null ? "n/a" : format(value));

const linesOf = (system: BenchSystem): number => countLines(IMPLEMENTATIONS[system].source);

const APPROVAL_COLUMNS: ReadonlyArray<Column> = [
	{ label: "Correct", hint: "decided deep-equals the expected list", value: (r) => (r.approvals.correct ? 1 : 0), show: (r) => (r.approvals.correct ? "yes" : "NO"), best: Option.none() },
	{ label: "Kills survived", hint: "ctx.abort() before every odd answer", value: (r) => (r.approvals.killable ? r.approvals.kills : null), show: (r) => (r.approvals.killable ? String(r.approvals.kills) : "can't kill"), best: Option.some("high") },
	{ label: "Resume p50", hint: "wall ms from the answer call to the next waiting state", value: (r) => r.approvals.p50Ms, show: (r) => ms(r.approvals.p50Ms), best: Option.some("low") },
	{ label: "Resume p95", hint: "95th percentile of the 8 answers", value: (r) => r.approvals.p95Ms, show: (r) => ms(r.approvals.p95Ms), best: Option.some("low") },
	{ label: "Total", hint: "start to finish, including kills", value: (r) => r.approvals.totalMs, show: (r) => ms(r.approvals.totalMs), best: Option.some("low") },
	{ label: "Bytes / pause", hint: "stored per waiting state", value: (r) => r.approvals.bytesPerPause, show: (r) => nullable(r.approvals.bytesPerPause, (b) => `${b} B`), best: Option.some("low") },
	{ label: "Objects", hint: "distinct Durable Object instances that served the run", value: (r) => r.approvals.objects, show: (r) => nullable(r.approvals.objects, String), best: Option.none() },
	{ label: "Lines of code", hint: "non-blank, non-import lines in the implementation file", value: (r) => linesOf(r.system), show: (r) => String(linesOf(r.system)), best: Option.some("low") },
];

const LOOP_COLUMNS: ReadonlyArray<Column> = [
	{ label: "Correct", hint: "sum equals 1,498,500,000", value: (r) => (r.loop.correct ? 1 : 0), show: (r) => (r.loop.correct ? "yes" : "NO"), best: Option.none() },
	{ label: "Wall", hint: "orchestrator wall time", value: (r) => r.loop.wallMs, show: (r) => ms(r.loop.wallMs), best: Option.some("low") },
	{ label: "CPU", hint: "amber only: sum of slice run times; n/a when the Workers clock did not advance", value: (r) => r.loop.cpuMs, show: (r) => nullable(r.loop.cpuMs, ms), best: Option.none() },
	{ label: "Slices", hint: "amber only: alarm slices", value: (r) => r.loop.slices, show: (r) => nullable(r.loop.slices, String), best: Option.none() },
];

const bestValue = (results: ReadonlyArray<BenchResult>, column: Column): Option.Option<number> =>
	Option.flatMap(column.best, (direction) => {
		const values = results.flatMap((result) => {
			const value = column.value(result);

			return value === null ? [] : [value];
		});

		if (values.length < 2) return Option.none();

		return Option.some(direction === "low" ? Math.min(...values) : Math.max(...values));
	});

const cell = (h: B, result: BenchResult, column: Column, best: Option.Option<number>): Html => {
	const isBest = Option.exists(best, (value) => column.value(result) === value);

	return h.td([h.Class(`px-3 py-2.5 text-right font-mono whitespace-nowrap ${isBest ? "font-semibold text-ok" : "text-ink"}`)], [column.show(result), isBest ? " ★" : ""]);
};

const table = (h: B, results: ReadonlyArray<BenchResult>, columns: ReadonlyArray<Column>, caption: string): Html => {
	const best = columns.map((column) => bestValue(results, column));

	return h.div(
		[h.Class("max-w-full overflow-x-auto rounded-xl border border-line")],
		[
			h.table(
				[h.Class("w-full min-w-[640px] border-collapse text-[13.5px]")],
				[
					h.caption([h.Class("sr-only")], [caption]),
					h.thead(
						[h.Class("bg-panel text-[12px] text-faint")],
						[
							h.tr(
								[],
								[
									h.th([h.Scope("col"), h.Class("sticky left-0 bg-panel px-3 py-2 text-left font-medium")], ["System"]),
									...columns.map((column) => h.th([h.Scope("col"), h.Title(column.hint), h.Class("px-3 py-2 text-right font-medium whitespace-nowrap")], [column.label])),
								],
							),
						],
					),
					h.tbody(
						[],
						results.map((result) =>
							h.tr(
								[h.Class("border-t border-line")],
								[
									h.th([h.Scope("row"), h.Class("sticky left-0 bg-bg px-3 py-2.5 text-left font-medium whitespace-nowrap shadow-[1px_0_0_var(--color-line)]")], [SYSTEM_LABELS[result.system]]),
									...columns.map((column, index) => cell(h, result, column, best[index] ?? Option.none())),
								],
							),
						),
					),
				],
			),
		],
	);
};

const ranAt = (results: ReadonlyArray<BenchResult>): string =>
	results.length === 0 ? "No runs yet." : `Last runs: ${results.map((result) => `${result.system} ${new Date(result.ranAt).toISOString().replace("T", " ").slice(0, 19)} UTC`).join(" · ")}`;

const runPanel = (h: B, model: BenchModel): Html =>
	h.div(
		[h.Class("mt-6 rounded-xl border border-line bg-panel p-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					h.button(
						[h.Type("button"), h.Disabled(Option.isSome(model.running) || model.runningCodemode), h.Class(`${PRIMARY} h-10 px-4`), h.OnClick(BenchMessage.ClickedRunAll())],
						[model.runningCodemode ? "Running codemode-pause…" : Option.match(model.running, { onNone: () => "Run all in prod", onSome: (system) => `Running ${SYSTEM_LABELS[system]}…` })],
					),
					h.span([h.Class("text-[12.5px] text-faint")], ["Runs codemode-pause, then the four systems, one after another on this Worker. Each result is cached for 20 s."]),
				],
			),
			model.log.length === 0 ? h.span([], []) : h.ol([h.Class("mt-3 space-y-0.5 font-mono text-[12.5px] break-words text-dim"), h.AriaLive("polite")], model.log.map((line) => h.li([], [line]))),
			Option.match(model.error, { onNone: () => h.span([], []), onSome: (error) => h.p([h.Class("mt-3 text-[13px] text-bad")], [error]) }),
		],
	);

const notes = (h: B, results: ReadonlyArray<BenchResult>): Html =>
	h.div(
		[h.Class("mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0")],
		results.map((result) =>
			h.div(
				[h.Class("rounded-lg border border-line p-3")],
				[h.p([h.Class("text-[13px] font-medium")], [SYSTEM_LABELS[result.system]]), h.ul([h.Class("mt-1 list-disc space-y-1 pl-4 text-[12.5px] text-dim")], result.notes.map((note) => h.li([], [note])))],
			),
		),
	);

const implementation = (h: B, system: BenchSystem): Html =>
	h.details(
		[h.Class("rounded-lg border border-line p-3 [&>*]:min-w-0")],
		[
			h.summary([h.Class("cursor-pointer text-[14px] font-medium")], [`${SYSTEM_LABELS[system]} · ${linesOf(system)} lines · `, h.span([h.Class("font-mono text-[12px] text-faint break-all")], [IMPLEMENTATIONS[system].file])]),
			code(h, IMPLEMENTATIONS[system].excerpt, "mt-3"),
		],
	);

const honesty = (h: B): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-10")],
		[
			sectionTitle(h, "honest", "Read this first", "What this measures, and what it doesn't", "One run, one region, whatever colo served your request. Small numbers move a lot between runs."),
			h.div(
				[h.Class("grid grid-cols-1 gap-4 text-[14px] text-dim md:grid-cols-2 [&>*]:min-w-0")],
				[
					h.ul(
						[h.Class("list-disc space-y-2 pl-5")],
						[
							h.li([], [h.span([h.Class("font-medium text-ink")], ["amber wins on code shape. "]), "The approvals workload is a six-line for loop. It needs no state machine and no determinism rules: nothing replays, so ", inline(h, "Math.random()"), " or a clock read between two tool() calls is fine."]),
							h.li([], [h.span([h.Class("font-medium text-ink")], ["amber loses on raw CPU. "]), "QuickJS is an interpreter, so the loop takes far longer than in V8. Its wall time also includes a 120 ms alarm gap between slices."]),
							h.li([], [h.span([h.Class("font-medium text-ink")], ["amber scripts live in a small world. "]), "No npm packages, no fetch, no timers inside the program. tool() is the only way out."]),
						],
					),
					h.ul(
						[h.Class("list-disc space-y-2 pl-5")],
						[
							h.li([], [h.span([h.Class("font-medium text-ink")], ["Workflows is managed. "]), "Retries, storage and observability come built in. There is no external kill, so it skips the kills, and its stored bytes are not visible."]),
							h.li([], [h.span([h.Class("font-medium text-ink")], ["Resume latency is wall time seen by the orchestrator, "]), "inside the same Worker. It is not end-user latency. Workflows numbers include up to 25 ms of polling."]),
							h.li([], [h.span([h.Class("font-medium text-ink")], ["Not measured: "]), "cost, cold starts of a new deploy, behaviour under load, or many concurrent programs."]),
						],
					),
				],
			),
		],
	);

type Verdict = { readonly text: string; readonly tone: string };

const verdict = (row: CodemodeRow): Verdict => {
	if (row.completed && row.consistent) return { text: "finished, consistent", tone: "text-ok" };

	if (row.outcome === "diverged") return { text: `refused to resume (diverged at call ${row.divergedAt ?? "?"})`, tone: "text-bad" };

	if (row.completed) return { text: "finished, but the approvals were for a different run", tone: "text-bad" };

	return { text: row.reason ?? row.outcome, tone: "text-bad" };
};

const codemodeTable = (h: B, rows: ReadonlyArray<CodemodeRow>): Html =>
	h.div(
		[h.Class("max-w-full overflow-x-auto rounded-xl border border-line")],
		[
			h.table(
				[h.Class("w-full min-w-[760px] border-collapse text-[13.5px]")],
				[
					h.caption([h.Class("sr-only")], ["codemode-pause results"]),
					h.thead(
						[h.Class("bg-panel text-[12px] text-faint")],
						[
							h.tr(
								[],
								["Script", "System", "Result", "Script runs", "Calls replayed", "Kills", "Resume p50", "Bytes / pause"].map((label, index) =>
									h.th([h.Scope("col"), h.Class(`px-3 py-2 font-medium whitespace-nowrap ${index < 3 ? "text-left" : "text-right"} ${index === 0 ? "sticky left-0 bg-panel" : ""}`)], [label]),
								),
							),
						],
					),
					h.tbody(
						[],
						rows.map((row) => {
							const { text, tone } = verdict(row);

							return h.tr(
								[h.Class("border-t border-line")],
								[
									h.th([h.Scope("row"), h.Class("sticky left-0 bg-bg px-3 py-2.5 text-left font-medium whitespace-nowrap")], [VARIANT_LABELS[row.variant]]),
									h.td([h.Class("px-3 py-2.5 whitespace-nowrap")], [CODEMODE_LABELS[row.system]]),
									h.td([h.Class(`px-3 py-2.5 font-medium ${tone}`)], [text]),
									h.td([h.Class("px-3 py-2.5 text-right font-mono")], [String(row.scriptRuns)]),
									h.td([h.Class("px-3 py-2.5 text-right font-mono")], [String(row.replayedCalls)]),
									h.td([h.Class("px-3 py-2.5 text-right font-mono")], [String(row.kills)]),
									h.td([h.Class("px-3 py-2.5 text-right font-mono whitespace-nowrap")], [nullable(row.p50Ms, ms)]),
									h.td([h.Class("px-3 py-2.5 text-right font-mono whitespace-nowrap")], [nullable(row.bytesPerPause, (b) => `${b} B`)]),
								],
							);
						}),
					),
				],
			),
		],
	);

const codemodeSection = (h: B, result: Option.Option<CodemodeResult>): Html =>
	h.section(
		[h.Class("mx-auto max-w-6xl px-5 py-6")],
		[
			sectionTitle(
				h,
				"codemode",
				"The workload amber exists for",
				"codemode-pause: an LLM writes a script, the script waits for a human",
				"The script below was not written ahead of time; an agent generates it. It pauses at every tool() call. amber freezes the running program and resumes it. The alternative is replay: re-run the script from the top on every answer and feed back saved results. Replay only works if the script does the same thing every time.",
			),
			h.div(
				[h.Class("mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2 [&>*]:min-w-0")],
				[
					h.div([], [h.p([h.Class("mb-1.5 text-[13px] font-medium")], [VARIANT_LABELS.deterministic]), code(h, CODEMODE_SCRIPTS.deterministic)]),
					h.div([], [h.p([h.Class("mb-1.5 text-[13px] font-medium")], [`${VARIANT_LABELS.llm}: the same script, as models often write it`]), code(h, CODEMODE_SCRIPTS.llm)]),
				],
			),
			Option.match(result, {
				onNone: () => h.p([h.Class("rounded-xl border border-line p-4 text-[14px] text-dim")], ["No run yet. Press Run all in prod."]),
				onSome: (current) =>
					h.div(
						[],
						[
							codemodeTable(h, current.rows),
							h.p([h.Class("mt-2 text-[12.5px] text-faint")], [`Ran ${new Date(current.ranAt).toISOString().replace("T", " ").slice(0, 19)} UTC.`]),
							h.ul([h.Class("mt-4 list-disc space-y-1.5 pl-5 text-[13px] text-dim")], current.notes.map((note) => h.li([], [note]))),
						],
					),
			}),
		],
	);

const header = (h: B): Html =>
	h.header(
		[h.Class("sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur")],
		[
			h.div(
				[h.Class("mx-auto flex h-14 max-w-6xl items-center gap-3 px-5")],
				[
					h.a([h.Href("/"), h.Class("flex items-center gap-2.5")], [h.img([h.Src("/favicon.svg"), h.Alt(""), h.Width("24"), h.Height("24")]), h.span([h.Class("text-[15px] font-semibold tracking-[-0.01em]")], ["amber"])]),
					h.nav(
						[h.Class("ml-auto flex items-center gap-1 text-[13.5px]"), h.AriaLabel("Pages")],
						[link(h, "Playground", "/", "rounded-md px-2.5 py-1.5 text-dim hover:text-ink"), link(h, "GitHub", REPO, `${SECONDARY} ml-2 h-8 text-[13px]`)],
					),
				],
			),
		],
	);

export const benchView = (model: BenchModel, h: B): Document => ({
	title: "amber · benchmarks",
	body: h.div(
		[h.Class("min-h-full")],
		[
			header(h),
			h.main(
				[],
				[
					h.section(
						[h.Class("mx-auto max-w-6xl px-5 pt-12 pb-6")],
						[
							eyebrow(h, "Production benchmarks"),
							h.h1([h.Class("mt-3 text-[34px] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[44px]")], ["Pause code you didn't write."]),
							h.p(
								[h.Class("mt-4 max-w-2xl text-[16px] text-dim")],
								[
									"amber is for codemode-pause: an agent writes a script at runtime, and the script stops mid-loop to wait for a human. First that workload against replay, the only other way to pause generated code. Then, for context, hand-written workloads against Workflows, the Agents SDK and a plain Durable Object, where those tools are the better choice.",
								],
							),
							runPanel(h, model),
							h.p([h.Class("mt-3 text-[12.5px] text-faint break-words")], [ranAt(model.results)]),
						],
					),
					codemodeSection(h, model.codemode),
					h.section(
						[h.Class("mx-auto max-w-6xl px-5 py-6")],
						[
							sectionTitle(h, "approvals", "For context · hand-written code", `Approvals you wrote yourself: ${APPROVAL_COUNT} answers, killed before every odd one`, "If you write the code, you can write a state machine, and the V8 options resume faster. The program asks for a yes/no per id and waits. The answer for id is id % 3 !== 0. ★ marks the best value in a column."),
							table(h, model.results, APPROVAL_COLUMNS, "Approvals workload results"),
							notes(h, model.results),
						],
					),
					h.section(
						[h.Class("mx-auto max-w-6xl px-5 py-6")],
						[
							sectionTitle(h, "loop", "For context · CPU", `Loop: sum of i % 1000 for i < ${LOOP_LIMIT.toLocaleString("en-US")}`, "Pure CPU, no waiting. V8 systems run it in one call or step. amber slices it by a tick budget through alarms."),
							table(h, model.results, LOOP_COLUMNS, "Loop workload results"),
						],
					),
					h.section(
						[h.Class("mx-auto max-w-6xl px-5 py-6")],
						[
							sectionTitle(h, "code", "Implementations", "The code each system needs", "Lines count non-blank, non-import lines of the implementation file, read from the repo at build time."),
							h.div([h.Class("grid grid-cols-1 gap-3")], BENCH_SYSTEMS.map((system) => implementation(h, system))),
						],
					),
					honesty(h),
				],
			),
		],
	),
});
