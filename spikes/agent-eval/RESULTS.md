# Spike A2: plan reuse (ROADMAP F9 + F10)

This is the cost gate from the ROADMAP: "if the script still costs more than the loop on the full suite, amber narrows to the pause primitive for codemode".

## What ran

- **Families:** 8 task families, ported from Spike A (`dquickts-worker`, `spike/agent-eval`). Each family is now a template with 4 variants. The variants differ in issue ids, counts, which items are duplicates, versions, CI run ids, poll counts, thresholds, channels and the human's answers. Each variant's checks and oracle answers come from that variant's own fixture (`src/tasks.ts`).
- **Arms:**
  - `loop`: a fresh tool-calling loop for each variant, given the concrete prompt.
  - `fresh`: the model writes a new program for each variant from the concrete prompt, as in Spike A.
  - `reuse`: the model writes ONE program from the template prompt. The template prompt has no concrete values. The program is written on variant 1 and stored by SHA-256. Variants 2 to 4 run the stored program with no generation. A program that fails can have one repair generation; the repair cost is counted, and the repaired program is stored.
- **Program inputs:** programs read their inputs with `tool("input", {})`. The reuse prompt forbids hardcoded values.
  - I read the stored release program and found no hardcoded values in it (for example, no `1.4`, `r-140` or `#releases`).
  - I did not read every stored program.
- **Runtime:** amber itself. `DurableScript` comes from `../../src`, the wasm from `../../engine/dq.wasm`, and storage is `durableObjectStorage`. Tool kinds:
  - `read`: input, list_issues, get_issue, list_prs, fetch_ci, llm;
  - `write`: label, close, post_comment, merge_pr, create_release, notify. The fixture deduplicates on amber's `key`.
  - `external`: ask_user.
- **Kills:** 2 seeded `ctx.abort()` kills at tool boundaries 1 to 6 on every run and every arm.
- **Runs and retries:** local `wrangler dev`, with Workers AI remote. 2-way parallel per model. Workers AI errors 3021, 3040 and 3046 are retried with backoff (4 retries were needed in total).
- **Idempotent `/run`:** `/run` is idempotent per runId. A World Durable Object holds a lease, and a second `/run` on the same id waits for the first run to finish instead of starting a new one. A smoke test with two parallel calls gave one `mine` and one `busy`, and only 1 generation.
- **Models and prices:**
  - Prices are from the Workers AI pricing page, read on 2026-11-07.
  - `@cf/zai-org/glm-5.3`: $1.40/M input, $4.40/M output. This is the same model as Spike A.
  - `@cf/zai-org/glm-5.3-flash`: $0.15/M input, $0.50/M output. Its output tokens are 8.8× cheaper, and it supports tool calls in the same format.
  - Cached-input discounts are not used; every input token is charged at the full price.
- **Spend:** the measured Workers AI spend was **$3.58** in total, including smoke tests, invalid r1 rows and stalled runs. The 192 rows in the tables cost $2.91. The cap was $4.50.

## Results (means per run, 32 runs per arm and model)

| Model | Arm | Pass | LLM calls | In tok | Out tok | $/run | Wall s | Kills survived | Effects repeated after kill |
|---|---|---|---|---|---|---|---|---|---|
| glm-5.3 | loop | 31/32 | 6.9 | 8650 | 1030 | $0.0166 | 13 | 61/61 | 5 |
| glm-5.3 | fresh | 30/32 | 3.2 | 1029 | 9866 | $0.0448 | 75 | 63/63 | 0 |
| glm-5.3 | reuse | 30/32 | 1.5 | 418 | 5387 | **$0.0243** amortized | 36 | 60/60 | 0 |
| glm-5.3-flash | loop | 27/32 | 6.4 | 7831 | 1008 | $0.0017 | 30 | 58/58 | 12 |
| glm-5.3-flash | fresh | 26/32 | 2.5 | 993 | 5320 | $0.0028 | 143 | 61/61 | 0 |
| glm-5.3-flash | reuse | 23/32 | 1.6 | 327 | 1323 | **$0.0007** amortized | 23 | 54/54 | 0 |

