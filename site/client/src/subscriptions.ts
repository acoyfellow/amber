import { Duration, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { isRunning as isRunningOutcome } from "../../shared/protocol";
import { Message } from "./message";
import type { Model } from "./model";
import type { ProgramClient } from "./rpc";

const POLL = Duration.millis(300);

const isRunning = (model: Model): boolean => Option.exists(Option.flatMap(model.snapshot, (snapshot) => snapshot.outcome), isRunningOutcome);

export const subscriptions = Subscription.make<Model, Message, ProgramClient>()((entry) => ({
	poll: entry(
		{ running: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ running: isRunning(model) }),
			dependenciesToStream: ({ running }) => (running ? Stream.tick(POLL).pipe(Stream.map(() => Message.Polled())) : Stream.empty),
		},
	),
}));
