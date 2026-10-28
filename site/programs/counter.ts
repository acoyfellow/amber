declare function tool<T>(name: string, args: unknown): T;
declare function print(s: string): void;

const counter = () => {
  let count = 0;
  return () => ++count;
};

const next = counter();
let keepGoing = true;

while (keepGoing) {
  const n = next();
  print(`count is ${n}`);
  keepGoing = tool<boolean>("ask_user", { question: `count is ${n}. Keep going?` });
}

({ stoppedAt: next() - 1 });
