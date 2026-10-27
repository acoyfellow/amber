# amber

**Pause code your agent wrote.**

amber runs a script an LLM wrote at runtime inside a Cloudflare Durable Object. When the script calls
`tool("ask_human", …)`, amber freezes the whole program: call stack, loop counters, closures, objects.
It stores a few KB, and the object can be evicted, aborted or crash. When the answer arrives, maybe days
later on a different machine, `tool()` returns at the exact line it stopped on.

```js
// written by a model a moment ago, not by you
const runId = Math.random().toString(36).slice(2, 8);
const closed = [];
for (const issue of tool("list_issues", {})) {
  if (tool("ask_human", { question: `[${runId}] close #${issue.id}?` })) {   // waits hours, survives restarts
    tool("close_issue", { id: issue.id });
    closed.push(issue.id);
  }
}
({ runId, closed })
```

It's built on [dquickts](https://github.com/stencil-hq/dquickts), a QuickJS fork that can snapshot a
running program, compiled to WebAssembly.

> Status: experimental, 0.1. The API may change. Not published to npm yet; install from GitHub.

## Why not replay?

The usual way to pause code is **replay**: save each tool result, and on every answer re-run the
script from the top, feeding the saved results back in. That works when the code is deterministic and
you wrote it. Agent-written code often isn't: the script above calls `Math.random()`. On replay it gets
a different `runId`, so the human approved one run and a different run closed the issues. A replay
harness either refuses to resume or quietly does the wrong thing.

amber doesn't re-run anything. The program's memory *is* the checkpoint.

**Use something else when you write the code yourself.** For a hand-written approval flow, a plain
Durable Object, the [Agents SDK](https://developers.cloudflare.com/agents/) or
[Workflows](https://developers.cloudflare.com/workflows/) is simpler and faster. QuickJS is an
interpreter and much slower than V8 at heavy computation. amber is for the case where a model writes
the code and the code has to wait.

## Install

```sh
npm install github:acoyfellow/amber effect@4.0.0
```

The package ships TypeScript source, which Wrangler bundles directly. It depends on `effect` 4.0.0.

## Use it in a Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { DurableScript, durableObjectStorage, external, read, write } from "@acoyfellow/amber";
import wasm from "@acoyfellow/amber/dq.wasm";

export class Script extends DurableObject<Env> {
  script = new DurableScript({
    programId: this.ctx.id.toString(),
    storage: durableObjectStorage(this.ctx.storage),     // needs a SQLite-backed Durable Object
    wasm,
    tools: {
      list_issues: read(Schema.Struct({ repo: Schema.String }), ({ repo }) => github.list(repo)),
      close_issue: write(Schema.Struct({ id: Schema.Number }), ({ id }, { key }) => github.close(id, { idempotencyKey: key })),
      ask_human:   external(Schema.Struct({ question: Schema.String }), { timeoutMs: 7 * 86_400_000 }),
    },
  });

  run(source: string)                 { return this.script.run(source); }          // -> Outcome
  answer(token: string, value: unknown) { return this.script.answer(token, value); }
  override alarm()                    { return this.script.alarm(); }              // timeouts, long loops, crash recovery
}
```

```jsonc
// wrangler.jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Script"] }],
"rules": [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true }]
```

Every call returns an `Outcome`:

| `_tag` | Meaning |
| --- | --- |
| `Waiting` | Stopped at an external tool. Has `name`, `args`, `token`, `step`, `deadline`. Show it to a human, then call `answer(token, value)`. |
| `Running` | A long synchronous loop used its tick budget. An alarm continues it. |
| `Finished` | Has `result`, the script's last expression. |
| `Failed` | Has `error` and `message`: a script exception, `SnapshotTooLarge`, or `Lost`. |

A complete runnable Worker is in [`examples/approvals`](examples/approvals).

## Three kinds of tools

| Kind | Runs | Snapshot | On a crash |
| --- | --- | --- | --- |
| `read(schema, fn)` | inline, same request | none | the script re-runs from the last snapshot, so reads can repeat |
| `write(schema, fn)` | inline, same request | **before** it runs | it can run again. It receives `key` (`programId:step`), so deduplicate on that |
| `external(schema, { timeoutMs })` | not at all. The program pauses | yes | nothing is lost. A timeout throws `Timeout` into the script |

Arguments are validated with the tool's Schema before the tool runs. Bad arguments, unknown tools and
errors thrown by a tool all arrive in the script as ordinary catchable `Error`s (`InvalidArguments`,
`ToolNotFound`, …), so model-written code can handle them.

