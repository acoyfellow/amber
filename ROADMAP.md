# amber roadmap

## The claim

**The model writes the program, and amber keeps that program alive.**

Other agent stacks keep the *transcript* alive and re-ask the model at every step (a tool-calling loop),
or keep a *workflow you wrote* alive and replay it (Temporal, Workflows, LangGraph). amber keeps a
*program the model wrote* alive: its stack, its loop counters and its variables, frozen in a few KB and
thawed on another machine days later. Nothing gets replayed or re-prompted.

A stored program is data, so pausing is only the first operation on it:

| Operation | What it means for agents | Status |
| --- | --- | --- |
| **suspend** | wait days on a human or a webhook | shipped, kill-fuzzed |
| **fork** | branch a running agent: search, A/B, evals from one state | shipped (host-level), F12 in-script |
| **inspect** | read a frozen agent's plan, frozen line and history, and gate its writes | shipped (F16), live variables not yet |
| **reuse** | run a plan the model already wrote on new inputs, with no generation | F9 |
| **migrate** | move a running agent between objects, regions or machines | implicit |

## Now

Working on, in this order: **F9 + F10** (plan reuse, finish Spike A: the cost gate), **F16** (inspect and
a gate before writes), and dogfooding amber inside my-ax `work_code`.

The pitch in one sketch. **This is the target API. Most of it does not exist yet; the feature IDs say
what each line needs.**

```ts
// the host: four tools over Cloudflare primitives
class Coder extends AmberAgent<Env> {
  tools = {
    sh:     write(Cmd,    (c) => this.box.exec(c)),               // F11  Container: a real shell + git
    llm:    read(Prompt,  (p) => this.model.small(p)),            // F7   judgment calls on a cheap model
    v8:     read(Module,  (m) => this.env.LOADER.load(m).run()),  // F8   hot code in a Dynamic Worker
    review: external(Diff, { timeoutMs: days(3) }),               //      a human, a PR review, a CI webhook
  };
}

// the program: written once by the model, kept alive by amber for three days
const tries = fork(3, (i) => {                                    // F12  3 minds × 3 filesystems
  tool("sh", { cmd: `git switch -c try-${i}` });
  tool("sh", { cmd: tool("llm", { prompt: `patch for ${issue}, attempt ${i}` }) });
  return tool("sh", { cmd: "npm test" }).exitCode;
});
const best = tries.indexOf(0);
if (best >= 0 && tool("review", { diff: diffOf(best) }))          // F11  the program AND the disk pause here
  tool("sh", { cmd: `gh pr create --head try-${best}` });
```

The sketch shows three things nobody else combines today:
1. **The plan is code, not a transcript.** It costs one model call to write, and the loops, branches and
   retries run for free.
2. **Pausing covers everything.** At `review`, amber snapshots the program heap and the Container
   snapshots the disk. Both resume together.
3. **Fork works on a running agent.** `fork(3)` clones the program's memory (amber), its workspace (a
   Container snapshot) and its object (Durable Object facets `clone`). That makes best-of-N a single
   line of code.

## What the evidence says (read this before defending it)

Spike A (`spike/agent-eval` in dquickts-worker, 37 of 48 planned runs, glm-5.3 on Workers AI):

- **Reliability is a tie.** Both harnesses passed 100% (20/20 loop, 17/17 script) and survived every kill.
- **The script used 87% fewer input tokens and 54% fewer LLM calls.**
- **But the script cost 47% more per run** ($0.0223 vs $0.0152). On judgment-heavy tasks (triage,
  security, changelog), the model wrote very long programs or called `tool("llm")` many times, and output
  tokens cost 3× input.
- **The script was cheaper only on mechanical tasks** (release, stale-sweep).

Spike A charged the script for writing a new program on every run. A loop pays for reasoning on every
step of every run; a program is reasoning written down once. F9 tests whether reuse flips the result.

So amber does not win yet on cost. The roadmap exists to fix that (F7–F10), and stage 0.0.3 has a gate
that can kill the broad claim.

## What the skeptic got right, and where it lands

| Objection | Status |
| --- | --- |
| Tool side effects need idempotency keys | **Shipped.** Every `write` gets `programId:step`, and delivery is documented as at-least-once |
| Partial failure mid-tool is ambiguous | **Shipped.** Snapshot before each write, recovery re-runs it with the same key. Kill fuzz: 1,044 crashes, 0 mismatches |
| Concurrency when two workers resume the same task | **Shipped.** Per-instance serialization, plus Durable Object single-threading |
| Answering the same approval twice | **Shipped.** `StaleToken`, `NotWaiting` |
| Schema migration as the workflow evolves | **Partial.** The engine hash is pinned and refuses loudly. Upgrade path: F3 |
| Cancellation, timeout, dead letter | **Partial.** Timeouts shipped. Cancel and dead letter: F2 |
| Observability for every state transition | **Missing.** F1 |
| Explain and audit why the model did what it did | **Missing.** F1 and F16, plus the source is the audit: the program the model wrote is stored |
| "Just use Temporal / a queue + DB" | **Correct for code you write.** The README already says so. amber is for code the model writes at runtime, which replay can't handle (`Math.random`, `Date.now`, drift) |

## Features

Each feature lists the work, why it matters, and a **done when** check that CI or a real deploy has to
show.

### 0.0.1: the pause primitive (shipped)
`read` / `write` / `external` tools with Schema-validated args, tokens, idempotency keys, alarm timeouts,
engine pinning, chunked snapshots, host-level fork, Agents SDK adapter, a 210-run kill fuzz, a workerd e2e
with SIGKILL, a reproducible engine build.

