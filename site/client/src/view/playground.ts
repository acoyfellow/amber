import { Match, Option, Schema } from "effect";
import type { Html } from "foldkit/html";
import { isLive as isLiveOutcome, type Kill, type Outcome, type Snapshot, type Step, type ToolCall } from "../../../shared/protocol";
import { Message } from "../message";
import { Busy, type Model } from "../model";
import { PRESETS, presetFor } from "../presets";
import { highlight } from "./highlight";
import { button, CARD, DANGER, type H, kilobytes, PRIMARY, pretty, SECONDARY } from "./ui";

type Tone = { readonly label: string; readonly text: string; readonly dot: string };

const toneOf = (outcome: Option.Option<Outcome>): Tone =>
	Option.match(outcome, {
		onNone: () => ({ label: "Not started", text: "text-faint", dot: "bg-line-strong" }),
		onSome: (current) =>
			Match.value(current).pipe(
				Match.tagsExhaustive({
					Waiting: () => ({ label: "Frozen, waiting for you", text: "text-amber", dot: "bg-amber" }),
					Running: () => ({ label: "Running in slices", text: "text-ink", dot: "bg-ink animate-pulse" }),
					Finished: () => ({ label: "Finished", text: "text-ok", dot: "bg-ok" }),
					Failed: () => ({ label: "Failed", text: "text-bad", dot: "bg-bad" }),
				}),
			),
	});

const outcomeOf = (model: Model): Option.Option<Outcome> => Option.flatMap(model.snapshot, (snapshot) => snapshot.outcome);

const isLive = (model: Model): boolean => Option.exists(outcomeOf(model), isLiveOutcome);

const busyLabel = (busy: Busy): Option.Option<string> =>
	Busy.match(busy, {
		Idle: () => Option.none(),
		Starting: () => Option.some("Starting a program in the Durable Object"),
		Answering: () => Option.some("Restoring the program and handing it your answer"),
		Killing: () => Option.some("Calling ctx.abort() on the Durable Object"),
	});

const presetTabs = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex gap-1 rounded-lg bg-raised p-1"), h.Role("tablist"), h.AriaLabel("Example programs")],
		PRESETS.map((preset) =>
			h.button(
				[
					h.Type("button"),
					h.Role("tab"),
					h.AriaSelected(preset.key === model.preset),
					h.Class(`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${preset.key === model.preset ? "bg-bg text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-dim hover:text-ink"}`),
					h.OnClick(Message.PickedPreset({ preset: preset.key })),
				],
				[preset.label],
			),
		),
	);

const EDITOR_TEXT = "m-0 border-0 p-3.5 font-mono text-[16px] leading-[1.6] whitespace-pre [grid-area:1/1] [tab-size:2] sm:text-[12.5px]";

const editor = (h: H, model: Model): Html =>
	h.section(
		[h.Class(`${CARD} flex min-w-0 flex-col p-4`), h.AriaLabel("Program")],
		[
			presetTabs(h, model),
			h.p([h.Class("mt-3 min-h-[3.2em] text-[13.5px] text-dim")], [presetFor(model.preset).blurb]),
			h.label([h.For("source"), h.Class("sr-only")], ["Program source (TypeScript)"]),
			h.div(
				[h.Class("mt-3 max-h-[320px] min-h-[220px] flex-1 overflow-auto rounded-lg border border-line bg-panel focus-within:border-ink lg:max-h-[560px]")],
				[
					h.div(
						[h.Class("grid min-h-full min-w-full w-max")],
						[
							h.pre([h.AriaHidden(true), h.Class(`${EDITOR_TEXT} pointer-events-none text-ink`)], [...highlight(h, model.source), "\n"]),
							h.textarea([
								h.Id("source"),
								h.Rows(model.source.split("\n").length + 1),
								h.Spellcheck(false),
								h.Wrap("off"),
								h.Autocomplete("off"),
								h.Value(model.source),
								h.Class(`${EDITOR_TEXT} h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-ink outline-none selection:bg-info/30`),
								h.OnInput((value) => Message.EditedSource({ value })),
							]),
						],
					),
				],
			),
			h.div(
				[h.Class("mt-3 flex flex-wrap items-center gap-3")],
				[
					button(h, Option.isSome(model.snapshot) ? "Run again" : "Run it", Message.ClickedRun(), PRIMARY, !Busy.isAnyOf(["Idle"])(model.busy)),
					h.span([h.Class("text-[12.5px] text-faint")], ["TypeScript, no build step. ", h.code([h.Class("font-mono")], ["tool(name, args)"]), " is the only way out."]),
				],
			),
		],
	);

