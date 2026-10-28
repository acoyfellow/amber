import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { type LoaderReply, LoaderReplyJson, type ReplayReply, ReplayReplyJson, ToolEntry } from "../../shared/codemode";

const Journal = Schema.Struct({ script: Schema.String, strict: Schema.Boolean, entries: Schema.Array(ToolEntry), pending: Schema.NullOr(Schema.Struct({ name: Schema.String, args: Schema.String })), scriptRuns: Schema.Number, replayedCalls: Schema.Number });

type Journal = typeof Journal.Type;

const JournalJson = Schema.fromJsonString(Journal);

const encodeJournal = Schema.encodeSync(JournalJson);

const decodeJournal = Schema.decodeUnknownOption(JournalJson);

const decodeLoader = Schema.decodeSync(LoaderReplyJson);

const encodeReply = Schema.encodeSync(ReplayReplyJson);

const HARNESS = `import { WorkerEntrypoint } from "cloudflare:workers";
class Pause { constructor(name, args) { this.name = name; this.args = args; } }
class Diverged { constructor(at) { this.at = at; } }
const reply = (fields, replayed) => JSON.stringify({ kind: "done", value: null, name: null, args: null, at: null, reason: null, replayed, ...fields });
export default class extends WorkerEntrypoint {
  run(journalJson, strict) {
    const journal = JSON.parse(journalJson);
    let cursor = 0;
    const tool = (name, args) => {
      const encoded = JSON.stringify(args ?? null);
      if (cursor >= journal.length) throw new Pause(name, encoded);
      const entry = journal[cursor];
      if (entry.name !== name || (strict && entry.args !== encoded)) throw new Diverged(cursor);
      cursor += 1;
      return JSON.parse(entry.result);
    };
    try {
      return reply({ kind: "done", value: JSON.stringify(program(tool)) }, cursor);
    } catch (error) {
      if (error instanceof Pause) return reply({ kind: "pause", name: error.name, args: error.args }, cursor);
      if (error instanceof Diverged) return reply({ kind: "diverged", at: error.at }, cursor);
      return reply({ kind: "error", reason: String(error) }, cursor);
    }
  }
}
`;

const moduleFor = (script: string): string => `${HARNESS}\nfunction program(tool) {\n${script}\n}\n`;

type ReplayEnv = { readonly LOADER: WorkerLoader };

interface ScriptEntrypoint extends Rpc.WorkerEntrypointBranded {
	readonly run: (journal: string, strict: boolean) => string;
}

export class ReplayRunner extends DurableObject<ReplayEnv> {
	private readonly object = crypto.randomUUID().slice(0, 8);

	private load(): Option.Option<Journal> {
		return decodeJournal(this.ctx.storage.kv.get<string>("journal"));
	}

	private save(journal: Journal): number {
		const stored = encodeJournal(journal);

		this.ctx.storage.kv.put("journal", stored);

		return stored.length;
	}

	private async runScript(journal: Journal): Promise<LoaderReply> {
		const worker = this.env.LOADER.get(`replay-${await digest(journal.script)}`, () => ({
			compatibilityDate: "2026-10-01",
			mainModule: "main.js",
			modules: { "main.js": moduleFor(journal.script) },
			globalOutbound: null,
		}));

		const entrypoint: Fetcher<ScriptEntrypoint> = worker.getEntrypoint<ScriptEntrypoint>();

		return decodeLoader(await entrypoint.run(JSON.stringify(journal.entries), journal.strict));
	}

	private async step(journal: Journal): Promise<string> {
		const reply = await this.runScript(journal);

		const next: Journal = {
			...journal,
			pending: reply.kind === "pause" && reply.name !== null && reply.args !== null ? { name: reply.name, args: reply.args } : null,
			scriptRuns: journal.scriptRuns + 1,
			replayedCalls: journal.replayedCalls + reply.replayed,
		};

		const result: ReplayReply = { step: reply, scriptRuns: next.scriptRuns, replayedCalls: next.replayedCalls, storedBytes: this.save(next), object: this.object };

		return encodeReply(result);
	}

	async begin(script: string, strict: boolean): Promise<string> {
		return this.step({ script, strict, entries: [], pending: null, scriptRuns: 0, replayedCalls: 0 });
	}

	async answer(result: string): Promise<string> {
		const journal = Option.getOrThrowWith(this.load(), () => new Error("no replay journal"));
		const pending = journal.pending;

		if (pending === null) throw new Error("the script is not waiting");

		return this.step({ ...journal, entries: [...journal.entries, { name: pending.name, args: pending.args, result }], pending: null });
	}

	kill(): void {
		this.ctx.abort("killed by the benchmark");
	}
}

const digest = async (text: string): Promise<string> => {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

	return Array.from(new Uint8Array(bytes).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
