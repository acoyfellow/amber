import { Effect, Option, Schema } from "effect";
import type { Runtime } from "foldkit";
import { ProgramId } from "../../shared/protocol";
import { Fetch } from "./command";
import type { Message } from "./message";
import { Busy, type Model } from "./model";
import { presetFor } from "./presets";
import type { ProgramClient } from "./rpc";

const decodeId = Schema.decodeUnknownOption(ProgramId);

const PAGE_ROUTE = /^\/p\/([^/]+)\/?$/;

export const Flags = Schema.Struct({ id: ProgramId, isNew: Schema.Boolean });

export type Flags = typeof Flags.Type;

const freshId = (): ProgramId => ProgramId.make(`p-${crypto.randomUUID()}`);

export const flags: Effect.Effect<Flags> = Effect.sync(() =>
	Option.match(decodeId(PAGE_ROUTE.exec(globalThis.location.pathname)?.[1]), {
		onSome: (id) => ({ id, isNew: false }),
		onNone: () => ({ id: freshId(), isNew: true }),
	}),
);

export const initialModel = ({ id }: Flags): Model => ({
	id,
	preset: "dungeon",
	source: presetFor("dungeon").source,
	snapshot: Option.none(),
	busy: Busy.Idle(),
	answerDraft: "",
	draftForStep: 0,
	notice: Option.none(),
});

export const init: Runtime.ApplicationInit<Model, Message, Flags, ProgramClient> = (startup) => ({
	model: initialModel(startup),
	commands: startup.isNew ? [] : [Fetch({ id: startup.id })],
});