const stat = (h: H, label: string, value: string, hint: string, highlight = false): Html =>
	h.div(
		[h.Class("min-w-0 rounded-lg border border-line bg-panel px-3 py-2"), h.Title(hint)],
		[
			h.div([h.Class("text-[11.5px] text-faint")], [label]),
			h.div([h.Class(`truncate font-mono text-[17px] font-medium ${highlight ? "text-amber" : "text-ink"}`)], [value]),
		],
	);

const stats = (h: H, snapshot: Snapshot): Html =>
	h.div(
		[h.Class("grid grid-cols-2 gap-2 sm:grid-cols-4")],
		[
			stat(h, "Steps", String(snapshot.totalSteps), "Each step is one request or alarm that restored the program, ran it, and saved it again."),
			stat(h, "Objects", String(snapshot.objects), "How many different Durable Object instances have run this one program.", snapshot.objects > 1),
			stat(h, "Kills", String(snapshot.kills.length), "ctx.abort() calls. Memory, the wasm instance and the JS heap are gone; storage stays.", snapshot.kills.length > 0),
			stat(h, "Stored state", kilobytes(snapshot.deltaBytes), "The snapshot delta in Durable Object storage. The base is rebuilt, never stored."),
		],
	);

const askUserQuestion = (call: ToolCall): Option.Option<string> => {
	const match = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(call.args);

	return match?.[1] === undefined ? Option.none() : Option.some(match[1].replaceAll('\\"', '"'));
};

const Choice = Schema.Struct({ text: Schema.String, options: Schema.Array(Schema.String) });

const decodeChoice = Schema.decodeUnknownOption(Schema.fromJsonString(Choice));

const storySoFar = (model: Model): ReadonlyArray<string> =>
	Option.match(model.snapshot, { onNone: () => [], onSome: (snapshot) => snapshot.steps.flatMap((step) => step.logs) });

const STORY_LINES = 14;

const story = (h: H, lines: ReadonlyArray<string>): Html => {
	const shown = lines.slice(-STORY_LINES);
	const fresh = Math.max(0, shown.length - 3);

	return h.div(
		[h.Id("story"), h.Class("space-y-1 font-mono text-[13px] leading-[1.55] break-words"), h.AriaLive("polite")],
		shown.map((line, index) => h.p([h.Class(index >= fresh ? "text-ink" : "text-faint")], [line])),
	);
};

const gameCard = (h: H, model: Model, text: string, options: ReadonlyArray<string>): Html => {
	const disabled = !Busy.isAnyOf(["Idle"])(model.busy);

	return h.div(
		[h.Class("rounded-lg border border-amber-line bg-amber-soft p-4")],
		[
			story(h, storySoFar(model)),
			h.p([h.Class("mt-4 text-[17px] font-medium text-ink")], [text]),
			h.div(
				[h.Class("mt-3 flex flex-wrap gap-2")],
				options.map((option, index) => button(h, option, Message.ClickedQuickAnswer({ answer: String(index) }), index === 0 ? PRIMARY : SECONDARY, disabled)),
			),
			h.p([h.Class("mt-3 text-[12px] text-faint")], ["The game is frozen inside choose(). Nothing is running. Try killing the Durable Object before you pick."]),
		],
	);
};

const waitingCard = (h: H, model: Model, call: ToolCall): Html =>
	call.name === "choose"
		? Option.match(decodeChoice(call.args), { onNone: () => answerCard(h, model, call), onSome: ({ text, options }) => gameCard(h, model, text, options) })
		: answerCard(h, model, call);

