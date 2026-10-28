export const APPROVALS_PROGRAM = `const decided = [];
for (let id = 0; id < 8; id++) {
  const ok = tool<boolean>("ask", { id });
  decided.push({ id, ok });
}
({ decided });`;

export const LOOP_PROGRAM = `let sum = 0;
for (let i = 0; i < 3000000; i++) sum += i % 1000;
({ sum });`;