**Delivery is at least once, not exactly once.** A crash can land after a write tool did its work and
before amber recorded the result. That call then runs again with the same `key` and the same arguments.
After a crash the script continues from its last snapshot. Snapshots are taken at every `write` and
`external` call and at every loop slice, so the only work that can repeat is the script's own pure code
and its `read` calls since then. The script can't touch the outside world except through tools.

## More

- **Fork:** `script.exportSnapshot()` while waiting, then `DurableScript.fork(exported, { … })` gives an
  independent copy. Use it to try five answers from one decision point, for search or evals. Forks refuse
  `write` tools unless you pass `allowWrites: true`. Without `reseed`, every fork draws the same
  `Math.random()` sequence.
- **Agents SDK:** `attachScript(agent, { programId, tools, wasm })` stores the program in the agent's
  storage and uses `agent.schedule()` instead of the object's single alarm. Give the agent an
  `amberAlarm()` method that calls `script.alarm()` (or pass your own `callback` name).
- **Your own storage:** `DurableScript` takes any `ScriptStorage` (get, put, delete, keys, setAlarm,
  clearAlarm). `memoryStorage()` is included for tests.
- **Concurrency:** calls on one `DurableScript` instance are serialized. A stale or repeated `token` is
  refused with `StaleToken`, and answering a program that isn't waiting throws `NotWaiting`.

## What's verified

`npm run check` runs all of this, and CI runs it on every push.

- **16 semantics tests** (`test/semantics.test.ts`): each rule above, including timeouts, engine pinning,
  chunked snapshots, the snapshot cap and fork.
- **Kill fuzz** (`test/fuzz.test.ts`): 3 scripts (approvals, webhook with timeouts, a 1M-iteration loop) ×
  70 seeds, with crashes injected at every boundary and in the middle of tools. Each crashed run is compared
  with a clean run of the same seed. Last run: 210 runs, 1,044 crashes, 1,044 recoveries, **0 mismatched
  outcomes, 0 differing side effects**, 390 repeated writes, all with the same key and arguments (the
  at-least-once case above).
- **End to end under workerd** (`examples/approvals/e2e.mjs`): the example Worker, with `ctx.abort()`
  before two answers and a SIGKILL of the whole runtime before the third. It checks that the script
  finishes, closes exactly the approved issues, keeps one `Math.random()` run id throughout, and records
  each side effect once.
- **Reproducible engine:** `engine/setup.sh` rebuilds `engine/dq.wasm` from a pinned dquickts commit and
  wasi-sdk 34. The rebuilt binary is byte-identical to the checked-in one
  (sha256 `4039ef60f53bcfb79032ddb394b9d5f6c0d8cae5638e87e94e8a6c343fd35418`).

Measured in Node on a small script: about 2.6 KB stored per pause, and a few milliseconds to restore and
resume. The engine is 1.5 MB, or 510 KB gzipped.

## How it stores state

dquickts writes incremental snapshots: a *base* (the runtime right after setup) plus a *delta* (what the
program changed). Any fresh instance of the same `dq.wasm` produces an identical base, so amber stores
only the delta, in chunks, along with the base's SHA-256. On restore it rebuilds the base, checks the hash
and applies the delta.

## Limits

- **Same engine build only.** A snapshot loads only into the `dq.wasm` that wrote it. Upgrading the engine
  makes stored programs fail with `EngineMismatch` instead of resuming wrong. Drain or pin running programs
  before you upgrade.
- **Snapshots are trusted input.** amber only reads snapshots from its own storage. Never restore one
  that came from a request.
- **Sandbox, not a security boundary you should lean on alone.** Scripts can't reach the network, the
  filesystem or timers. They reach the outside world only through your tools. Still, put routes that
  accept code behind auth (for example Cloudflare Access), cap source size, and keep tools least-privilege.
- **Engine features.** No `Intl` or `Temporal` (dquickts can't snapshot them), no `std`/`os`, no timers.
- **One running program per `DurableScript`** (per object, with the default storage prefix).
- **Speed.** It's an interpreter. Long loops are sliced by a tick budget and continued by alarms.
- **Heap size.** A snapshot over `maxSnapshotBytes` (default 8 MB) fails the program with
  `SnapshotTooLarge`.

## Develop

```sh
npm ci
npm run check        # typecheck, unit tests + kill fuzz, workerd end to end
npm run engine       # optional: rebuild engine/dq.wasm from source (Linux x86_64)
AMBER_FUZZ_SEEDS=500 npx vitest run test/fuzz.test.ts
```

## Credits and license

MIT, see [LICENSE](LICENSE). The engine is [dquickts](https://github.com/stencil-hq/dquickts) by Stencil
Labs, on [QuickJS](https://bellard.org/quickjs/) by Fabrice Bellard and Charlie Gordon, both MIT. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
