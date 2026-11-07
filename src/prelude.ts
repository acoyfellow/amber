const BODY = `var __amberTool = globalThis.tool;
var __amberOffset = __OFFSET__;
var __amberAt = function () {
  var lines = String(new Error().stack || "").split("\\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /<program>:(\\d+)/.exec(lines[i]);
    if (m && Number(m[1]) > __amberOffset) return Number(m[1]) - __amberOffset;
  }
  return 0;
};
var __amberRandom = { s: (Date.now() % 4294967295) || 1 };
globalThis.tool = function (name, args) {
  var reply;
  try { reply = __amberTool(name, { a: args === undefined ? null : args, at: __amberAt() }); }
  catch (cause) {
    if (cause instanceof TypeError && /cannot be suspended/.test(String(cause.message))) {
      var hint = new TypeError('tool("' + name + '") was called inside a callback (forEach, map, filter, sort, reduce, a getter or a constructor argument). amber can only pause a direct call: use a for...of loop instead.');
      hint.name = "NotPausable";
      throw hint;
    }
    throw cause;
  }
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

export const PRELUDE_LINES = BODY.split("\n").length - 1;

export const PRELUDE = BODY.replace("__OFFSET__", String(PRELUDE_LINES));

export type Envelope = { readonly v?: unknown; readonly t?: { readonly name: string; readonly message: string }; readonly r?: number };

export const value = (result: unknown): string => JSON.stringify({ v: result === undefined ? null : result });

export const thrown = (name: string, message: string): string => JSON.stringify({ t: { name, message } });

export const reseeded = (envelope: string, seed: number): string => JSON.stringify({ ...JSON.parse(envelope), r: seed });
