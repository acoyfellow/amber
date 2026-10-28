import type { Html, HtmlBuilder } from "foldkit/html";

const KEYWORDS = new Set([
	"as",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"declare",
	"default",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"interface",
	"let",
	"new",
	"null",
	"of",
	"private",
	"readonly",
	"return",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"yield",
	"await",
	"async",
]);

const BUILTIN_TYPES = new Set(["string", "number", "boolean", "unknown", "never", "any", "bigint", "object"]);

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?n?\b)|([A-Za-z_$][\w$]*)/g;

export type Kind = "plain" | "comment" | "string" | "number" | "keyword" | "type" | "call";

export type Token = { readonly kind: Kind; readonly text: string };

const CLASS: Readonly<Record<Exclude<Kind, "plain">, string>> = {
	comment: "text-syn-comment italic",
	string: "text-syn-string",
	number: "text-syn-number",
	keyword: "text-syn-keyword",
	type: "text-syn-type",
	call: "text-syn-call",
};

const identifierKind = (word: string, rest: string): Kind => {
	if (KEYWORDS.has(word)) return "keyword";

	if (BUILTIN_TYPES.has(word) || /^[A-Z]/.test(word)) return "type";

	return /^\s*(<[^>\n]*>)?\s*\(/.test(rest) ? "call" : "plain";
};

const push = (tokens: Array<Token>, kind: Kind, text: string): void => {
	const last = tokens.at(-1);

	if (last !== undefined && last.kind === kind) tokens[tokens.length - 1] = { kind, text: last.text + text };
	else tokens.push({ kind, text });
};

export const tokenize = (source: string): ReadonlyArray<Token> => {
	const tokens: Array<Token> = [];
	let cursor = 0;

	for (const match of source.matchAll(TOKEN)) {
		const start = match.index;

		if (start > cursor) push(tokens, "plain", source.slice(cursor, start));

		const [text, comment, string, number, word] = match;

		if (comment !== undefined) push(tokens, "comment", text);
		else if (string !== undefined) push(tokens, "string", text);
		else if (number !== undefined) push(tokens, "number", text);
		else if (word !== undefined) push(tokens, identifierKind(word, source.slice(start + text.length, start + text.length + 40)), text);

		cursor = start + text.length;
	}

	if (cursor < source.length) push(tokens, "plain", source.slice(cursor));

	return tokens;
};

export const highlight = <M>(h: HtmlBuilder<M>, source: string): ReadonlyArray<Html | string> =>
	tokenize(source).map((token) => (token.kind === "plain" ? token.text : h.span([h.Class(CLASS[token.kind])], [token.text])));
