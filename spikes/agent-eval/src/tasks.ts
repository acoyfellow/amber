import type { Fixture, Ledger } from "./world";

export type OracleRule = { readonly match: RegExp; readonly answer: string };

export type Check = { readonly name: string; readonly ok: boolean };

export type Variant = {
	readonly family: string;
	readonly variant: number;
	readonly input: Record<string, unknown>;
	readonly prompt: string;
	readonly fixture: Fixture;
	readonly oracle: ReadonlyArray<OracleRule>;
	readonly defaultAnswer: string;
	readonly check: (ledger: Ledger) => ReadonlyArray<Check>;
};

export type Family = {
	readonly id: string;
	readonly template: string;
	readonly variants: ReadonlyArray<Variant>;
};

export const answerFor = (variant: Variant, question: string): string => variant.oracle.find((rule) => rule.match.test(question))?.answer ?? variant.defaultAnswer;

const required = <T>(value: T | undefined, what: string): T => {
	if (value === undefined) throw new Error(`fixture has no ${what}`);
	return value;
};

const issue = (ledger: Ledger, id: number) => required(ledger.issues[String(id)], `issue ${id}`);

const pr = (ledger: Ledger, id: number) => required(ledger.prs[String(id)], `PR ${id}`);

const has = (labels: ReadonlyArray<string>, label: string) => labels.map((l) => l.toLowerCase()).includes(label.toLowerCase());

const at = (ledger: Ledger, prefix: string) => ledger.events.findIndex((event) => event.startsWith(prefix));

const idPattern = (id: number) => new RegExp(`(?<![\\d.])${id}(?![\\d.])`);

const askedAbout = (ledger: Ledger, pattern: RegExp) => ledger.asks.some((ask) => pattern.test(ask.question));

