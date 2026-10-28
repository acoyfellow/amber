export const DETERMINISTIC_SCRIPT = `const issues = tool("list_issues", { repo: "acoyfellow/my-ax" });
const closed = [];
for (const issue of issues) {
  const ok = tool("ask_human", { question: \`close #\${issue.id}?\` });
  if (ok) {
    tool("close_issue", { id: issue.id });
    closed.push(issue.id);
  }
}
return { closed };`;

export const LLM_SCRIPT = `const runId = Math.random().toString(36).slice(2, 8);
const startedAt = Date.now();
const issues = tool("list_issues", { repo: "acoyfellow/my-ax", runId });
const closed = [];
for (const issue of issues) {
  const ok = tool("ask_human", { runId, question: \`close #\${issue.id}?\` });
  if (ok) {
    tool("close_issue", { runId, id: issue.id });
    closed.push(issue.id);
  }
}
return { runId, closed, tookMs: Date.now() - startedAt };`;
