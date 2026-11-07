export type Issue = {
	id: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: Array<string>;
	comments: Array<string>;
	updatedDaysAgo: number;
};

export type Pr = {
	id: number;
	title: string;
	author: string;
	ciRun: string;
	approved: boolean;
	merged: boolean;
	labels: Array<string>;
	comments: Array<string>;
};

export type CiRun = { id: string; pendingPolls: number; final: "success" | "failure"; failingTest?: string; polls: number };

export type Fixture = {
	issues: Array<Omit<Issue, "state" | "labels" | "comments"> & Partial<Pick<Issue, "state" | "labels" | "comments">>>;
	prs: Array<Omit<Pr, "merged" | "labels" | "comments"> & Partial<Pick<Pr, "merged" | "labels" | "comments">>>;
	ci: Array<Omit<CiRun, "polls">>;
};

export type Ledger = {
	issues: Record<string, Issue>;
	prs: Record<string, Pr>;
	ci: Record<string, CiRun>;
	releases: Array<string>;
	notifications: Array<{ channel: string; message: string }>;
	asks: Array<{ question: string; answer: string }>;
	events: Array<string>;
	effects: Array<{ key: string; afterResume: boolean }>;
	toolCalls: number;
	resumed: boolean;
};

export const ledgerFrom = (fixture: Fixture): Ledger => ({
	issues: Object.fromEntries(fixture.issues.map((issue) => [String(issue.id), { state: "open", labels: [], comments: [], ...issue }])),
	prs: Object.fromEntries(fixture.prs.map((pr) => [String(pr.id), { merged: false, labels: [], comments: [], ...pr }])),
	ci: Object.fromEntries(fixture.ci.map((run) => [run.id, { ...run, polls: 0 }])),
	releases: [],
	notifications: [],
	asks: [],
	events: [],
	effects: [],
	toolCalls: 0,
	resumed: false,
});

type Args = Record<string, unknown>;

