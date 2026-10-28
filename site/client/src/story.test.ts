import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";
import { Finished, ProgramId, Running, type Snapshot, Waiting } from "../../shared/protocol";
import { Answer, Fetch, Kill, ShowProgram, Start } from "./command";
import { initialModel } from "./main";
import { Message } from "./message";
import { Busy } from "./model";
import { update } from "./update";

const id = ProgramId.make("p-story");

const fresh = initialModel({ id, isNew: true });

const snapshot = (overrides: Partial<Snapshot>): Snapshot => ({
	id,
	outcome: Option.none(),
	steps: [],
	totalSteps: 1,
	kills: [],
	objects: 1,
	current: "obj-1",
	deltaBytes: 1815,
	baseSha: "sha",
	...overrides,
});

const waitingFor = (name: string, args: string, totalSteps: number) => snapshot({ outcome: Option.some(Waiting.make({ call: { name, args } })), totalSteps });

const isIdle = Busy.isAnyOf(["Idle"]);

describe("running a program", () => {
	test("Run starts the program in its object and puts the program id in the URL", () => {
		story(
			update,
			given(fresh),
			message(Message.ClickedRun()),
			model((current) => {
				expect(Busy.isAnyOf(["Starting"])(current.busy)).toBe(true);
			}),
			Command.expectHas(Start),
			Command.expectHas(ShowProgram),
			Command.resolve(Start, Message.GotSnapshot({ snapshot: waitingFor("gh.list_issues", "{}", 1) })),
			Command.resolve(ShowProgram, Message.CompletedNavigation()),
			model((current) => {
				expect(isIdle(current.busy)).toBe(true);
				expect(Option.isSome(current.snapshot)).toBe(true);
			}),
		);
	});

	test("an empty program is refused before any request", () => {
		story(
			update,
			given(fresh),
			message(Message.EditedSource({ value: "" })),
			message(Message.ClickedRun()),
			Command.expectNone(),
			model((current) => {
				expect(current.notice).toEqual(Option.some("The program must be 1 to 8000 characters."));
				expect(isIdle(current.busy)).toBe(true);
			}),
		);
	});
});

describe("answering", () => {
	test("a new tool call pre-fills a suggested answer once, and keeps the visitor's edits after that", () => {
		const call = waitingFor("gh.list_issues", "{}", 1);

		story(
			update,
			given(fresh),
			message(Message.GotSnapshot({ snapshot: call })),
			model((current) => {
				expect(current.answerDraft).toContain('"desk card flicker"');
			}),
			message(Message.EditedAnswer({ value: "[]" })),
			message(Message.GotSnapshot({ snapshot: call })),
			model((current) => {
				expect(current.answerDraft).toBe("[]");
			}),
		);
	});

	test("Yes answers the pending call, and the next snapshot shows the next question", () => {
		story(
			update,
			given(fresh),
			message(Message.GotSnapshot({ snapshot: waitingFor("ask_user", '{"question":"close #41?"}', 2) })),
			message(Message.ClickedQuickAnswer({ answer: "true" })),
			Command.expectHas(Answer),
			Command.resolve(Answer, Message.GotSnapshot({ snapshot: waitingFor("ask_user", '{"question":"close #42?"}', 3) })),
			model((current) => {
				expect(Option.map(current.snapshot, (shown) => shown.totalSteps)).toEqual(Option.some(3));
			}),
		);
	});

	test("a refused answer shows why and lets the visitor try again", () => {
		story(
			update,
			given(fresh),
			message(Message.GotSnapshot({ snapshot: waitingFor("ask_user", "{}", 2) })),
			message(Message.SubmittedAnswer()),
			Command.resolve(Answer, Message.FailedRequest({ reason: "That is not JSON: unexpected token" })),
			model((current) => {
				expect(current.notice).toEqual(Option.some("That is not JSON: unexpected token"));
				expect(isIdle(current.busy)).toBe(true);
			}),
		);
	});
});

describe("killing", () => {
	test("after a kill the page reads the stored state again", () => {
		story(
			update,
			given(fresh),
			message(Message.GotSnapshot({ snapshot: waitingFor("ask_user", "{}", 2) })),
			message(Message.ClickedKill()),
			Command.expectHas(Kill),
			Command.resolve(Kill, Message.CompletedKill()),
			Command.expectHas(Fetch),
			Command.resolve(Fetch, Message.GotSnapshot({ snapshot: snapshot({ ...waitingFor("ask_user", "{}", 2), objects: 1, kills: [{ at: 1, afterStep: 2, object: "obj-1" }] }) })),
			model((current) => {
				expect(Option.map(current.snapshot, (shown) => shown.kills.length)).toEqual(Option.some(1));
			}),
		);
	});

	test("a running loop is polled, and a finished one is shown", () => {
		story(
			update,
			given(fresh),
			message(Message.GotSnapshot({ snapshot: snapshot({ outcome: Option.some(Running.make({})) }) })),
			message(Message.Polled()),
			Command.expectHas(Fetch),
			Command.resolve(Fetch, Message.GotSnapshot({ snapshot: snapshot({ outcome: Option.some(Finished.make({ result: "{}" })), totalSteps: 25 }) })),
			model((current) => {
				expect(Option.map(current.snapshot, (shown) => shown.totalSteps)).toEqual(Option.some(25));
			}),
		);
	});
});
