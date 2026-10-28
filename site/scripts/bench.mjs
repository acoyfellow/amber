const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const SYSTEMS = (process.env.SYSTEMS ?? "amber,workflows,agents,durable-object").split(",");

const SYSTEMS_ONLY = process.env.SYSTEMS !== undefined;

const show = (value) => (value === null || value === undefined ? "-" : String(value));

const rows = [];

for (const system of SYSTEMS) {
	const startedAt = Date.now();
	const response = await fetch(`${BASE}/api/bench/${system}`, { method: "POST" });
	const text = await response.text();

	if (!response.ok) {
		console.error(`${system}: HTTP ${response.status} ${text.slice(0, 500)}`);
		process.exitCode = 1;
		continue;
	}

	const { result, cached } = JSON.parse(text);
	const { approvals: a, loop: l } = result;

	console.error(`${system}: ${cached ? "cached" : "ran"} in ${Date.now() - startedAt} ms`);
	rows.push({
		system,
		correct: `${a.correct}/${l.correct}`,
		kills: a.killable ? a.kills : "n/a",
		"p50 ms": a.p50Ms,
		"p95 ms": a.p95Ms,
		"total ms": a.totalMs,
		"bytes/pause": show(a.bytesPerPause),
		objects: show(a.objects),
		"loop wall ms": l.wallMs,
		"loop cpu ms": show(l.cpuMs),
		slices: show(l.slices),
		ranAt: new Date(result.ranAt).toISOString(),
	});
}

console.table(rows);

if (!SYSTEMS_ONLY) {
	const response = await fetch(`${BASE}/api/bench/codemode`, { method: "POST" });
	const text = await response.text();

	if (!response.ok) {
		console.error(`codemode: HTTP ${response.status} ${text.slice(0, 500)}`);
		process.exitCode = 1;
	} else {
		const { result, cached } = JSON.parse(text);
		console.error(`codemode-pause: ${cached ? "cached" : "ran"}`);
		console.table(
			result.rows.map((row) => ({
				script: row.variant,
				system: row.system,
				outcome: row.outcome,
				completed: row.completed,
				consistent: row.consistent,
				"script runs": row.scriptRuns,
				replayed: row.replayedCalls,
				kills: row.kills,
				"p50 ms": show(row.p50Ms),
				"p95 ms": show(row.p95Ms),
				"bytes/pause": show(row.bytesPerPause),
				closed: row.closed.join(","),
			})),
		);
	}
}
