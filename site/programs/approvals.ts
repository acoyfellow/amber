interface Issue { id: number; title: string; labels: string[] }
type Verdict = { id: number; action: "close" | "triage" };

declare function tool<T>(name: string, args: unknown): T;
declare function print(s: string): void;

class Ledger {
  constructor(private seen: Verdict[] = []) {}
  add(v: Verdict): number { this.seen.push(v); return this.seen.length; }
  get all(): Verdict[] { return this.seen; }
}

const ledger = new Ledger();
const issues = tool<Issue[]>("gh.list_issues", { repo: "acoyfellow/my-ax", state: "open" });
print(`got ${issues.length} issues`);

for (let i = 0; i < issues.length; i++) {
  const it = issues[i];
  const ok = tool<boolean>("ask_user", { question: `close #${it.id} "${it.title}"?` });
  const n = ledger.add({ id: it.id, action: ok ? "close" : "triage" });
  print(`decision ${n}: #${it.id} -> ${ok ? "close" : "triage"}`);
}

({ decided: ledger.all, at: "loop finished in a different process than it started" });
