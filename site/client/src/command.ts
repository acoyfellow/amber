import { Effect, Schema } from "effect";
import { Command, Navigation } from "foldkit";
import { AnswerText, ProgramId, Source } from "../../shared/protocol";
import { Message } from "./message";
import { ProgramClient } from "./rpc";

const reasonOf = (error: { readonly message: string }) => error.message;

export const Start = Command.define("Start", {
	args: { id: ProgramId, source: Source },
	messages: [Message.GotSnapshot, Message.FailedRequest],
	execute: ({ id, source }) =>
		Effect.gen(function* () {
			const client = yield* ProgramClient;

			return Message.GotSnapshot({ snapshot: yield* client.Start({ id, source }) });
		}).pipe(Effect.catch((error) => Effect.succeed(Message.FailedRequest({ reason: reasonOf(error) })))),
});

export const Answer = Command.define("Answer", {
	args: { id: ProgramId, answer: AnswerText },
	messages: [Message.GotSnapshot, Message.FailedRequest],
	execute: ({ id, answer }) =>
		Effect.gen(function* () {
			const client = yield* ProgramClient;

			return Message.GotSnapshot({ snapshot: yield* client.Answer({ id, answer }) });
		}).pipe(
			Effect.catchTag("BadAnswer", ({ reason }) => Effect.succeed(Message.FailedRequest({ reason: `That is not JSON: ${reason}` }))),
			Effect.catchTag("NotWaiting", ({ state }) => Effect.succeed(Message.FailedRequest({ reason: `The program is not waiting (it is ${state}).` }))),
			Effect.catch((error) => Effect.succeed(Message.FailedRequest({ reason: reasonOf(error) }))),
		),
});

export const Kill = Command.define("Kill", {
	args: { id: ProgramId },
	messages: [Message.CompletedKill],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* ProgramClient;

			yield* client.Kill({ id });
		}).pipe(Effect.ignoreCause, Effect.as(Message.CompletedKill())),
});

export const Fetch = Command.define("Fetch", {
	args: { id: ProgramId },
	messages: [Message.GotSnapshot, Message.FailedRequest],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* ProgramClient;

			return Message.GotSnapshot({ snapshot: yield* client.Snapshot({ id }) });
		}).pipe(Effect.catch((error) => Effect.succeed(Message.FailedRequest({ reason: reasonOf(error) })))),
});

export const ShowProgram = Command.define("ShowProgram", {
	args: { id: ProgramId },
	messages: [Message.CompletedNavigation],
	execute: ({ id }) => Navigation.replaceUrl(`/p/${id}`).pipe(Effect.as(Message.CompletedNavigation())),
});

export const StartFresh = Command.define("StartFresh", {
	messages: [Message.CompletedNavigation],
	execute: Navigation.load("/").pipe(Effect.as(Message.CompletedNavigation())),
});

export const decodeSource = Schema.decodeUnknownOption(Source);

export const decodeAnswer = Schema.decodeUnknownOption(AnswerText);
