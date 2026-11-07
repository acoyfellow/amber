## Overall, per arm and model (means per run)

| Model | Arm | n | Pass | LLM calls | In tok | Out tok | $/run | Wall s | Kills | Repeated effects after kill | Generations | Repairs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| glm-5.3-flash | loop | 32 | 27/32 | 6.4 | 7831 | 1008 | $0.0017 | 30 | 58 | 12 | 0 | 0 |
| glm-5.3-flash | fresh | 32 | 26/32 | 2.5 | 993 | 5320 | $0.0028 | 143 | 61 | 0 | 32 | 2 |
| glm-5.3-flash | reuse | 32 | 23/32 | 1.6 | 327 | 1323 | $0.0007 | 23 | 54 | 0 | 7 | 0 |
| glm-5.3 | loop | 32 | 31/32 | 6.9 | 8650 | 1030 | $0.0166 | 13 | 61 | 5 | 0 | 0 |
| glm-5.3 | fresh | 32 | 30/32 | 3.2 | 1029 | 9866 | $0.0448 | 75 | 63 | 0 | 32 | 2 |
| glm-5.3 | reuse | 32 | 30/32 | 1.5 | 418 | 5387 | $0.0243 | 36 | 60 | 0 | 9 | 2 |

For reuse, $/run is already amortized: the one generation and any repairs are charged to the runs that made them, and the mean is over all 4 variants of each family.

## Per family (pass and $/run)

| Model | Family | loop pass | loop $/run | fresh pass | fresh $/run | reuse pass | reuse $/run (amortized) | reuse gen+repair $ | reuse run-only $/run |
|---|---|---|---|---|---|---|---|---|---|
| glm-5.3-flash | triage | 0/4 | $0.0032 | 0/4 | $0.0078 | 0/4 | $0.0022 | $0.0070 | $0.0004 |
| glm-5.3-flash | release | 4/4 | $0.0011 | 4/4 | $0.0019 | 4/4 | $0.0000 | $0.0000 | $0.0000 |
| glm-5.3-flash | release-blocked | 4/4 | $0.0012 | 2/4 | $0.0014 | 4/4 | $0.0005 | $0.0021 | $0.0000 |
| glm-5.3-flash | stale-sweep | 4/4 | $0.0018 | 4/4 | $0.0016 | 0/4 | $0.0003 | $0.0012 | $0.0000 |
| glm-5.3-flash | merge-queue | 4/4 | $0.0023 | 4/4 | $0.0018 | 4/4 | $0.0004 | $0.0015 | $0.0000 |
| glm-5.3-flash | security | 4/4 | $0.0013 | 4/4 | $0.0035 | 4/4 | $0.0011 | $0.0033 | $0.0003 |
| glm-5.3-flash | changelog | 3/4 | $0.0010 | 4/4 | $0.0021 | 4/4 | $0.0008 | $0.0030 | $0.0000 |
| glm-5.3-flash | customer-followup | 4/4 | $0.0015 | 4/4 | $0.0022 | 3/4 | $0.0004 | $0.0018 | $0.0000 |
| glm-5.3 | triage | 3/4 | $0.0300 | 3/4 | $0.1447 | 3/4 | $0.1347 | $0.5309 | $0.0020 |
| glm-5.3 | release | 4/4 | $0.0098 | 4/4 | $0.0157 | 4/4 | $0.0052 | $0.0188 | $0.0005 |
| glm-5.3 | release-blocked | 4/4 | $0.0115 | 4/4 | $0.0172 | 4/4 | $0.0028 | $0.0112 | $0.0000 |
| glm-5.3 | stale-sweep | 4/4 | $0.0181 | 4/4 | $0.0165 | 4/4 | $0.0026 | $0.0106 | $0.0000 |
| glm-5.3 | merge-queue | 4/4 | $0.0207 | 4/4 | $0.0324 | 4/4 | $0.0084 | $0.0338 | $0.0000 |
| glm-5.3 | security | 4/4 | $0.0136 | 4/4 | $0.0638 | 4/4 | $0.0208 | $0.0707 | $0.0031 |
| glm-5.3 | changelog | 4/4 | $0.0128 | 4/4 | $0.0438 | 4/4 | $0.0079 | $0.0318 | $0.0000 |
| glm-5.3 | customer-followup | 4/4 | $0.0166 | 3/4 | $0.0247 | 3/4 | $0.0118 | $0.0395 | $0.0019 |

## Break-even: reused runs needed before script-reuse costs less than the loop

Cost of N reuse runs = generation + repairs + N × run-only cost. Cost of N loop runs = N × loop $/run. Break-even N = generation+repairs ÷ (loop − run-only).