const answerCard = (h: H, model: Model, call: ToolCall): Html => {
	const disabled = !Busy.isAnyOf(["Idle"])(model.busy);
	const question = call.name === "ask_user" ? askUserQuestion(call) : Option.none();

	return h.div(
		[h.Class("rounded-lg border border-amber-line bg-amber-soft p-4")],
		[
			h.p([h.Class("text-[13px] text-dim")], ["The program called ", h.code([h.Class("font-mono font-medium text-ink")], [`tool("${call.name}")`]), " and froze. Nothing is running now."]),
			...Option.match(question, {
				onSome: (text) => [
					h.p([h.Class("mt-3 text-[17px] font-medium text-ink")], [text]),
					h.div(
						[h.Class("mt-3 flex gap-2")],
						[button(h, "Yes", Message.ClickedQuickAnswer({ answer: "true" }), PRIMARY, disabled), button(h, "No", Message.ClickedQuickAnswer({ answer: "false" }), SECONDARY, disabled)],
					),
				],
				onNone: () => [
					h.pre([h.Class("mt-3 max-h-40 overflow-auto rounded-md bg-bg/70 p-3 font-mono text-[12px] text-dim")], [pretty(call.args)]),
					h.form(
						[h.Class("mt-3"), h.OnSubmit(Message.SubmittedAnswer())],
						[
							h.label([h.For("answer"), h.Class("text-[12.5px] font-medium text-dim")], ["What tool() returns (JSON)"]),
							h.textarea([
								h.Id("answer"),
								h.Rows(6),
								h.Spellcheck(false),
								h.Value(model.answerDraft),
								h.Class("mt-1.5 w-full rounded-md border border-line-strong bg-bg p-2.5 font-mono text-[12px] text-ink outline-none focus:border-ink"),
								h.OnInput((value) => Message.EditedAnswer({ value })),
							]),
							h.button([h.Type("submit"), h.Disabled(disabled), h.Class(`${PRIMARY} mt-2`)], ["Send answer"]),
						],
					),
				],
			}),
		],
	);
};

const runningCard = (h: H): Html =>
	h.div(
		[h.Class("rounded-lg border border-line bg-panel p-4 text-[13.5px] text-dim")],
		["The loop ran out of its tick budget, so it was frozen mid-iteration. An alarm restores it every 120 ms for the next slice. Kill it whenever you like."],
	);

const brag = (h: H, snapshot: Option.Option<Snapshot>): ReadonlyArray<Html> =>
	Option.match(Option.filter(snapshot, (shown) => shown.kills.length > 0), {
		onNone: () => [],
		onSome: (shown) => [
			h.p(
				[h.Id("brag"), h.Class("mb-3 text-[16px] font-semibold text-amber")],
				[`You killed the Durable Object ${shown.kills.length} ${shown.kills.length === 1 ? "time" : "times"}. ${shown.objects} different objects ran this one program. It never noticed.`],
			),
		],
	});

const finishedCard = (h: H, model: Model, result: string): Html =>
	h.div(
		[h.Class("rounded-lg border border-line bg-panel p-4")],
		[...brag(h, model.snapshot), ...(storySoFar(model).length > 0 ? [story(h, storySoFar(model)), h.div([h.Class("my-3 border-t border-line")], [])] : []), h.p([h.Class("text-[13px] text-dim")], ["The program's last expression:"]), h.pre([h.Class("mt-2 max-h-48 overflow-auto font-mono text-[12px] text-ink")], [pretty(result)])],
	);

const failedCard = (h: H, reason: string): Html =>
	h.div([h.Class("rounded-lg border border-bad-line bg-bad-soft p-4")], [h.pre([h.Class("font-mono text-[12px] whitespace-pre-wrap text-bad")], [reason])]);

const outcomeCard = (h: H, model: Model, outcome: Outcome): Html =>
	Match.value(outcome).pipe(
		Match.tagsExhaustive({
			Waiting: ({ call }) => waitingCard(h, model, call),
			Running: () => runningCard(h),
			Finished: ({ result }) => finishedCard(h, model, result),
			Failed: ({ reason }) => failedCard(h, reason),
		}),
	);

const triggerLabel = (step: Step): string => {
	if (step.trigger === "start") return "start";

	if (step.trigger === "alarm") return "alarm";

	return `answer ${Option.getOrElse(step.answer, () => "").replaceAll(/\s+/g, " ").slice(0, 28)}`;
};

const stepTag = (step: Step): string =>
	Match.value(step.outcome).pipe(
		Match.tagsExhaustive({
			Waiting: ({ call }) => `froze at tool("${call.name}")`,
			Running: () => "slice",
			Finished: () => "finished",
			Failed: () => "failed",
		}),
	);

const killRow = (h: H, kill: Kill): Html =>
	h.li(
		[h.Class("flex items-center gap-2 py-1.5 pl-1 text-[12.5px] text-bad")],
		[h.span([h.Class("font-mono")], ["✕"]), h.span([], ["killed object ", h.code([h.Class("font-mono")], [kill.object]), " with ctx.abort()"])],
	);

