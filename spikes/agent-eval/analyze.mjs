import { readFileSync } from "node:fs";

const FILE = new URL(process.env.IN ?? "./results.jsonl", import.meta.url);
const TAGS = (process.env.TAGS ?? "r1,r2").split(",");
const rows = readFileSync(FILE, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((row) => TAGS.some((tag) => row.runId.startsWith(`${tag}-`)));

const slot = (row) => row.runId.replace(/^[^-]+-/, "");
const tagRank = (row) => TAGS.findIndex((tag) => row.runId.startsWith(`${tag}-`));
const latest = new Map();
for (const row of rows) {
	const held = latest.get(slot(row));
	if (!held || tagRank(row) >= tagRank(held)) latest.set(slot(row), row);
}
const all = [...latest.values()];

const short = (model) => model.split("/").at(-1);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const usd = (x) => `$${x.toFixed(4)}`;
const f1 = (x) => x.toFixed(1);
const r0 = (x) => Math.round(x).toString();

const genCost = (row) => (row.usage?.generate?.usd ?? 0) + (row.usage?.repair?.usd ?? 0);
const runCost = (row) => row.usd - genCost(row);

const models = [...new Set(all.map((r) => r.model))];
const families = [...new Set(all.map((r) => r.family))];
const arms = ["loop", "fresh", "reuse"];

const summary = (list) => ({
	n: list.length,
	pass: list.filter((r) => r.pass).length,
	calls: mean(list.map((r) => r.llmCalls)),
	input: mean(list.map((r) => r.inputTokens)),
	output: mean(list.map((r) => r.outputTokens)),
	usd: mean(list.map((r) => r.usd)),
	wall: mean(list.map((r) => r.wallMs / 1000)),
	kills: sum(list.map((r) => r.killsInjected)),
	repeated: sum(list.map((r) => r.repeatedEffectsAfterKill)),
	keyed: sum(list.map((r) => r.keyedRetries ?? 0)),
	gens: sum(list.map((r) => (r.usage?.generate?.calls ?? 0))),
	repairs: sum(list.map((r) => (r.usage?.repair?.calls ?? 0))),
	llmSub: sum(list.map((r) => (r.usage?.llm?.calls ?? 0))),
});

const out = [];
const line = (text = "") => out.push(text);

line("## Overall, per arm and model (means per run)");
line();
line("| Model | Arm | n | Pass | LLM calls | In tok | Out tok | $/run | Wall s | Kills | Repeated effects after kill | Generations | Repairs |");
line("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const model of models)
	for (const arm of arms) {
		const s = summary(all.filter((r) => r.model === model && r.arm === arm));
		if (!s.n) continue;
		line(`| ${short(model)} | ${arm} | ${s.n} | ${s.pass}/${s.n} | ${f1(s.calls)} | ${r0(s.input)} | ${r0(s.output)} | ${usd(s.usd)} | ${r0(s.wall)} | ${s.kills} | ${s.repeated} | ${s.gens} | ${s.repairs} |`);
	}
line();
line("For reuse, $/run is already amortized: the one generation and any repairs are charged to the runs that made them, and the mean is over all 4 variants of each family.");
line();

line("## Per family (pass and $/run)");
line();
line("| Model | Family | loop pass | loop $/run | fresh pass | fresh $/run | reuse pass | reuse $/run (amortized) | reuse gen+repair $ | reuse run-only $/run |");
line("|---|---|---|---|---|---|---|---|---|---|");
const breakEvens = [];
for (const model of models)
	for (const family of families) {
		const pick = (arm) => all.filter((r) => r.model === model && r.family === family && r.arm === arm);
		const loop = summary(pick("loop"));
		const fresh = summary(pick("fresh"));
		const reuseRows = pick("reuse");
		const reuse = summary(reuseRows);
		const oneOff = sum(reuseRows.map(genCost));
		const perRun = mean(reuseRows.map(runCost));
		line(`| ${short(model)} | ${family} | ${loop.pass}/${loop.n} | ${usd(loop.usd)} | ${fresh.pass}/${fresh.n} | ${usd(fresh.usd)} | ${reuse.pass}/${reuse.n} | ${usd(reuse.usd)} | ${usd(oneOff)} | ${usd(perRun)} |`);
		breakEvens.push({ model, family, loop: loop.usd, oneOff, perRun, n: reuse.n });
	}
line();

line("## Break-even: reused runs needed before script-reuse costs less than the loop");
line();
line("Cost of N reuse runs = generation + repairs + N × run-only cost. Cost of N loop runs = N × loop $/run. Break-even N = generation+repairs ÷ (loop − run-only).");
line();
line("| Model | Family | loop $/run | gen+repair $ | reuse run-only $/run | break-even runs |");
line("|---|---|---|---|---|---|");
const be = (b) => (b.loop > b.perRun ? Math.ceil(b.oneOff / (b.loop - b.perRun)) : Infinity);
for (const b of breakEvens) line(`| ${short(b.model)} | ${b.family} | ${usd(b.loop)} | ${usd(b.oneOff)} | ${usd(b.perRun)} | ${be(b) === Infinity ? "never" : Math.max(1, be(b))} |`);
for (const model of models) {
	const mine = breakEvens.filter((b) => b.model === model);
	const loop = sum(mine.map((b) => b.loop));
	const oneOff = sum(mine.map((b) => b.oneOff));
	const perRun = sum(mine.map((b) => b.perRun));
	const n = loop > perRun ? Math.max(1, Math.ceil(oneOff / (loop - perRun))) : "never";
	line(`| **${short(model)}** | **suite (one run of every family)** | **${usd(loop)}** | **${usd(oneOff)}** | **${usd(perRun)}** | **${n}** |`);
}
line();

line("## Failures");
line();
for (const r of all.filter((x) => !x.pass)) line(`- \`${r.runId}\` (${r.outcome}): failed ${r.failedChecks.join(", ") || "-"}. ${r.notes.filter((n) => !/^program a0|runner restarted/.test(n)).join(" | ").slice(0, 400)}`);
line();

line("## Totals");
line();
line(`Runs: ${all.length}. Measured Workers AI spend for these rows: ${usd(sum(all.map((r) => r.usd)))}. AI retries (3021/3040/3046): ${sum(all.map((r) => r.aiRetries ?? 0))}. Runs that hit a busy claim on /run: ${all.filter((r) => r.claim === "busy").length}.`);

console.log(out.join("\n"));
