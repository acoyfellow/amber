import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const port = 8700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const persist = `${here}.wrangler/e2e-state`;

const SOURCE = `const runId = Math.random().toString(36).slice(2, 8);
const closed = [];
for (const issue of tool("list_issues", {})) {
  if (tool("ask_human", { question: "[" + runId + "] close #" + issue.id + "?" })) {
    tool("close_issue", { id: issue.id });
    closed.push(issue.id);
  }
}
({ runId, closed })`;

const start = () =>
	new Promise((resolve, reject) => {
		const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--log-level", "warn"], { cwd: here, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let log = "";
		const timer = setTimeout(() => reject(new Error(`wrangler did not start:\n${log}`)), 90_000);
		const poll = async () => {
			try {
				await fetch(`${base}/`);
				clearTimeout(timer);
				resolve(child);
			} catch {
				setTimeout(poll, 300);
			}
		};

		child.stdout.on("data", (chunk) => (log += chunk));
		child.stderr.on("data", (chunk) => (log += chunk));
		poll();
	});

const hardKill = (child) =>
	new Promise((resolve) => {
		child.once("exit", resolve);
		process.kill(-child.pid, "SIGKILL");
	});

const call = async (path, body) => {
	const response = await fetch(`${base}${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

	return response.json();
};

const check = (condition, message) => {
	if (!condition) throw new Error(`FAIL: ${message}`);
	console.log(`ok - ${message}`);
};

rmSync(persist, { recursive: true, force: true });

const id = `e2e-${Date.now()}`;
let server = await start();

try {
	let outcome = await call(`/p/${id}/run`, SOURCE);
	const questions = [];
	const answers = [true, false, true];
	let kills = 0;

	check(outcome._tag === "Waiting" && outcome.name === "ask_human", "run pauses at the first ask_human");

	for (const [index, answer] of answers.entries()) {
		questions.push(outcome.args.question);

		if (index === 1) {
			await hardKill(server);
			server = await start();
			console.log("ok - SIGKILLed workerd and restarted it on the same storage");
		} else {
			await call(`/p/${id}/kill`, "");
			kills++;
		}

		outcome = await call(`/p/${id}/answer`, { token: outcome.token, value: answer });
	}

	const runIds = new Set(questions.map((question) => question.slice(1, 7)));
	const closed = await call(`/p/${id}/closed`, "");

	check(outcome._tag === "Finished", `program finished: ${JSON.stringify(outcome)}`);
	check(JSON.stringify(outcome.result.closed) === "[41,43]", "closed exactly the approved issues");
	check(runIds.size === 1 && runIds.has(outcome.result.runId), "Math.random() runId stayed the same across every kill");
	check(closed.length === 2 && new Set(closed.map((entry) => entry.key)).size === 2, "each close_issue side effect was recorded once, with its own idempotency key");
	check(kills === 2, "ctx.abort() before two answers and a full SIGKILL before the third");

	const stale = await call(`/p/${id}/answer`, { token: "not-a-token", value: true });

	check(stale.error === "NotWaiting" || stale.error === "StaleToken", "answering a finished program is refused");
	console.log("e2e passed");
} finally {
	await hardKill(server);
}
