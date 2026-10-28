import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Snapshot } from "../../shared/protocol";
import { PresetKey } from "./presets";

export const Message = defineMessageUnion({
	PickedPreset: { preset: PresetKey },
	EditedSource: { value: Schema.String },
	ClickedRun: {},
	ClickedQuickAnswer: { answer: Schema.String },
	EditedAnswer: { value: Schema.String },
	SubmittedAnswer: {},
	ClickedKill: {},
	CompletedKill: {},
	ClickedNew: {},
	GotSnapshot: { snapshot: Snapshot },
	FailedRequest: { reason: Schema.String },
	Polled: {},
	CompletedNavigation: {},
});

export type Message = typeof Message.Type;