- **How the reuse cost is amortized:** the one generation and any repairs per family are charged to the runs that made them. The mean is then taken over all 4 variants.
- **Reuse LLM calls that remain:** these are `tool("llm")` sub-calls that the program itself makes at run time.
- **Kills survived:** a kill counts as survived when the run reached a final outcome after it. No run ended in `unfinished` or `harness-error`.
- **Effects repeated after a kill:** the same write, with the same arguments, ran again after a restart.
  - The loop arm repeats writes because its transcript is saved only after the tool result.
  - Script arms show 0 because amber's write `key` let the fixture deduplicate them. Deduplicated retries: 54 over both script arms and both models.

### Per family (glm-5.3)

| Family | loop $/run | fresh $/run | reuse $/run amortized | reuse gen + repair $ | reuse run-only $/run | loop / fresh / reuse pass |
|---|---|---|---|---|---|---|
| triage | 0.0300 | 0.1447 | 0.1347 | 0.5309 | 0.0020 | 3 / 3 / 3 |
| release | 0.0098 | 0.0157 | 0.0052 | 0.0188 | 0.0005 | 4 / 4 / 4 |
| release-blocked | 0.0115 | 0.0172 | 0.0028 | 0.0112 | 0.0000 | 4 / 4 / 4 |
| stale-sweep | 0.0181 | 0.0165 | 0.0026 | 0.0106 | 0.0000 | 4 / 4 / 4 |
| merge-queue | 0.0207 | 0.0324 | 0.0084 | 0.0338 | 0.0000 | 4 / 4 / 4 |
| security | 0.0136 | 0.0638 | 0.0208 | 0.0707 | 0.0031 | 4 / 4 / 4 |
| changelog | 0.0128 | 0.0438 | 0.0079 | 0.0318 | 0.0000 | 4 / 4 / 4 |
| customer-followup | 0.0166 | 0.0247 | 0.0118 | 0.0395 | 0.0019 | 4 / 3 / 3 |

Without triage, glm-5.3 over 28 runs per arm: loop 28/28 passed at $0.0147 per run, fresh 27/28 at $0.0306, and reuse 27/28 at $0.0085.

### Per family (glm-5.3-flash)

| Family | loop $/run | fresh $/run | reuse $/run amortized | loop / fresh / reuse pass |
|---|---|---|---|---|
| triage | 0.0032 | 0.0078 | 0.0022 | 0 / 0 / 0 |
| release | 0.0011 | 0.0019 | 0.0000 | 4 / 4 / 4 |
| release-blocked | 0.0012 | 0.0014 | 0.0005 | 4 / 2 / 4 |
| stale-sweep | 0.0018 | 0.0016 | 0.0003 | 4 / 4 / 0 |
| merge-queue | 0.0023 | 0.0018 | 0.0004 | 4 / 4 / 4 |
| security | 0.0013 | 0.0035 | 0.0011 | 4 / 4 / 4 |
| changelog | 0.0010 | 0.0021 | 0.0008 | 3 / 4 / 4 |
| customer-followup | 0.0015 | 0.0022 | 0.0004 | 4 / 4 / 3 |

## Break-even

The break-even is the number of reused runs after which script-reuse costs less in total than the loop:

`N = (generation + repair $) ÷ (loop $/run − reuse run-only $/run)`

| Model | Scope | loop $/run | gen + repair $ | reuse run-only $/run | Break-even runs |
|---|---|---|---|---|---|
| glm-5.3 | full suite (one run of each family) | 0.1331 | 0.7472 | 0.0075 | **6** |
| glm-5.3 | suite without triage | 0.1031 | 0.2163 | 0.0055 | **3** |
| glm-5.3 | triage alone | 0.0300 | 0.5309 | 0.0020 | 19 |
| glm-5.3 | security alone | 0.0136 | 0.0707 | 0.0031 | 7 |
| glm-5.3 | release-blocked or stale-sweep | | | | 1 |
| glm-5.3-flash | full suite | 0.0134 | 0.0199 | 0.0007 | **2** |

