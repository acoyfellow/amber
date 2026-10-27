import type { Schema } from "effect";

export type ToolContext = { readonly programId: string; readonly step: number; readonly key: string };

type Fn<A> = (args: A, context: ToolContext) => unknown;

export type ReadTool<A = unknown> = { readonly kind: "read"; readonly args: Schema.Decoder<A>; readonly run: Fn<A> };

export type WriteTool<A = unknown> = { readonly kind: "write"; readonly args: Schema.Decoder<A>; readonly run: Fn<A> };

export type ExternalTool<A = unknown> = { readonly kind: "external"; readonly args: Schema.Decoder<A>; readonly timeoutMs: number | undefined };

type Erased<Kind extends "read" | "write"> = { readonly kind: Kind; readonly args: Schema.Decoder<unknown>; readonly run: (args: never, context: ToolContext) => unknown };

export type Tool = Erased<"read"> | Erased<"write"> | ExternalTool<unknown>;

export type Tools = Readonly<Record<string, Tool>>;

export const read = <A>(args: Schema.Decoder<A>, run: Fn<A>): ReadTool<A> => ({ kind: "read", args, run });

export const write = <A>(args: Schema.Decoder<A>, run: Fn<A>): WriteTool<A> => ({ kind: "write", args, run });

export const external = <A>(args: Schema.Decoder<A>, options: { readonly timeoutMs?: number } = {}): ExternalTool<A> => ({
	kind: "external",
	args,
	timeoutMs: options.timeoutMs,
});
