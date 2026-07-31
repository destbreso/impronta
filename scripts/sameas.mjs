// sameAs and bucket must agree with string comparison of get(), on every pair,
// including across two independently built trees and in sorted mode where the
// implementation falls back to materialized tokens. Offsets, the rolling hash
// and the second comparison path all landed under this script.
//
//   npm install --no-save impronta-baseline@npm:impronta@<previous>
//   npm run build && node scripts/sameas.mjs
import { loadBaseline, loadCurrent } from "./baseline.mjs";
const oldv = await loadBaseline();
const newv = await loadCurrent();

let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
class Point { constructor(x, y) { this.x = x; this.y = y; } }

function gen(d) {
  if (d <= 0) return pick([0, -0, 1, "a", "", null, undefined, true, 5n, new Date(0), /x/g, new Uint8Array([1, 2]), NaN]);
  switch (pick(["arr", "obj", "map", "set", "class", "leaf", "leaf"])) {
    case "arr": return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d - 1));
    case "obj": { const o = {}; for (let i = 0, n = Math.floor(rnd() * 4); i < n; i++) o[pick(["a", "b", "c"])] = gen(d - 1); return o; }
    case "map": { const m = new Map(); for (let i = 0, n = Math.floor(rnd() * 3); i < n; i++) m.set(pick(["k", "j"]), gen(d - 1)); return m; }
    case "set": { const s = new Set(); for (let i = 0, n = Math.floor(rnd() * 3); i < n; i++) s.add(gen(d - 1)); return s; }
    case "class": return new Point(gen(d - 1), gen(d - 1));
    default: return gen(0);
  }
}
const nodesOf = (v, seen = new Set(), out = []) => {
  if (v === null || typeof v !== "object" || seen.has(v)) return out;
  seen.add(v); out.push(v);
  if (Array.isArray(v)) v.forEach((c) => nodesOf(c, seen, out));
  else if (v instanceof Map) for (const [k, val] of v) { nodesOf(k, seen, out); nodesOf(val, seen, out); }
  else if (v instanceof Set) for (const m of v) nodesOf(m, seen, out);
  else if (!(v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer)) {
    for (const k of Object.keys(v)) nodesOf(v[k], seen, out);
  }
  return out;
};

for (const opts of [{}, { order: "sorted" }]) {
  const label = opts.order ?? "insertion";
  let pairs = 0, badSame = 0, badBucket = 0, badGet = 0, trueCount = 0;
  for (let i = 0; i < 3000; i++) {
    const va = gen(3), vb = gen(3);
    let ta, tb;
    try { ta = newv.imprintTree(va, opts); tb = newv.imprintTree(vb, opts); } catch { continue; }
    // get() must still agree with the published implementation
    const oa = oldv.imprintTree(va, opts);
    for (const n of nodesOf(va)) if (ta.get(n) !== oa.get(n)) badGet++;

    const all = [...nodesOf(va).map((n) => [ta, n]), ...nodesOf(vb).map((n) => [tb, n])];
    for (let x = 0; x < all.length; x++) {
      for (let y = 0; y < all.length; y++) {
        const [t1, n1] = all[x], [t2, n2] = all[y];
        const s1 = t1.get(n1), s2 = t2.get(n2);
        const expected = s1 !== undefined && s1 === s2;
        pairs++;
        if (expected) trueCount++;
        if (t1.sameAs(n1, t2, n2) !== expected) badSame++;
        // equal content must always bucket the same
        if (expected && t1.bucket(n1) !== t2.bucket(n2)) badBucket++;
      }
    }
  }
  console.log(`${label.padEnd(10)} ${pairs} node pairs (${trueCount} genuinely equal): sameAs wrong ${badSame}, bucket wrong ${badBucket}, get drift ${badGet}`);
}

// Cycles: escaping subtrees must report undefined and never claim sameness.
let cycBad = 0, cycChecked = 0;
for (let i = 0; i < 500; i++) {
  const root = { n: i % 3 };
  root.child = { deeper: {} };
  root.child.deeper.up = root;
  const t = newv.imprintTree(root);
  const o = oldv.imprintTree(root);
  for (const n of nodesOf(root)) {
    cycChecked++;
    if (t.get(n) !== o.get(n)) cycBad++;
    if (t.get(n) === undefined && t.sameAs(n, t, n)) cycBad++;
    if (t.get(n) === undefined && t.bucket(n) !== undefined) cycBad++;
  }
}
console.log(`cycles: ${cycChecked} nodes checked, ${cycBad} wrong`);

// A node is always the same as itself when it has an imprint.
let reflexBad = 0;
for (let i = 0; i < 2000; i++) {
  const v = gen(3);
  let t; try { t = newv.imprintTree(v); } catch { continue; }
  for (const n of nodesOf(v)) if (t.get(n) !== undefined && !t.sameAs(n, t, n)) reflexBad++;
}
console.log(`reflexive: ${reflexBad} failures`);