| Model | Family | loop $/run | gen+repair $ | reuse run-only $/run | break-even runs |
|---|---|---|---|---|---|
| glm-5.3-flash | triage | $0.0032 | $0.0070 | $0.0004 | 3 |
| glm-5.3-flash | release | $0.0011 | $0.0000 | $0.0000 | 1 |
| glm-5.3-flash | release-blocked | $0.0012 | $0.0021 | $0.0000 | 2 |
| glm-5.3-flash | stale-sweep | $0.0018 | $0.0012 | $0.0000 | 1 |
| glm-5.3-flash | merge-queue | $0.0023 | $0.0015 | $0.0000 | 1 |
| glm-5.3-flash | security | $0.0013 | $0.0033 | $0.0003 | 4 |
| glm-5.3-flash | changelog | $0.0010 | $0.0030 | $0.0000 | 4 |
| glm-5.3-flash | customer-followup | $0.0015 | $0.0018 | $0.0000 | 2 |
| glm-5.3 | triage | $0.0300 | $0.5309 | $0.0020 | 19 |
| glm-5.3 | release | $0.0098 | $0.0188 | $0.0005 | 3 |
| glm-5.3 | release-blocked | $0.0115 | $0.0112 | $0.0000 | 1 |
| glm-5.3 | stale-sweep | $0.0181 | $0.0106 | $0.0000 | 1 |
| glm-5.3 | merge-queue | $0.0207 | $0.0338 | $0.0000 | 2 |
| glm-5.3 | security | $0.0136 | $0.0707 | $0.0031 | 7 |
| glm-5.3 | changelog | $0.0128 | $0.0318 | $0.0000 | 3 |
| glm-5.3 | customer-followup | $0.0166 | $0.0395 | $0.0019 | 3 |
| **glm-5.3-flash** | **suite (one run of every family)** | **$0.0134** | **$0.0199** | **$0.0007** | **2** |
| **glm-5.3** | **suite (one run of every family)** | **$0.1331** | **$0.7472** | **$0.0075** | **6** |

## Failures

- `r1-glm-5.3-flash-triage-loop-v2` (done): failed 223 bug, 225 question, 227 feature. 
- `r1-glm-5.3-flash-triage-loop-v1` (done): failed 103 duplicate+comment #101, 106 duplicate+comment #104, no false duplicates, 103 closed after ask, nothing else closed. 
- `r1-glm-5.3-flash-triage-loop-v3` (done): failed 343 feature, 344 bug. 
- `r1-glm-5.3-flash-triage-loop-v4` (done): failed 7010 question, 7013 bug, 7014 duplicate+comment #7010, no false duplicates, 7014 closed after ask, nothing else closed. 
- `r1-glm-5.3-triage-loop-v1` (done): failed 103 duplicate+comment #101, 106 duplicate+comment #104. 
- `r2-glm-5.3-triage-fresh-v1` (done): failed 103 duplicate+comment #101, 106 duplicate+comment #104, no false duplicates, 103 closed after ask. 
- `r1-glm-5.3-flash-triage-fresh-v1` (done): failed 101 bug, 104 question, 103 duplicate+comment #101, 106 duplicate+comment #104, no false duplicates, 103 closed after ask. attempt 0 failed: ScriptError: TypeError: this call cannot be suspended
    at tool (native) | program a1 repaired 6823cf94b7b8 (6428 chars)
- `r2-glm-5.3-triage-reuse-v1` (script-failed): failed 101 bug, 102 feature, 103 bug, 104 question, 105 feature, 106 question, 103 duplicate+comment #101, 106 duplicate+comment #104, 103 closed after ask. generate reply hit max_tokens | attempt 0 failed: EmptyProgram: the model returned 0 characters of code, likely cut off at max_tokens | repair reply hit max_tokens | program a1 repaired e3b0c44298fc (0 chars) | attempt 1 failed: EmptyProgram: the model returned 0 characters of code, likely cut off at max_tokens
- `r1-glm-5.3-flash-triage-fresh-v2` (script-failed): failed 220 bug, 221 feature, 222 question, 223 bug, 224 feature, 225 question, 226 bug, 227 feature, 223 duplicate+comment #220, 225 duplicate+comment #222, 227 duplicate+comment #221, 225 closed after ask, 227 closed after ask. attempt 0 failed: ScriptError: SyntaxError: unexpected line terminator in regexp
    at <program>:51:39 | program a1 repaired 138cad61ead1 (5435 chars) | attempt 1 failed: ScriptError: TypeError: this call cannot be suspended
    at tool (native)
- `r1-glm-5.3-flash-triage-fresh-v3` (done): failed 343 feature. 
- `r1-glm-5.3-flash-triage-fresh-v4` (done): failed 7013 bug, 7014 question. 
- `r1-glm-5.3-flash-triage-reuse-v1` (done): failed 103 bug, 106 question. 
- `r1-glm-5.3-flash-triage-reuse-v2` (done): failed 223 bug, 225 question, 227 feature. 
- `r1-glm-5.3-flash-triage-reuse-v3` (done): failed 343 feature. 
- `r1-glm-5.3-flash-triage-reuse-v4` (done): failed 7013 bug, 7014 question. 
- `r1-glm-5.3-customer-followup-fresh-v3` (done): failed labeled v3.2.0. 
- `r1-glm-5.3-customer-followup-reuse-v3` (done): failed closed. 
- `r1-glm-5.3-flash-release-blocked-fresh-v3` (done): failed nobody notified. 
- `r1-glm-5.3-flash-release-blocked-fresh-v4` (done): failed #oncall names test after ask. 
- `r1-glm-5.3-flash-stale-sweep-reuse-v1` (done): failed 210 closed+comment, 212 open+keep, 214 closed+comment, asked each stale. 
- `r1-glm-5.3-flash-stale-sweep-reuse-v2` (done): failed 601 open+keep, 603 closed+comment, 606 open+keep, asked each stale. 
- `r1-glm-5.3-flash-stale-sweep-reuse-v3` (done): failed 1001 closed+comment, 1003 closed+comment, 1005 closed+comment, asked each stale. 
- `r1-glm-5.3-flash-stale-sweep-reuse-v4` (done): failed 88 open+keep, 92 closed+comment, 93 open+keep, asked each stale. 
- `r1-glm-5.3-flash-changelog-loop-v4` (done): failed posted once. 
- `r1-glm-5.3-flash-customer-followup-reuse-v2` (done): failed left open. 

## Totals

Runs: 192. Measured Workers AI spend for these rows: $2.9113. AI retries (3021/3040/3046): 4. Runs that hit a busy claim on /run: 0.