const channelIs = (actual: string, wanted: string) => actual.replace(/^#/, "").toLowerCase() === wanted.replace(/^#/, "").toLowerCase();

const YES_CLOSE = "Yes, close it.";

type TriageIssue = { readonly id: number; readonly title: string; readonly body: string; readonly type: "bug" | "feature" | "question"; readonly dupOf?: number };

type TriageParams = { readonly issues: ReadonlyArray<TriageIssue>; readonly approve: ReadonlyArray<number> };

const TRIAGE_TEMPLATE =
	"Triage every open issue. Give each exactly one type label: bug, feature, or question. Some issues are duplicates of an older issue (the input says how many): label the newer one 'duplicate' and comment 'Duplicate of #<older id>' on it. Ask the user before closing each duplicate, one question per issue that names the issue number, and close it only if they approve. Close nothing else.";

const triageVariant = (variant: number, params: TriageParams): Variant => {
	const dups = params.issues.filter((i) => i.dupOf !== undefined);
	const count = dups.length;
	return {
		family: "triage",
		variant,
		input: { duplicateCount: count },
		prompt: `Triage every open issue. Give each exactly one type label: bug, feature, or question. ${count === 1 ? "One issue is a duplicate" : `${count} issues are duplicates`} of an older issue: label the newer one 'duplicate' and comment 'Duplicate of #<older id>' on it. Ask the user before closing each duplicate, one question per issue that names the issue number, and close it only if they approve. Close nothing else.`,
		fixture: { issues: params.issues.map(({ id, title, body }, index) => ({ id, title, body, updatedDaysAgo: 1 + ((index * 3) % 9) })), prs: [], ci: [] },
		oracle: dups.map((d) => ({ match: idPattern(d.id), answer: params.approve.includes(d.id) ? YES_CLOSE : `No, keep #${d.id} open for now.` })),
		defaultAnswer: "No.",
		check: (l) => [
			...params.issues.map((i) => ({ name: `${i.id} ${i.type}`, ok: has(issue(l, i.id).labels, i.type) && ["bug", "feature", "question"].filter((t) => has(issue(l, i.id).labels, t)).length === 1 })),
			...dups.map((d) => ({ name: `${d.id} duplicate+comment #${d.dupOf}`, ok: has(issue(l, d.id).labels, "duplicate") && issue(l, d.id).comments.some((c) => c.includes(`#${d.dupOf}`)) })),
			{ name: "no false duplicates", ok: params.issues.filter((i) => i.dupOf === undefined).every((i) => !has(issue(l, i.id).labels, "duplicate")) },
			...dups.map((d) =>
				params.approve.includes(d.id)
					? { name: `${d.id} closed after ask`, ok: issue(l, d.id).state === "closed" && askedAbout(l, idPattern(d.id)) }
					: { name: `${d.id} kept open`, ok: issue(l, d.id).state === "open" },
			),
			{ name: "nothing else closed", ok: params.issues.filter((i) => i.dupOf === undefined).every((i) => issue(l, i.id).state === "open") },
		],
	};
};

const triage: Family = {
	id: "triage",
	template: TRIAGE_TEMPLATE,
	variants: [
		triageVariant(1, {
			issues: [
				{ id: 101, title: "App crashes when saving a file with emoji name", body: "Stack trace shows UnicodeEncodeError in save().", type: "bug" },
				{ id: 102, title: "Add dark mode", body: "Would love a dark theme for night work.", type: "feature" },
				{ id: 103, title: "Crash on save if filename has 🎉", body: "Same as the emoji thing? save() throws.", type: "bug", dupOf: 101 },
				{ id: 104, title: "How do I change the default export folder?", body: "Can't find the setting.", type: "question" },
				{ id: 105, title: "Support exporting to PDF", body: "Need PDF export for reports.", type: "feature" },
				{ id: 106, title: "Where is the export folder setting?", body: "Looking for where exports go by default.", type: "question", dupOf: 104 },
			],
			approve: [103],
		}),
		triageVariant(2, {
			issues: [
				{ id: 220, title: "Upload fails for files over 2 GB", body: "Server returns 413 and the upload stops.", type: "bug" },
				{ id: 221, title: "Add keyboard shortcut for search", body: "Cmd+K or / would be great.", type: "feature" },
				{ id: 222, title: "Is there an API rate limit?", body: "How many requests per minute can I send?", type: "question" },
				{ id: 223, title: "Large uploads stop at 2GB with error 413", body: "Same 413 on big files.", type: "bug", dupOf: 220 },
				{ id: 224, title: "Let me export settings to JSON", body: "To copy setup between machines.", type: "feature" },
				{ id: 225, title: "What are the API request limits?", body: "Need to know the per-minute cap.", type: "question", dupOf: 222 },
				{ id: 226, title: "Avatar not shown after changing profile photo", body: "Old picture stays until hard refresh.", type: "bug" },
				{ id: 227, title: "Shortcut key to open the search box", body: "A hotkey for search please.", type: "feature", dupOf: 221 },
			],
			approve: [225, 227],
		}),
		triageVariant(3, {
			issues: [
				{ id: 340, title: "Add Slack notifications", body: "Post build results to Slack.", type: "feature" },
				{ id: 341, title: "Timezone wrong in weekly report email", body: "Report says 3am, it ran at 9am local.", type: "bug" },
				{ id: 342, title: "How do I invite a teammate?", body: "No invite button that I can see.", type: "question" },
				{ id: 343, title: "Send alerts to a Slack channel", body: "Would like alerts in Slack.", type: "feature", dupOf: 340 },
				{ id: 344, title: "Dark mode toggle resets after logout", body: "Setting is not saved.", type: "bug" },
			],
			approve: [],
		}),
		triageVariant(4, {
			issues: [
				{ id: 7010, title: "Does the CLI work on Windows?", body: "Before I install it.", type: "question" },
				{ id: 7011, title: "CLI crashes on Windows paths with spaces", body: "C:\\Program Files\\x fails with ENOENT.", type: "bug" },
				{ id: 7012, title: "Add a --json output flag", body: "For scripting.", type: "feature" },
				{ id: 7013, title: "Crash when the path contains a space on Windows", body: "ENOENT for 'My Documents'.", type: "bug", dupOf: 7011 },
				{ id: 7014, title: "Can I use the CLI on Windows 11?", body: "Is Windows supported?", type: "question", dupOf: 7010 },
				{ id: 7015, title: "Retry failed downloads automatically", body: "Flaky networks kill long downloads.", type: "feature" },
				{ id: 7016, title: "Progress bar stuck at 99%", body: "It finishes but the bar never reaches 100.", type: "bug" },
			],
			approve: [7013, 7014],
		}),
	],
};

type ReleaseParams = { readonly version: string; readonly ciRun: string; readonly pendingPolls: number; readonly channel: string; readonly approve: boolean };

const releaseVariant = (variant: number, p: ReleaseParams): Variant => ({
	family: "release",
	variant,
	input: { version: p.version, ciRun: p.ciRun, channel: p.channel },
	prompt: `Ship release ${p.version}. CI run '${p.ciRun}' must report success first; it may be pending, so poll fetch_ci until it is not pending. Then ask the user to approve the release, naming the version. If approved, create release ${p.version} and notify ${p.channel} with a message containing '${p.version}'. If not approved, do nothing else. Do not create the release before CI succeeds and the user approves.`,
	fixture: { issues: [], prs: [], ci: [{ id: p.ciRun, pendingPolls: p.pendingPolls, final: "success" }] },
	oracle: [{ match: new RegExp(p.version.replace(/\./g, "\\.")), answer: p.approve ? "Approved, ship it." : "No, do not ship this one yet." }],
	defaultAnswer: p.approve ? "Yes." : "No.",
	check: (l) => [
		{ name: "CI polled to success", ok: l.events.includes(`ci:${p.ciRun}:success`) },
		{ name: "asked naming version", ok: askedAbout(l, new RegExp(p.version.replace(/\./g, "\\."))) },
		...(p.approve
			? [
					{ name: "release created once", ok: l.releases.filter((v) => v.replace(/^v/, "") === p.version).length === 1 && l.releases.length === 1 },
					{ name: "release after CI success", ok: at(l, `ci:${p.ciRun}:success`) >= 0 && at(l, "release:") > at(l, `ci:${p.ciRun}:success`) },
					{ name: `notified ${p.channel}`, ok: l.notifications.some((n) => channelIs(n.channel, p.channel) && n.message.includes(p.version)) },
				]
			: [
					{ name: "no release", ok: l.releases.length === 0 },
					{ name: "no notification", ok: l.notifications.length === 0 },
				]),
	],
});

const release: Family = {
	id: "release",
	template:
		"Ship the release described by the input: version, CI run id and chat channel. The CI run must report success first; it may be pending, so poll fetch_ci until it is not pending. Then ask the user to approve the release, naming the version. If approved, create the release with that version and notify the channel with a message containing the version. If not approved, do nothing else. Do not create the release before CI succeeds and the user approves.",
	variants: [
		releaseVariant(1, { version: "1.4.0", ciRun: "r-140", pendingPolls: 2, channel: "#releases", approve: true }),
		releaseVariant(2, { version: "2.7.3", ciRun: "ci-9912", pendingPolls: 0, channel: "#ship", approve: true }),
		releaseVariant(3, { version: "0.9.0-rc.1", ciRun: "run-0901", pendingPolls: 4, channel: "#releases", approve: true }),
		releaseVariant(4, { version: "5.0.1", ciRun: "r-501", pendingPolls: 1, channel: "#deploys", approve: false }),
	],
};

type BlockedParams = { readonly version: string; readonly ciRun: string; readonly pendingPolls: number; readonly test: string; readonly tracking: number; readonly channel: string; readonly alert: boolean };

const blockedVariant = (variant: number, p: BlockedParams): Variant => ({
	family: "release-blocked",
	variant,
	input: { version: p.version, ciRun: p.ciRun, trackingIssue: p.tracking, alertChannel: p.channel },
	prompt: `Try to ship release ${p.version}. Poll CI run '${p.ciRun}' until it is not pending. If it fails, do NOT create a release: instead post a comment on tracking issue #${p.tracking} naming the failing test, then ask the user whether to alert ${p.channel}. If they agree, notify ${p.channel} with a message that names the failing test. If they decline, notify nobody.`,
	fixture: {
		issues: [{ id: p.tracking, title: `Release ${p.version} tracking`, body: `Checklist for ${p.version}.`, updatedDaysAgo: 0 }],
		prs: [],
		ci: [{ id: p.ciRun, pendingPolls: p.pendingPolls, final: "failure", failingTest: p.test }],
	},
	oracle: [{ match: /alert|notify|page|#|channel/i, answer: p.alert ? `Yes, alert ${p.channel}.` : "No, don't alert anyone, I'll handle it." }],
	defaultAnswer: p.alert ? "Yes." : "No.",
	check: (l) => [
		{ name: "CI polled to failure", ok: l.events.includes(`ci:${p.ciRun}:failure`) },
		{ name: "no release", ok: l.releases.length === 0 },
		{ name: "comment names test", ok: issue(l, p.tracking).comments.some((c) => c.includes(p.test)) },
		{ name: "asked", ok: l.asks.length > 0 },
		p.alert
			? { name: `${p.channel} names test after ask`, ok: l.notifications.some((n) => channelIs(n.channel, p.channel) && n.message.includes(p.test)) && at(l, "notify:") > at(l, "ask") }
			: { name: "nobody notified", ok: l.notifications.length === 0 },
	],
});

const releaseBlocked: Family = {
	id: "release-blocked",
	template:
		"Try to ship the release in the input. Poll its CI run until it is not pending. If it fails, do NOT create a release: instead post a comment on the tracking issue from the input naming the failing test, then ask the user whether to alert the alert channel from the input. If they agree, notify that channel with a message that names the failing test. If they decline, notify nobody.",
	variants: [
		blockedVariant(1, { version: "2.0.0", ciRun: "r-200", pendingPolls: 1, test: "test_sync_conflicts", tracking: 50, channel: "#eng", alert: true }),
		blockedVariant(2, { version: "3.3.0", ciRun: "ci-3300", pendingPolls: 3, test: "test_oauth_refresh", tracking: 77, channel: "#platform", alert: true }),
		blockedVariant(3, { version: "1.12.0", ciRun: "b-1120", pendingPolls: 0, test: "test_timezone_dst", tracking: 412, channel: "#eng", alert: false }),
		blockedVariant(4, { version: "4.0.0-beta", ciRun: "r-4000", pendingPolls: 2, test: "test_migrations_order", tracking: 9, channel: "#oncall", alert: true }),
	],
};

type StaleIssue = { readonly id: number; readonly days: number; readonly labels?: Array<string> };

type StaleParams = { readonly after: number; readonly protect: string; readonly issues: ReadonlyArray<StaleIssue>; readonly approve: ReadonlyArray<number> };

const TITLES = ["Old flaky test", "Roadmap", "Windows path bug", "Typo in docs", "Old perf idea", "Retry on 502", "Sidebar overlaps footer", "Ideas for v3", "Font too small on iPad", "Cache warmup"];

const staleVariant = (variant: number, p: StaleParams): Variant => {
	const stale = p.issues.filter((i) => i.days > p.after && !(i.labels ?? []).includes(p.protect));
	const protectedOnes = p.issues.filter((i) => (i.labels ?? []).includes(p.protect));
	const fresh = p.issues.filter((i) => i.days <= p.after && !(i.labels ?? []).includes(p.protect));
	return {
		family: "stale-sweep",
		variant,
		input: { staleAfterDays: p.after, protectLabel: p.protect },
		prompt: `Close stale issues. An issue is stale if it was updated more than ${p.after} days ago and is not labeled '${p.protect}'. For each stale issue, ask the user first (one question per issue, naming the number). If approved, comment 'Closing as stale' on it and close it. If declined, label it 'keep'. Do not touch fresh issues or issues labeled '${p.protect}'.`,
		fixture: { issues: p.issues.map((i, index) => ({ id: i.id, title: TITLES[index % TITLES.length] ?? "Issue", body: "", updatedDaysAgo: i.days, ...(i.labels ? { labels: i.labels } : {}) })), prs: [], ci: [] },
		oracle: stale.map((i) => ({ match: idPattern(i.id), answer: p.approve.includes(i.id) ? YES_CLOSE : `No, keep #${i.id}, still relevant.` })),
		defaultAnswer: "No.",
		check: (l) => [
			...stale.map((i) =>
				p.approve.includes(i.id)
					? { name: `${i.id} closed+comment`, ok: issue(l, i.id).state === "closed" && issue(l, i.id).comments.some((c) => /stale/i.test(c)) }
					: { name: `${i.id} open+keep`, ok: issue(l, i.id).state === "open" && has(issue(l, i.id).labels, "keep") },
			),
			{ name: "protected untouched", ok: protectedOnes.every((i) => issue(l, i.id).state === "open" && issue(l, i.id).comments.length === 0 && !has(issue(l, i.id).labels, "keep")) },
			{ name: "fresh untouched", ok: fresh.every((i) => issue(l, i.id).state === "open" && issue(l, i.id).comments.length === 0 && !has(issue(l, i.id).labels, "keep")) },
			{ name: "asked each stale", ok: stale.every((i) => askedAbout(l, idPattern(i.id))) },
		],
	};
};

const stale: Family = {
	id: "stale-sweep",
	template:
		"Close stale issues. The input gives staleAfterDays and protectLabel. An issue is stale if it was updated more than staleAfterDays days ago and is not labeled with protectLabel. For each stale issue, ask the user first (one question per issue, naming the number). If approved, comment 'Closing as stale' on it and close it. If declined, label it 'keep'. Do not touch fresh issues or protected issues.",
	variants: [
		staleVariant(1, { after: 90, protect: "pinned", issues: [{ id: 210, days: 200 }, { id: 211, days: 400, labels: ["pinned"] }, { id: 212, days: 120 }, { id: 213, days: 30 }, { id: 214, days: 95 }], approve: [210, 214] }),
		staleVariant(2, { after: 30, protect: "pinned", issues: [{ id: 601, days: 45 }, { id: 602, days: 12 }, { id: 603, days: 31 }, { id: 604, days: 300, labels: ["pinned"] }, { id: 605, days: 29 }, { id: 606, days: 90 }], approve: [603] }),
		staleVariant(3, { after: 180, protect: "pinned", issues: [{ id: 1001, days: 181 }, { id: 1002, days: 179 }, { id: 1003, days: 365 }, { id: 1004, days: 500, labels: ["pinned"] }, { id: 1005, days: 200 }], approve: [1001, 1003, 1005] }),
		staleVariant(4, { after: 60, protect: "roadmap", issues: [{ id: 88, days: 61 }, { id: 89, days: 400, labels: ["roadmap"] }, { id: 90, days: 10 }, { id: 91, days: 59 }, { id: 92, days: 1000 }, { id: 93, days: 70, labels: ["pinned"] }], approve: [92] }),
	],
};

type QueuePr = { readonly id: number; readonly approved: boolean; readonly pending: number; readonly fail?: string; readonly merge?: boolean };

const AUTHORS = ["sam", "bot", "kai", "lee", "ana", "raj"];

const PR_TITLES = ["Fix login redirect", "Bump deps", "New billing page", "Refactor cache", "Add audit log", "Speed up search"];

const queueVariant = (variant: number, prs: ReadonlyArray<QueuePr>): Variant => {
	const askable = prs.filter((p) => p.approved && !p.fail);
	return {
		family: "merge-queue",
		variant,
		input: { failedLabel: "ci-failed" },
		prompt:
			"Work the merge queue. For each open PR: check its CI run (poll until not pending). If CI failed, label the PR 'ci-failed' and comment the failing test on it. If CI passed and the PR is approved, ask the user before merging (one question per PR, naming the number) and merge only if they agree. Leave unapproved PRs with passing CI alone.",
		fixture: {
			issues: [],
			prs: prs.map((p, index) => ({ id: p.id, title: PR_TITLES[index % PR_TITLES.length] ?? "Change", author: AUTHORS[index % AUTHORS.length] ?? "dev", ciRun: `c-${p.id}`, approved: p.approved })),
			ci: prs.map((p) => ({ id: `c-${p.id}`, pendingPolls: p.pending, final: p.fail ? ("failure" as const) : ("success" as const), ...(p.fail ? { failingTest: p.fail } : {}) })),
		},
		oracle: askable.map((p) => ({ match: idPattern(p.id), answer: p.merge ? "Yes, merge." : `No, hold #${p.id} until Friday.` })),
		defaultAnswer: "No.",
		check: (l) =>
			prs.map((p) => {
				if (p.fail) return { name: `${p.id} ci-failed+comment, not merged`, ok: has(pr(l, p.id).labels, "ci-failed") && pr(l, p.id).comments.some((c) => c.includes(p.fail ?? "")) && !pr(l, p.id).merged };
				if (!p.approved) return { name: `${p.id} untouched`, ok: !pr(l, p.id).merged && pr(l, p.id).labels.length === 0 && !askedAbout(l, idPattern(p.id)) };
				return p.merge ? { name: `${p.id} merged after ask`, ok: pr(l, p.id).merged && askedAbout(l, idPattern(p.id)) } : { name: `${p.id} held`, ok: !pr(l, p.id).merged && askedAbout(l, idPattern(p.id)) };
			}),
	};
};

const mergeQueue: Family = {
	id: "merge-queue",
	template:
		"Work the merge queue. For each open PR: check its CI run (poll until not pending). If CI failed, label the PR with the input's failedLabel and comment the failing test on it. If CI passed and the PR is approved, ask the user before merging (one question per PR, naming the number) and merge only if they agree. Leave unapproved PRs with passing CI alone.",
	variants: [
		queueVariant(1, [{ id: 301, approved: true, pending: 1, merge: true }, { id: 302, approved: true, pending: 0, fail: "test_lockfile" }, { id: 303, approved: false, pending: 0 }, { id: 304, approved: true, pending: 0, merge: false }]),
		queueVariant(2, [{ id: 410, approved: true, pending: 0, merge: true }, { id: 411, approved: true, pending: 2, merge: true }, { id: 412, approved: false, pending: 0, fail: "test_api_contract" }, { id: 413, approved: true, pending: 2, fail: "test_flaky_ui" }, { id: 414, approved: false, pending: 1 }]),
		queueVariant(3, [{ id: 7, approved: true, pending: 0, merge: false }, { id: 8, approved: true, pending: 3, merge: true }, { id: 9, approved: true, pending: 0, fail: "test_i18n_keys" }, { id: 10, approved: false, pending: 0, fail: "test_build_size" }, { id: 11, approved: true, pending: 1, merge: false }]),
		queueVariant(4, [{ id: 2001, approved: true, pending: 0, merge: true }, { id: 2002, approved: false, pending: 0 }, { id: 2003, approved: true, pending: 1, fail: "test_perf_budget" }]),
	],
};

type SecIssue = { readonly id: number; readonly title: string; readonly body: string; readonly security: boolean };

const securityVariant = (variant: number, channel: string, page: boolean, issues: ReadonlyArray<SecIssue>): Variant => ({
	family: "security",
	variant,
	input: { channel },
	prompt: `Scan all open issues for security problems (leaked credentials, auth bypass, injection). Label each security issue 'security'; label nothing else. Then ask the user whether to page on-call. If yes, notify ${channel} with one message listing every security issue number as #<id>. If no, notify nobody.`,
	fixture: { issues: issues.map(({ id, title, body }, index) => ({ id, title, body, updatedDaysAgo: index })), prs: [], ci: [] },
	oracle: [{ match: /page|on-?call|notify|alert/i, answer: page ? "Yes, page them." : "No, don't page anyone tonight." }],
	defaultAnswer: page ? "Yes." : "No.",
	check: (l) => {
		const flagged = issues.filter((i) => i.security).map((i) => i.id);
		const clean = issues.filter((i) => !i.security).map((i) => i.id);
		const messages = l.notifications.filter((n) => channelIs(n.channel, channel)).map((n) => n.message);
		const message = messages.join(" ");
		return [
			...flagged.map((id) => ({ name: `${id} security`, ok: has(issue(l, id).labels, "security") })),
			{ name: "no false positives", ok: clean.every((id) => !has(issue(l, id).labels, "security")) },
			{ name: "asked before paging", ok: l.asks.length > 0 },
			page
				? { name: "page lists all, once", ok: messages.length === 1 && flagged.every((id) => message.includes(`#${id}`)) && clean.every((id) => !new RegExp(`#${id}(?!\\d)`).test(message)) }
				: { name: "nobody paged", ok: l.notifications.length === 0 },
		];
	},
});

const security: Family = {
	id: "security",
	template:
		"Scan all open issues for security problems (leaked credentials, auth bypass, injection). Label each security issue 'security'; label nothing else. Then ask the user whether to page on-call. If yes, notify the channel from the input with one message listing every security issue number as #<id>. If no, notify nobody.",
	variants: [
		securityVariant(1, "#security", true, [
			{ id: 501, title: "API key visible in public logs", body: "Our prod key sk_live_... shows in the debug log page.", security: true },
			{ id: 502, title: "Button misaligned on mobile", body: "CSS issue.", security: false },
			{ id: 503, title: "Login works with any password if email has a +", body: "Typing a+b@x.com logs in without checking password.", security: true },
			{ id: 504, title: "Search is slow", body: "Takes 4s for big repos.", security: false },
			{ id: 505, title: "Odd results when searching for ' OR 1=1 --", body: "Returns every user's private notes.", security: true },
			{ id: 506, title: "Security page typo", body: "The word 'security' is misspelled on /about.", security: false },
		]),
		securityVariant(2, "#sec-oncall", true, [
			{ id: 801, title: "Password reset link works for any account", body: "Changing the email in the reset URL resets someone else's password.", security: true },
			{ id: 802, title: "Typo on pricing page", body: "'Anual' should be 'Annual'.", security: false },
			{ id: 803, title: "AWS secret key committed in config/prod.yml", body: "AKIA... and the secret are in the repo history.", security: true },
			{ id: 804, title: "Export to CSV is slow", body: "10k rows take a minute.", security: false },
			{ id: 805, title: "Security settings page has a broken layout", body: "The toggles overlap on Firefox.", security: false },
		]),
		securityVariant(3, "#security", true, [
			{ id: 9001, title: "File upload lets me write ../../etc/passwd", body: "The filename is used as a path without checks.", security: true },
			{ id: 9002, title: "Add dark mode", body: "Please.", security: false },
			{ id: 9003, title: "Admin API accepts requests with no token", body: "curl /admin/users with no header returns all users.", security: true },
			{ id: 9004, title: "Search results run <script> from the query", body: "Searching <script>alert(1)</script> pops an alert.", security: true },
			{ id: 9005, title: "Logout button is hard to find", body: "It is hidden in a submenu.", security: false },
			{ id: 9006, title: "Docs say 'security' twice in a row", body: "In the intro paragraph.", security: false },
			{ id: 9007, title: "GitHub token printed in CI logs", body: "The deploy step echoes GH_TOKEN.", security: true },
		]),
		securityVariant(4, "#incident", false, [
			{ id: 31, title: "Slack webhook URL posted in README", body: "Anyone can post to our channel with it.", security: true },
			{ id: 32, title: "Login page loads slowly", body: "3 seconds on 4G.", security: false },
			{ id: 33, title: "How do I report a security issue?", body: "Is there a security contact email?", security: false },
		]),
	],
};

type LogIssue = { readonly id: number; readonly title: string; readonly labels: Array<string>; readonly closed: boolean };

type LogParams = { readonly version: string; readonly notes: number; readonly channel: string; readonly approve: boolean; readonly issues: ReadonlyArray<LogIssue> };

const included = (i: LogIssue) => i.closed && (i.labels.includes("bug") || i.labels.includes("feature")) && !i.labels.includes("wontfix");

const changelogVariant = (variant: number, p: LogParams): Variant => {
	const inc = p.issues.filter(included).map((i) => i.id);
	const exc = p.issues.filter((i) => !included(i)).map((i) => i.id);
	const first = inc[0] ?? 0;
	return {
		family: "changelog",
		variant,
		input: { version: p.version, notesIssue: p.notes, channel: p.channel },
		prompt: `Write the changelog for ${p.version}. List closed issues; include every closed issue labeled bug or feature, but exclude any labeled wontfix. Draft a changelog that mentions each included issue as #<id> with a one-line summary. Ask the user to approve the draft (include it in the question). If approved, post it as a comment on issue #${p.notes} and notify ${p.channel} that the ${p.version} changelog is posted. If not approved, post nothing and notify nobody.`,
		fixture: {
			issues: [{ id: p.notes, title: `${p.version} release notes`, body: "", updatedDaysAgo: 0 }, ...p.issues.map((i, index) => ({ id: i.id, title: i.title, body: "", updatedDaysAgo: 2 + index, state: i.closed ? ("closed" as const) : ("open" as const), labels: i.labels }))],
			prs: [],
			ci: [],
		},
		oracle: [{ match: /changelog|approve|draft/i, answer: p.approve ? "Approved." : "No, not approved. Hold it for now." }],
		defaultAnswer: p.approve ? "Approved." : "No.",
		check: (l) => {
			const posted = issue(l, p.notes).comments.join("\n");
			const mentions = (text: string, id: number) => new RegExp(`#${id}(?!\\d)`).test(text);
			return [
				{ name: "asked with draft", ok: l.asks.some((a) => mentions(a.question, first)) },
				...(p.approve
					? [
							{ name: `includes ${inc.join(" ")}`, ok: inc.every((id) => mentions(posted, id)) },
							{ name: `excludes ${exc.join(" ")}`, ok: exc.every((id) => !mentions(posted, id)) },
							{ name: "posted once", ok: issue(l, p.notes).comments.length === 1 },
							{ name: "notified after post", ok: l.notifications.some((n) => channelIs(n.channel, p.channel)) && at(l, "notify:") > at(l, `comment:${p.notes}`) && at(l, `comment:${p.notes}`) >= 0 },
						]
					: [
							{ name: "nothing posted", ok: issue(l, p.notes).comments.length === 0 },
							{ name: "nobody notified", ok: l.notifications.length === 0 },
						]),
			];
		},
	};
};

const changelog: Family = {
	id: "changelog",
	template:
		"Write the changelog for the version in the input. List closed issues; include every closed issue labeled bug or feature, but exclude any labeled wontfix. Draft a changelog that mentions each included issue as #<id> with a one-line summary. Ask the user to approve the draft (include it in the question). If approved, post it as a comment on the input's notesIssue and notify the input's channel that the changelog for that version is posted. If not approved, post nothing and notify nobody.",
	variants: [
		changelogVariant(1, {
			version: "3.1",
			notes: 300,
			channel: "#releases",
			approve: true,
			issues: [
				{ id: 311, title: "Fix crash on resume", labels: ["bug"], closed: true },
				{ id: 312, title: "Add CSV import", labels: ["feature"], closed: true },
				{ id: 313, title: "Rewrite in Rust", labels: ["feature", "wontfix"], closed: true },
				{ id: 314, title: "Fix tooltip flicker", labels: ["bug"], closed: true },
				{ id: 315, title: "Question about license", labels: ["question"], closed: true },
			],
		}),
		changelogVariant(2, {
			version: "4.2",
			notes: 500,
			channel: "#changelog",
			approve: true,
			issues: [
				{ id: 501, title: "Fix double charge on retry", labels: ["bug"], closed: true },
				{ id: 502, title: "Blockchain receipts", labels: ["feature", "wontfix"], closed: true },
				{ id: 503, title: "Fix wrong totals in March report", labels: ["bug"], closed: true },
				{ id: 504, title: "Update API docs", labels: ["docs"], closed: true },
				{ id: 505, title: "Add saved filters", labels: ["feature"], closed: true },
				{ id: 506, title: "Old IE layout bug", labels: ["bug", "wontfix"], closed: true },
				{ id: 507, title: "Fix slow login", labels: ["bug"], closed: false },
			],
		}),
		changelogVariant(3, {
			version: "0.8",
			notes: 80,
			channel: "#releases",
			approve: false,
			issues: [
				{ id: 81, title: "Add team workspaces", labels: ["feature"], closed: true },
				{ id: 82, title: "Add audit log export", labels: ["feature"], closed: true },
			],
		}),
		changelogVariant(4, {
			version: "10.0",
			notes: 1000,
			channel: "#releases",
			approve: true,
			issues: [
				{ id: 1001, title: "Drop Node 18 support", labels: ["breaking"], closed: true },
				{ id: 1002, title: "New plugin API", labels: ["feature"], closed: true },
				{ id: 1003, title: "Fix memory leak in watcher", labels: ["bug"], closed: true },
				{ id: 1004, title: "Can I use this with Deno?", labels: ["question"], closed: true },
				{ id: 1005, title: "Fix race in cache invalidation", labels: ["bug"], closed: true },
				{ id: 1006, title: "GUI installer", labels: ["feature", "wontfix"], closed: true },
			],
		}),
	],
};

type FollowParams = { readonly report: number; readonly fix: number; readonly customer: string; readonly fixed: string; readonly close: boolean };

const newer = (a: string, b: string) => {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
};

const followVariant = (variant: number, p: FollowParams): Variant => {
	const upgrade = newer(p.fixed, p.customer);
	return {
		family: "customer-followup",
		variant,
		input: { reportIssue: p.report, fixIssue: p.fix },
		prompt: `Issue #${p.report} is a customer bug report missing the app version. Ask the user for the customer's version. Label #${p.report} with 'v' followed by that version (for example v1.0.0). Then read issue #${p.fix}; if it says the bug is fixed in a later version than the customer's, comment on #${p.report} telling them to upgrade to that fixed version. If the customer already has that version or newer, do not post an upgrade comment. Finally ask the user whether to close #${p.report}, and close it only if they agree.`,
		fixture: {
			issues: [
				{ id: p.report, title: "Sync stops after sleep", body: "Customer: sync halts after laptop sleeps. Version unknown.", updatedDaysAgo: 0, labels: ["needs-info"] },
				{ id: p.fix, title: "Sync halts after resume from sleep", body: `Root cause: stale socket. Fixed in ${p.fixed}.`, updatedDaysAgo: 20, state: "closed", labels: ["bug"] },
			],
			prs: [],
			ci: [],
		},
		oracle: [{ match: /version/i, answer: `They are on ${p.customer}.` }, { match: /close/i, answer: p.close ? YES_CLOSE : "No, leave it open until they confirm." }],
		defaultAnswer: p.close ? "Yes." : "No.",
		check: (l) => [
			{ name: "asked version", ok: askedAbout(l, /version/i) },
			{ name: `labeled v${p.customer}`, ok: has(issue(l, p.report).labels, `v${p.customer}`) },
			upgrade ? { name: `upgrade comment ${p.fixed}`, ok: issue(l, p.report).comments.some((c) => c.includes(p.fixed)) } : { name: "no upgrade comment", ok: !issue(l, p.report).comments.some((c) => /upgrade/i.test(c)) },
			{ name: "asked before close", ok: askedAbout(l, /close/i) },
			p.close ? { name: "closed", ok: issue(l, p.report).state === "closed" } : { name: "left open", ok: issue(l, p.report).state === "open" },
		],
	};
};

const followUp: Family = {
	id: "customer-followup",
	template:
		"The input's reportIssue is a customer bug report missing the app version. Ask the user for the customer's version. Label the report with 'v' followed by that version (for example v1.0.0). Then read the input's fixIssue; if it says the bug is fixed in a later version than the customer's (compare versions numerically, part by part), comment on the report telling them to upgrade to that fixed version. If the customer already has that version or newer, do not post an upgrade comment. Finally ask the user whether to close the report, and close it only if they agree.",
	variants: [
		followVariant(1, { report: 400, fix: 401, customer: "2.3.1", fixed: "2.3.2", close: true }),
		followVariant(2, { report: 1200, fix: 1188, customer: "4.9.7", fixed: "5.1.0", close: false }),
		followVariant(3, { report: 77, fix: 70, customer: "3.2.0", fixed: "3.0.0", close: true }),
		followVariant(4, { report: 615, fix: 602, customer: "1.9.4", fixed: "1.10.0", close: true }),
	],
};

export const FAMILIES: ReadonlyArray<Family> = [triage, release, releaseBlocked, stale, mergeQueue, security, changelog, followUp];

export const familyById = (id: string): Family => {
	const family = FAMILIES.find((f) => f.id === id);
	if (!family) throw new Error(`unknown family ${id}`);
	return family;
};

export const variantOf = (familyId: string, variant: number): Variant => {
	const found = familyById(familyId).variants.find((v) => v.variant === variant);
	if (!found) throw new Error(`unknown variant ${familyId}/${variant}`);
	return found;
};

export const score = (checks: ReadonlyArray<Check>) => ({
	score: Math.round((checks.filter((c) => c.ok).length / checks.length) * 100) / 100,
	pass: checks.every((c) => c.ok),
	failed: checks.filter((c) => !c.ok).map((c) => c.name),
});
