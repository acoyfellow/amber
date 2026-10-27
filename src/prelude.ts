export const PRELUDE = `var __amberTool = globalThis.tool;
var __amberRandom = { s: (Date.now() % 4294967295) || 1 };
globalThis.tool = function (name, args) {
  var reply = __amberTool(name, args === undefined ? null : args);
  if (reply !== null && typeof reply === "object") {
    if (typeof reply.r === "number") __amberRandom.s = (reply.r >>> 0) || 1;
    if (reply.t) { var error = new Error(reply.t.message); error.name = reply.t.name; throw error; }
    return reply.v;
  }
  return reply;
};
Math.random = function () {
  var x = __amberRandom.s;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  __amberRandom.s = x >>> 0;
  return (x >>> 0) / 4294967296;
};
`;

export type Envelope = { readonly v?: unknown; readonly t?: { readonly name: string; readonly message: string }; readonly r?: number };

export const value = (result: unknown): string => JSON.stringify({ v: result === undefined ? null : result });

export const thrown = (name: string, message: string): string => JSON.stringify({ t: { name, message } });

export const reseeded = (envelope: string, seed: number): string => JSON.stringify({ ...JSON.parse(envelope), r: seed });