const num = (value: unknown): number => Number(String(value ?? "").replace(/^#/, ""));

const str = (value: unknown): string => String(value ?? "");

const effectKey = (name: string, args: Args): string => `${name}(${JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]))})`;

const recordEffect = (ledger: Ledger, name: string, args: Args): void => {
	ledger.effects.push({ key: effectKey(name, args), afterResume: ledger.resumed });
	ledger.resumed = false;
};

const issueOrPr = (ledger: Ledger, id: number): Issue | Pr | undefined => ledger.issues[String(id)] ?? ledger.prs[String(id)];

export const EFFECT_TOOLS = new Set(["label", "close", "post_comment", "merge_pr", "create_release", "notify"]);

export const runFixtureTool = (ledger: Ledger, name: string, args: Args): unknown => {
	if (EFFECT_TOOLS.has(name)) recordEffect(ledger, name, args);

	switch (name) {
		case "list_issues": {
			const state = str(args.state || "open");
			return Object.values(ledger.issues)
				.filter((issue) => state === "all" || issue.state === state)
				.map(({ id, title, state: s, labels, updatedDaysAgo }) => ({ id, title, state: s, labels, updatedDaysAgo }));
		}
		case "get_issue": {
			const found = issueOrPr(ledger, num(args.id ?? args.issue));
			return found ?? { error: `no issue ${str(args.id ?? args.issue)}` };
		}
		case "list_prs":
			return Object.values(ledger.prs)
				.filter((pr) => !pr.merged)
				.map(({ id, title, author, ciRun, approved, labels }) => ({ id, title, author, ci_run: ciRun, approved, labels }));
		case "fetch_ci": {
			const run = ledger.ci[str(args.run ?? args.id)];
			if (!run) return { error: `no CI run ${str(args.run ?? args.id)}` };
			run.polls += 1;
			const status = run.polls <= run.pendingPolls ? "pending" : run.final;
			ledger.events.push(`ci:${run.id}:${status}`);
			return status === "failure" ? { run: run.id, status, failing_test: run.failingTest } : { run: run.id, status };
		}
		case "label": {
			const target = issueOrPr(ledger, num(args.issue ?? args.id ?? args.pr));
			if (!target) return { error: "no such issue or PR" };
			const label = str(args.label);
			if (!target.labels.includes(label)) target.labels.push(label);
			ledger.events.push(`label:${target.id}:${label}`);
			return { ok: true, labels: target.labels };
		}
		case "close": {
			const issue = ledger.issues[String(num(args.issue ?? args.id))];
			if (!issue) return { error: "no such issue" };
			issue.state = "closed";
			ledger.events.push(`close:${issue.id}`);
			return { ok: true };
		}
		case "post_comment": {
			const target = issueOrPr(ledger, num(args.issue ?? args.id ?? args.pr));
			if (!target) return { error: "no such issue or PR" };
			target.comments.push(str(args.body));
			ledger.events.push(`comment:${target.id}`);
			return { ok: true };
		}
		case "merge_pr": {
			const pr = ledger.prs[String(num(args.pr ?? args.id))];
			if (!pr) return { error: "no such PR" };
			pr.merged = true;
			ledger.events.push(`merge:${pr.id}`);
			return { ok: true };
		}
		case "create_release": {
			const version = str(args.version);
			ledger.releases.push(version);
			ledger.events.push(`release:${version}`);
			return { ok: true, version };
		}
		case "notify": {
			const channel = str(args.channel);
			ledger.notifications.push({ channel, message: str(args.message) });
			ledger.events.push(`notify:${channel}`);
			return { ok: true };
		}
		default:
			return { error: `unknown tool ${name}` };
	}
};

export const duplicateEffects = (ledger: Ledger): { total: number; afterKill: number } => {
	const seen = new Set<string>();
	let total = 0;
	let afterKill = 0;
	for (const effect of ledger.effects) {
		if (seen.has(effect.key)) {
			total += 1;
			if (effect.afterResume) afterKill += 1;
		}
		seen.add(effect.key);
	}
	return { total, afterKill };
};

const prop = (type: string, description?: string) => (description ? { type, description } : { type });

export const TOOL_SCHEMAS = [
	{ name: "list_issues", description: "List issues. state: open (default), closed, or all.", parameters: { state: prop("string") }, required: [] },
	{ name: "get_issue", description: "Get one issue or PR with body, labels and comments.", parameters: { id: prop("number") }, required: ["id"] },
	{ name: "list_prs", description: "List open (unmerged) pull requests with CI run id and review approval.", parameters: {}, required: [] },
	{ name: "fetch_ci", description: "Get the status of a CI run: pending, success or failure. Pending runs finish if you poll again.", parameters: { run: prop("string") }, required: ["run"] },
	{ name: "label", description: "Add a label to an issue or PR.", parameters: { issue: prop("number"), label: prop("string") }, required: ["issue", "label"] },
	{ name: "close", description: "Close an issue.", parameters: { issue: prop("number") }, required: ["issue"] },
	{ name: "post_comment", description: "Post a comment on an issue or PR.", parameters: { issue: prop("number"), body: prop("string") }, required: ["issue", "body"] },
	{ name: "merge_pr", description: "Merge a pull request.", parameters: { pr: prop("number") }, required: ["pr"] },
	{ name: "create_release", description: "Create a release.", parameters: { version: prop("string") }, required: ["version"] },
	{ name: "notify", description: "Send a chat message to a channel such as #releases.", parameters: { channel: prop("string"), message: prop("string") }, required: ["channel", "message"] },
	{ name: "ask_user", description: "Ask the human a question and wait for the answer. Required before any action the task says needs approval.", parameters: { question: prop("string") }, required: ["question"] },
] as const;

export const TOOL_DECLARATIONS = `type IssueSummary = { id: number; title: string; state: "open" | "closed"; labels: string[]; updatedDaysAgo: number };
type Issue = IssueSummary & { body: string; comments: string[] };
type PrSummary = { id: number; title: string; author: string; ci_run: string; approved: boolean; labels: string[] };
type Ci = { run: string; status: "pending" | "success" | "failure"; failing_test?: string };
type Ok = { ok: true } | { error: string };

declare function tool(name: "list_issues", args: { state?: "open" | "closed" | "all" }): IssueSummary[];
declare function tool(name: "get_issue", args: { id: number }): Issue;
declare function tool(name: "list_prs", args: {}): PrSummary[];
declare function tool(name: "fetch_ci", args: { run: string }): Ci;
declare function tool(name: "label", args: { issue: number; label: string }): Ok;
declare function tool(name: "close", args: { issue: number }): Ok;
declare function tool(name: "post_comment", args: { issue: number; body: string }): Ok;
declare function tool(name: "merge_pr", args: { pr: number }): Ok;
declare function tool(name: "create_release", args: { version: string }): Ok;
declare function tool(name: "notify", args: { channel: string; message: string }): Ok;
declare function tool(name: "ask_user", args: { question: string }): string;
declare function tool(name: "llm", args: { prompt: string }): string;`;
