declare function print(s: string): void;
const seen = new Map<number, number>();
let sum: bigint = 0n;
for (let i = 0; i < 3_000_000; i++) {
  sum += BigInt(i % 1000);
  if (i % 1_000_000 === 0) seen.set(i, Number(sum % 97n));
}
print(`loop done, ${seen.size} checkpoints`);
({ sum: sum.toString(), checkpoints: [...seen.entries()] });
