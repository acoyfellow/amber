import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "../message";
import { highlight } from "./highlight";

export type H = HtmlBuilder<Message>;

export const BUTTON = "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export const PRIMARY = `${BUTTON} bg-accent text-accent-ink hover:opacity-90`;

export const SECONDARY = `${BUTTON} border border-line-strong bg-bg text-ink hover:bg-raised`;

export const DANGER = `${BUTTON} border border-bad-line bg-bg text-bad hover:bg-bad-soft`;

export const CARD = "rounded-xl border border-line bg-bg";

export const REPO = "https://github.com/acoyfellow/amber";

export const button = (h: H, label: string | Html, message: Message, style: string, disabled = false): Html =>
	h.button([h.Type("button"), h.Disabled(disabled), h.Class(style), h.OnClick(message)], [label]);

export const link = <M>(h: HtmlBuilder<M>, label: string, href: string, style: string): Html =>
	href.startsWith("http") ? h.a([h.Href(href), h.Target("_blank"), h.Rel("noreferrer"), h.Class(style)], [label]) : h.a([h.Href(href), h.Class(style)], [label]);

export const code = <M>(h: HtmlBuilder<M>, text: string, style = ""): Html =>
	h.pre([h.Class(`max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[12px] leading-[1.65] text-ink sm:text-[12.5px] ${style}`)], [h.code([], highlight(h, text))]);

export const inline = <M>(h: HtmlBuilder<M>, text: string): Html => h.code([h.Class("rounded bg-raised px-1.5 py-0.5 font-mono text-[0.88em]")], [text]);

export const kilobytes = (size: number): string => (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`);

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const pretty = (text: string): string => Option.match(parseJson(text), { onNone: () => text, onSome: (value) => JSON.stringify(value, null, 2) });

export const eyebrow = <M>(h: HtmlBuilder<M>, text: string): Html => h.p([h.Class("font-mono text-[12px] tracking-wide text-amber uppercase")], [text]);

export const sectionTitle = <M>(h: HtmlBuilder<M>, id: string, kicker: string, title: string, lede: string): Html =>
	h.div(
		[h.Class("mb-8 max-w-2xl")],
		[eyebrow(h, kicker), h.h2([h.Id(id), h.Class("mt-2 scroll-mt-24 text-[24px] leading-tight sm:text-[28px] font-semibold tracking-[-0.02em]")], [title]), h.p([h.Class("mt-3 text-dim")], [lede])],
	);
