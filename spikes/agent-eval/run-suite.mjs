import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Agent, fetch } from "../../node_modules/undici/index.js";

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const OUT = new URL(process.env.OUT ?? "./results.jsonl", import.meta.url);
const PARALLEL = Number(process.env.PARALLEL ?? 2);
const TAG = process.env.TAG ?? "r1";
const FAMILIES = (process.env.FAMILIES ?? "triage,release,release-blocked,stale-sweep,merge-queue,security,changelog,customer-followup").split(",");
const MODELS = (process.env.MODELS ?? "@cf/zai-org/glm-5.3-flash,@cf/zai-org/glm-5.3").split(",");
const ARMS = (process.env.ARMS ?? "loop,fresh,reuse").split(",");
const VARIANTS = [1, 2, 3, 4];
const short = (model) => model.split("/").at(-1);

const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).runId) : []);

const runId = (model, family, arm, variant) => `${TAG}-${short(model)}-${family}-${arm}-v${variant}`;

const jobsFor = (model) =>
	FAMILIES.flatMap((family) =>
		ARMS.flatMap((arm) =>
			arm === "reuse"
				? [{ model, chain: VARIANTS.map((variant) => ({ model, family, arm, variant, runId: runId(model, family, arm, variant) })) }]
				: VARIANTS.map((variant) => ({ model, chain: [{ model, family, arm, variant, runId: runId(model, family, arm, variant) }] })),
		),
	);

const runOne = async ({ model, family, arm, variant, runId }) => {
	if (done.has(runId)) return true;
	const started = Date.now();
	try {
		const query = new URLSearchParams({ family, variant: String(variant), arm, model, seed: String(variant), runId });
		const response = await fetch(`${BASE}/run?${query}`, { dispatcher });
		const row = JSON.parse(await response.text());
		appendFileSync(OUT, `${JSON.stringify(row)}\n`);
		console.log(`${runId} ${row.outcome} pass=${row.pass} llm=${row.llmCalls} in=${row.inputTokens} out=${row.outputTokens} $${row.usd.toFixed(4)} ${Math.round(row.wallMs / 1000)}s kills=${row.killsInjected} rep=${row.repeatedEffectsAfterKill}${row.program ? ` prog=${row.program.hash}${row.program.reused ? " reused" : ""} a${row.program.attempt}` : ""}`);
		return row.outcome !== "budget-stop";
	} catch (error) {
		console.log(`${runId} ERROR ${String(error).slice(0, 200)} after ${Date.now() - started}ms`);
		return true;
	}
};

let stopped = false;
const pool = async (jobs) => {
	const workers = Array.from({ length: PARALLEL }, async () => {
		for (let job = jobs.shift(); job && !stopped; job = jobs.shift()) for (const run of job.chain) if (!(await runOne(run))) { stopped = true; console.log("BUDGET STOP"); break; }
	});
	await Promise.all(workers);
};

await Promise.all(MODELS.map((model) => pool(jobsFor(model))));
console.log("SUITE DONE");