const stepRow = (h: H, step: Step, previous: Option.Option<Step>): Html => {
	const newObject = Option.exists(previous, (before) => before.object !== step.object);

	return h.li(
		[h.Class("border-t border-line py-2 first:border-t-0")],
		[
			h.div(
				[h.Class("grid grid-cols-[2.2rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 text-[12.5px] sm:grid-cols-[2.2rem_minmax(0,1fr)_auto]")],
				[
					h.span([h.Class("font-mono text-faint")], [`#${step.n}`]),
					h.span([h.Class("truncate")], [h.span([h.Class("text-faint")], [`${triggerLabel(step)} → `]), h.span([h.Class("text-ink")], [stepTag(step)])]),
					h.span(
						[h.Class("col-start-2 flex items-center gap-2 font-mono text-[11.5px] text-faint sm:col-start-auto")],
						[
							step.deltaBytes > 0 ? h.span([], [kilobytes(step.deltaBytes)]) : h.span([], []),
							h.span(
								[h.Class(`rounded px-1.5 py-px ${newObject ? "bg-amber-soft text-amber" : "bg-raised"}`), h.Title(newObject ? "A different Durable Object instance than the step before" : "Durable Object instance")],
								[step.object],
							),
							h.span([], [`${step.ms} ms`]),
						],
					),
				],
			),
			...(step.logs.length > 0 ? [h.pre([h.Class("mt-1 ml-[2.7rem] font-mono text-[11.5px] break-words whitespace-pre-wrap text-dim")], [step.logs.map((line) => `› ${line}`).join("\n")])] : []),
		],
	);
};

const timeline = (h: H, snapshot: Snapshot): Html => {
	const rows = snapshot.steps.flatMap((step, index) => {
		const kills = snapshot.kills.filter((kill) => kill.afterStep === step.n);

		return [stepRow(h, step, Option.fromNullishOr(snapshot.steps[index - 1])), ...kills.map((kill) => killRow(h, kill))];
	});

	const hidden = snapshot.totalSteps - snapshot.steps.length;

	return h.div(
		[h.Class("min-h-0")],
		[
			h.h3([h.Class("mb-1 text-[12.5px] font-medium text-faint")], [hidden > 0 ? `Timeline (last ${snapshot.steps.length} of ${snapshot.totalSteps} steps)` : "Timeline"]),
			h.ol([h.Class("max-h-[340px] overflow-y-auto pr-1")], rows),
		],
	);
};

const emptyState = (h: H): Html =>
	h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-line-strong p-8 text-center")],
		[
			h.p([h.Class("font-medium")], ["Pick a program and run it."]),
			h.p([h.Class("mt-1 max-w-sm text-[13.5px] text-dim")], ["It runs in a Durable Object until it calls tool(). Then the whole program is saved, the object can die, and your answer resumes it on another."]),
		],
	);

const inspector = (h: H, model: Model): Html => {
	const tone = toneOf(outcomeOf(model));
	const pending = busyLabel(model.busy);

	return h.section(
		[h.Class(`${CARD} flex min-w-0 flex-col gap-4 p-4`), h.AriaLabel("Durable Object")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					h.span([h.Id("state"), h.Class(`flex items-center gap-2 text-[14px] font-medium ${tone.text}`), h.AriaLive("polite")], [h.i([h.Class(`size-2 rounded-full ${tone.dot}`), h.AriaHidden(true)], []), tone.label]),
					h.div(
						[h.Class("grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto")],
						[
							button(h, "New program", Message.ClickedNew(), `${SECONDARY} h-8 text-[13px]`, Option.isNone(model.snapshot)),
							button(h, "Kill the Durable Object", Message.ClickedKill(), `${DANGER} h-8 text-[13px]`, !isLive(model) || !Busy.isAnyOf(["Idle"])(model.busy)),
						],
					),
				],
			),
			...Option.match(model.snapshot, {
				onNone: () => [emptyState(h)],
				onSome: (snapshot) => [stats(h, snapshot), ...Option.match(snapshot.outcome, { onNone: () => [], onSome: (outcome) => [outcomeCard(h, model, outcome)] }), timeline(h, snapshot)],
			}),
			...Option.match(pending, {
				onNone: () => [],
				onSome: (text) => [h.p([h.Class("flex items-center gap-2 text-[12.5px] text-dim"), h.Role("status")], [h.span([h.Class("size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ink")], []), text])],
			}),
			...Option.match(model.notice, { onNone: () => [], onSome: (text) => [h.p([h.Class("text-[12.5px] text-bad"), h.Role("alert")], [text])] }),
		],
	);
};

export const playground = (h: H, model: Model): Html =>
	h.div([h.Class("grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [&>*]:min-w-0")], [editor(h, model), inspector(h, model)]);