Each family runs 4 times, so the measured window is 4 runs. A break-even above 4, such as triage's 19, is a projection from the measured costs and was not measured.

## Failure examples

- **Empty programs (a harness bug, fixed):** in the first glm-5.3 pass, the triage and security programs hit the 16k `max_tokens` limit inside the model's reasoning. The reply had no code, and reuse then stored and reran the empty program on variants 2 to 4.
  - Fix: the limit is raised to 32k. A program under 40 characters now fails as `EmptyProgram`, so the repair path runs, and an empty program is never stored.
  - Those 16 runs were rerun (tag `r2`), and the r2 rows replace the r1 rows.
- **glm-5.3 `r2-triage-reuse`:**
  - v1: the generation hit the 32k limit again, then the repair also hit it. The cost was $0.28 and the run failed.
  - v2: the repair from v2 worked, a 7.6k-character program at $0.25.
  - v3 and v4: the repaired program was reused and passed at $0.002 per run.
  - This one family is $0.53 of the $0.75 total that glm-5.3 spent on generation across the suite.
- **`r2-glm-5.3-triage-fresh-v2`:** passed, but needed 11 LLM calls and 46.7k output tokens ($0.21). Long reasoning on judgment tasks is still the cost risk for writing programs.
- **glm-5.3-flash triage, 0/12 on every arm:**
  - The model leaves the type label off duplicates, or pairs the wrong duplicate with the original.
  - This is a model limit, not an arm effect.
- **glm-5.3-flash `stale-sweep` reuse, 0/4:**
  - The stored program asks the right question for each stale issue.
  - It fails on every variant because its yes/no parsing matches "no" inside the decline answer before "yes". This is a general bug in one program.
  - Reuse copies a bug to every input. Fresh got 4/4 on the same family.
- **`TypeError: this call cannot be suspended` (glm-5.3-flash triage fresh):** the program called `tool()` inside an `Array.prototype` callback, where the engine cannot snapshot. amber should name this in the system prompt or in the error.
- **glm-5.3 `customer-followup` reuse v3:**
  - The input is a customer on 3.2.0 with the fix in 3.0.0.
  - The program did not close the report after a "Yes, close it." It treated the answer as part of the earlier version flow.

## Verdict

**PASS on cost for glm-5.3 over the measured 4-variant window, with limits.**

- **The ROADMAP gate:** it compared the fresh script to the loop. Fresh still loses: $0.0448 against $0.0166 per run, 2.7× the loop, worse than Spike A's 1.47×.
- **Reuse flips it.** Amortized over the 4 variants, reuse costs $0.0243 against the loop's $0.0166 on the full suite, so reuse still costs **more than the loop at 4 runs** (1.46×).
  - It breaks even at 6 runs of the suite.
  - It wins at 4 runs on every family except triage and security.
  - Without triage, reuse costs $0.0085 against $0.0147, which is 42% cheaper, at the same pass rate (27/28 against 28/28).
- **So the honest reading:**
  - At 4 reuses, the full suite fails the gate.
  - At 6 or more reuses of a stored plan, it passes.
  - On mechanical and medium-judgment tasks it passes at 1 to 3 runs.
- **glm-5.3-flash:** reuse is cheapest of all ($0.0007 per run, break-even at 2), but quality drops: reuse passed 23/32 against the loop's 27/32. One bad program fails every variant.
- **Reliability:** both script arms survived every kill with 0 repeated effects, against 5 and 12 on the loop. This is the clearest win, and it comes from amber's write keys.
- **Not verified:**
  - Costs beyond 4 variants per family; break-evens above 4 are projections.
  - Seeds other than one per variant.
  - Other models.
  - Real (non-fixture) tools.
  - Whether a stored program stays correct as inputs drift further than these variants.
  - Cached-input pricing.

**What this means for amber:** don't narrow yet; amber is a general harness only where a plan gets reused. A one-off script is still worse than a loop. The claim to make is "write the plan once, run it many times, survive kills". Make it with two guards:
- a repair budget;
- a reuse check before storing a program, so one bad plan doesn't spread.