### 0.0.2: trust what it did
| ID | Feature | Why | Done when |
| --- | --- | --- | --- |
| F1 | **Journal:** an append-only log per program (step, tool, args hash, result size, duration, snapshot bytes, kills, recoveries) plus the program source. `script.history()` | observability and audit, the skeptic's top gap | e2e rebuilds the full timeline, including the SIGKILL, from storage alone |
| F2 | **`cancel(reason)` and dead letter:** `Cancelled` outcome; `Lost` / `EngineMismatch` go to an `onDeadLetter` hook instead of throwing into the caller | every long-running job needs a way to stop it | tests for cancel while waiting, while sliced, and mid-write recovery |
| F3 | **Engine upgrades:** `wasm: { current, previous: [...] }` picked by stored hash; programs drain on the old engine, new ones start on the new one | today an upgrade orphans every paused program | a test pauses on engine A, upgrades, finishes on A, starts the next on B |
| F4 | **Property-based model test** (fast-check `commands`: run/answer/kill/stale/fork/cancel/timeout against a ~40-line model) with shrinking; replaces the fixed-seed fuzz | finds and minimizes ordering bugs | in CI; seeded mutants in `script.ts` are caught |
| F5 | **`tools.declaration()`:** generate the TypeScript `declare function tool(...)` overloads from the Schemas, for the model's prompt | the spike's script failures were `TypeError: not a function`; give the model real types | the spike's failing task passes with declarations in the prompt |
| F16 ✅ | **Inspect and gate** (shipped; live variables need engine support and are not included): `script.inspect()` returns the program source, the line it is frozen on, the pending call and a bounded view of its live variables. A `gate(plan)` hook runs before every `write` and can allow, deny (thrown into the script as `Denied`) or hold for a human | review the plan, not the transcript: a frozen program is a checkable statement of what the agent is about to do | tests: a denied write never runs and the script sees `Denied`; a held write pauses like an `external` and survives kills; `inspect()` on a paused program shows the right line and variables |

### 0.0.3: close the cost gap (the spike says this is the real risk)
| ID | Feature | Why | Done when |
| --- | --- | --- | --- |
| F6 | **Budgets:** `budget: { steps, llmTokens, usd, wallMs }`, enforced at each tool call, failing with `BudgetExceeded` | runaway loops and cost control | tests per budget kind |
| F7 | **`llm` as a built-in tool with routing:** sub-calls go to a small, cheap model by default; usage is recorded in the journal | judgment sub-calls were the cost driver | the triage and security tasks cost less than the loop |
| F8 | **`v8` offload:** run pure hot functions in a Dynamic Worker (`env.LOADER`) and return the result | the interpreter is about 10× slower than V8 on CPU | the 3M-iteration loop benchmark comes within 2× of the plain-Durable-Object figure |
| F9 | **Program reuse:** store programs by hash with parameters; the model writes `triage(repo)` once and later runs skip generation | output tokens are the expensive part, and a reused program costs zero | a second run of the same task makes 0 generation calls |
| F10 | **Finish Spike A:** all 48 runs, plus at least one model with cheaper output tokens, plus a reuse arm (write once, run every seed) | the current verdict is partial | `RESULTS.md` is complete. **Gate below** |

**Gate after 0.0.3.** If the script still costs more than the loop on the full suite, amber stops
claiming to be a general agent harness. It becomes the pause primitive for codemode, the narrow and
proven use. 0.0.4 is built only if the gate passes, or if the coding-agent case below wins on its own
numbers.

### 0.0.4: the coding agent (the teaser, on new Cloudflare primitives)
| ID | Feature | Why | Done when |
| --- | --- | --- | --- |
| F11 | **Workspace tools over a Container:** `sh`, `read_file`, `apply_patch` via `Container.exec`. At each `external` pause, `snapshotContainer()` the disk and record its id next to the program snapshot, then restore both on resume and let the container sleep in between | the program and its filesystem pause and resume together, so a 3-day review costs nothing while it waits | e2e: edit files, pause, destroy the container, answer, and resume with the files intact |
| F12 | **`fork(n, fn)` inside the script:** an external call whose children are amber forks (heap), Container snapshots (disk) and facets `clone` (object), then join on results | best-of-N and search over a running agent | 3 branches, 1 passes tests, only its PR is opened, and the losers' writes are refused |
| F13 | **Answer sources:** adapters turn a GitHub review, a CI check or an email reply into `answer(token, value)`, with webhook signature checks | `ask_human` should be wherever the human already works | e2e with a signed fake webhook; unsigned or stale ones are refused |
| F14 | **Egress policy:** `interceptOutboundHttp` puts the container behind an allowlist, and the tools are the only other way out | the security story for model-written shell commands | a test where `curl` to an unlisted host fails and a listed one works |
| F15 | **Reference app: issue → PR.** The model writes the program, it forks 3 attempts, the tests pick one, a human reviews, and the PR opens, with kills injected throughout | the thousand-words demo, as an executable test | runs in CI against a fixture repo |

Note: Containers `exec` / `snapshotContainer`, Dynamic Worker Loader and Durable Object facets are in
`@cloudflare/workers-types` 5.20261023. Before F8, F11 and F12, check that each is available on the
target account, not just declared in the types.

### Later, only if pulled by users
- **Several pending externals at once** (ask two reviewers in parallel). The engine supports one pending
  call today.
- **`await` / `Promise.all` over tools in scripts.** Needs engine work.
- **Publish to npm.** Do it once the API stops moving.

## Not building
- **Multi-tenant scheduling, RBAC, quotas, rate limiting, a managed service.** Durable Objects, Access and
  Workers already provide these, and amber stays a library.
- **A planner/executor class hierarchy, a graph DSL, LangChain adapters.** The model writes the plan as
  code. That's the point.
- **"Exactly once."** amber never claims it.
