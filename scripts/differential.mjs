// Every value the library can encode must come out byte-identical to the
// previous release. This is the release gate: the optimization passes changed
// how the tokens are produced and were not allowed to change what they are,
// because two people on two machines with two versions must get the same bytes
// for the same value or every hash the library handed out is a lie.
//
//   npm install --no-save impronta-baseline@npm:impronta@<previous>
//   npm run build && node scripts/differential.mjs
import { loadBaseline, loadCurrent } from "./baseline.mjs";
const oldv = await loadBaseline();
const newv = await loadCurrent();

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Empty {}

function gen(depth) {
  const leafOnly = depth <= 0;
  const kinds = leafOnly
    ? ["num", "str", "bool", "null", "undef", "big", "date", "re", "ta", "ab", "negzero", "nan", "inf"]
    : ["num", "str", "bool", "null", "undef", "big", "date", "re", "ta", "ab",
       "arr", "obj", "map", "set", "class", "nullproto", "empty", "sparse", "negzero"];
  switch (pick(kinds)) {
    case "num": return pick([0, 1, -1, 1.5, 1e21, 1e-7, 123456789, -0.0001]);
    case "negzero": return -0;
    case "nan": return NaN;
    case "inf": return pick([Infinity, -Infinity]);
    case "str": return pick(["", "a", "hello world", "unicode-e", "with:colon", "s3:fake", " ", "tail"]);
    case "bool": return rnd() < 0.5;
    case "null": return null;
    case "undef": return undefined;
    case "big": return pick([0n, 123n, -456789012345678901234567890n]);
    case "date": return pick([new Date(0), new Date("2020-01-01"), new Date(NaN)]);
    case "re": return pick([/abc/g, /a:b/, new RegExp("", "imsu")]);
    case "ta": return pick([new Uint8Array([1, 2, 3]), new Int8Array([1, 2, 3]), new Float64Array([1.5]), new Uint8Array(0)]);
    case "ab": return new Uint8Array([9, 8, 7]).buffer;
    case "arr": return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(depth - 1));
    case "sparse": { const a = [1, , 3]; return a; }
    case "obj": {
      const o = {};
      const n = Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) o[pick(["a", "b", "zz", "0", "key with space", "Z"])] = gen(depth - 1);
      return o;
    }
    case "nullproto": { const o = Object.create(null); o.k = gen(depth - 1); return o; }
    case "map": {
      const m = new Map();
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) m.set(rnd() < 0.4 ? gen(0) : `k${i}`, gen(depth - 1));
      return m;
    }
    case "set": {
      const s = new Set();
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) s.add(gen(depth - 1));
      return s;
    }
    case "class": return new Point(gen(depth - 1), gen(depth - 1));
    case "empty": return new Empty();
  }
}

let checked = 0;
let mismatch = 0;
const modes = [{}, { order: "sorted" }];
for (let i = 0; i < 40000; i++) {
  const v = gen(3);
  for (const opts of modes) {
    let a, b, ea = null, eb = null;
    try { a = oldv.imprint(v, opts); } catch (e) { ea = `${e.constructor.name}|${e.message}`; }
    try { b = newv.imprint(v, opts); } catch (e) { eb = `${e.constructor.name}|${e.message}`; }
    checked++;
    if (ea !== eb || a !== b) {
      if (mismatch++ < 5) console.log("MISMATCH", JSON.stringify({ ea, eb }), "\n old:", a, "\n new:", b);
    }
  }
}
console.log(`imprint: ${checked} encodings compared, ${mismatch} mismatches`);

// And every node of the annotated tree.
let nodes = 0;
let nodeMismatch = 0;
const walk = (v, seen, out) => {
  if (v === null || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  out.push(v);
  if (Array.isArray(v)) v.forEach((c) => walk(c, seen, out));
  else if (v instanceof Map) for (const [k, val] of v) { walk(k, seen, out); walk(val, seen, out); }
  else if (v instanceof Set) for (const m of v) walk(m, seen, out);
  else if (!(v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer)) {
    for (const k of Object.keys(v)) walk(v[k], seen, out);
  }
};
seed = 999;
for (let i = 0; i < 20000; i++) {
  const v = gen(3);
  let ta, tb;
  try { ta = oldv.imprintTree(v); tb = newv.imprintTree(v); } catch { continue; }
  if (ta.root !== tb.root) { nodeMismatch++; continue; }
  const out = [];
  walk(v, new Set(), out);
  for (const n of out) {
    nodes++;
    if (ta.get(n) !== tb.get(n)) { if (nodeMismatch++ < 5) console.log("NODE MISMATCH", ta.get(n), tb.get(n)); }
  }
}
console.log(`imprintTree: ${nodes} node imprints compared, ${nodeMismatch} mismatches`);

// Cycles, which the corpus above cannot generate.
seed = 4242;
let cyc = 0;
let cycBad = 0;
for (let i = 0; i < 3000; i++) {
  const root = gen(2);
  if (root === null || typeof root !== "object" || root instanceof Date || root instanceof RegExp
      || ArrayBuffer.isView(root) || root instanceof ArrayBuffer) continue;
  try {
    if (Array.isArray(root)) root.push(root);
    else if (root instanceof Map) root.set("self", root);
    else if (root instanceof Set) root.add(root);
    else root.self = root;
  } catch { continue; }
  let a, b;
  try { a = oldv.imprint(root); b = newv.imprint(root); } catch { continue; }
  cyc++;
  if (a !== b) { if (cycBad++ < 3) console.log("CYCLE MISMATCH\n old:", a, "\n new:", b); }
  const ta = oldv.imprintTree(root);
  const tb = newv.imprintTree(root);
  if (ta.root !== tb.root || ta.get(root) !== tb.get(root)) cycBad++;
}
console.log(`cycles: ${cyc} compared, ${cycBad} mismatches`);

// Error paths must still name the position.
const cases = [
  { v: { a: { b: [1, 2, () => {}] } }, want: "a.b[2]" },
  { v: { x: Symbol("s") }, want: "x" },
  { v: [{ k: new WeakMap() }], want: "[0].k" },
  { v: new Map([["mk", { deep: Promise.resolve(1) }]]), want: "<value 0>.deep" },
  { v: new Set([[1, () => {}]]), want: "<member 0>[1]" },
  { v: () => {}, want: "" },
  { v: { "with.dot": Symbol() }, want: "with.dot" },
  { v: new Map([[{ bad: Symbol() }, 1]]), want: "<key 0>.bad" },
];
let pathBad = 0;
for (const c of cases) {
  let op = null, np = null;
  try { oldv.imprint(c.v); } catch (e) { op = e.path; }
  try { newv.imprint(c.v); } catch (e) { np = e.path; }
  if (!(op === np && np === c.want)) {
    pathBad++;
    console.log(`PATH: want ${JSON.stringify(c.want)} old ${JSON.stringify(op)} new ${JSON.stringify(np)}`);
  }
}
console.log(`error paths: ${cases.length} compared, ${pathBad} mismatches`);
