import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";
import { ProgramId, Snapshot } from "../../shared/protocol";
import { PresetKey } from "./presets";

export const Busy = defineTaggedUnion({
	Idle: {},
	Starting: {},
	Answering: {},
	Killing: {},
});

export type Busy = typeof Busy.Type;

export const Model = Schema.Struct({
	id: ProgramId,
	preset: PresetKey,
	source: Schema.String,
	snapshot: Schema.Option(Snapshot),
	busy: Busy,
	answerDraft: Schema.String,
	draftForStep: Schema.Number,
	notice: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;
