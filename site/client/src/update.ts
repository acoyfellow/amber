import { Option } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { isWaiting, type Snapshot } from "../../shared/protocol";
import { Answer, decodeAnswer, decodeSource, Fetch, Kill, ShowProgram, Start, StartFresh } from "./command";
import { Message } from "./message";
import { Busy, type Model } from "./model";
import { presetFor, suggestedAnswer } from "./presets";
import type { ProgramClient } from "./rpc";

type UpdateReturn = Update.Return<Model, Message, ProgramClient>;

const isIdle = (model: Model): boolean => Busy.isAnyOf(["Idle"])(model.busy);

const notice = (model: Model, text: string): Model => modifyFields(model, { notice: () => Option.some(text), busy: () => Busy.Idle() });

const applySnapshot = (model: Model, snapshot: Snapshot): Model => {
	const waiting = Option.map(Option.filter(snapshot.outcome, isWaiting), (outcome) => outcome.call);
	const freshCall = Option.isSome(waiting) && snapshot.totalSteps !== model.draftForStep;

	return modifyFields(model, {
		snapshot: () => Option.some(snapshot),
		busy: () => Busy.Idle(),
		notice: () => Option.none(),
		answerDraft: (draft) => (freshCall ? Option.match(waiting, { onNone: () => draft, onSome: suggestedAnswer }) : draft),
		draftForStep: (step) => (freshCall ? snapshot.totalSteps : step),
	});
};

const run = (model: Model): UpdateReturn => {
	if (!isIdle(model)) return { model };

	return Option.match(decodeSource(model.source), {
		onNone: () => ({ model: notice(model, "The program must be 1 to 8000 characters.") }),
		onSome: (source) => ({
			model: modifyFields(model, { busy: () => Busy.Starting(), notice: () => Option.none(), draftForStep: () => 0 }),
			commands: [Start({ id: model.id, source }), ShowProgram({ id: model.id })],
		}),
	});
};

const answer = (model: Model, text: string): UpdateReturn => {
	if (!isIdle(model)) return { model };

	return Option.match(decodeAnswer(text.trim()), {
		onNone: () => ({ model: notice(model, "The answer must be 1 to 16000 characters of JSON.") }),
		onSome: (value) => ({ model: modifyFields(model, { busy: () => Busy.Answering(), notice: () => Option.none() }), commands: [Answer({ id: model.id, answer: value })] }),
	});
};

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		PickedPreset: ({ preset }) => ({ model: modifyFields(model, { preset: () => preset, source: () => presetFor(preset).source, notice: () => Option.none() }) }),
		EditedSource: ({ value }) => ({ model: modifyFields(model, { source: () => value }) }),
		ClickedRun: () => run(model),
		ClickedQuickAnswer: ({ answer: text }) => answer(model, text),
		EditedAnswer: ({ value }) => ({ model: modifyFields(model, { answerDraft: () => value }) }),
		SubmittedAnswer: () => answer(model, model.answerDraft),
		ClickedKill: () => (isIdle(model) ? { model: modifyFields(model, { busy: () => Busy.Killing() }), commands: [Kill({ id: model.id })] } : { model }),
		CompletedKill: () => ({ model, commands: [Fetch({ id: model.id })] }),
		ClickedNew: () => ({ model, commands: [StartFresh()] }),
		GotSnapshot: ({ snapshot }) => ({ model: applySnapshot(model, snapshot) }),
		FailedRequest: ({ reason }) => ({ model: notice(model, reason) }),
		Polled: () => (isIdle(model) ? { model, commands: [Fetch({ id: model.id })] } : { model }),
		CompletedNavigation: () => ({ model }),
	});
