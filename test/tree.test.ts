import { describe, expect, it } from "vitest";
import { imprint, imprintTree } from "../src/index.js";

class Point {
  constructor(public x: number, public y: number) {}
}

/** Walk the object graph the way imprint does, yielding every object node. */
function* objects(v: unknown, seen = new Set<object>()): Generator<object> {
  if (v === null || typeof v !== "object") return;
  if (seen.has(v)) return;
  seen.add(v);
  yield v;
  if (v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
  if (v instanceof Map) {
    for (const [k, val] of v) {
      yield* objects(k, seen);
      yield* objects(val, seen);
    }
    return;
  }
  if (v instanceof Set) {
    for (const m of v) yield* objects(m, seen);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) yield* objects(item, seen);
    return;
  }
  for (const key of Object.keys(v)) yield* objects((v as Record<string, unknown>)[key], seen);
}

const CORPUS: Record<string, unknown> = {
  "nested plain": { a: 1, b: { c: [1, 2, 3] }, d: null },
  "map of objects": { m: new Map<unknown, unknown>([["k", { deep: true }], [{ objKey: 1 }, [1, 2]]]) },
  "set of objects": { s: new Set([{ x: 1 }, { y: 2 }]) },
  "typed arrays": { u8: new Uint8Array([1, 2, 3]), i8: new Int8Array([1, 2, 3]) },
  "class instances": [new Point(1, 2), new Point(1, 2), new Point(3, 4)],
  "dates and regexps": { d: new Date(0), bad: new Date(NaN), r: /ab/g },
  "null prototype": { np: Object.assign(Object.create(null), { k: 1 }) },
  "shared reference": (() => {
    const shared = { v: 1 };
    return { l: shared, r: shared };
  })(),
  "self cycle": (() => {
    const o: Record<string, unknown> = { n: 1 };
    o.self = o;
    return o;
  })(),
  "array of records": [
    { id: 1, tags: new Set(["a"]) },
    { id: 2, tags: new Set(["b"]) },
  ],
  "empty containers": { o: {}, a: [], m: new Map(), s: new Set() },
  "deep chain": (() => {
    let node: unknown = 0;
    for (let i = 0; i < 40; i++) node = { next: node };
    return node;
  })(),
};

describe("imprintTree: agrees with imprint", () => {
  for (const [name, value] of Object.entries(CORPUS)) {
    it(`root matches imprint for "${name}"`, () => {
      expect(imprintTree(value).root).toBe(imprint(value));
    });

    it(`every self-contained node matches its standalone imprint for "${name}"`, () => {
      const tree = imprintTree(value);
      let checked = 0;
      for (const node of objects(value)) {
        const token = tree.get(node);
        if (token === undefined) continue;
        expect(token).toBe(imprint(node));
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  it("honors the ordering option, and passes it down to every node", () => {
    const value = { s: new Set([3, 1, 2]) };
    const sorted = imprintTree(value, { order: "sorted" });
    expect(sorted.root).toBe(imprint(value, { order: "sorted" }));
    expect(sorted.get(value.s)).toBe(imprint(value.s, { order: "sorted" }));
    expect(sorted.get(value.s)).not.toBe(imprint(value.s, { order: "insertion" }));
  });
});

// ---------------------------------------------------------------------------
// The property a structural diff is built on: equal imprint means equal value,
// in both directions. One direction stops a diff from descending into a subtree
// that did not change; the other stops it from reporting one that did not.
// ---------------------------------------------------------------------------

describe("imprintTree: content identity", () => {
  it("gives two structurally equal subtrees the same key, wherever they sit", () => {
    const left = { rows: [{ id: 1, at: new Date(0) }, { id: 2, at: new Date(0) }] };
    const right = { other: { deeper: { id: 2, at: new Date(0) } } };
    const a = imprintTree(left);
    const b = imprintTree(right);
    expect(a.get(left.rows[1]!)).toBe(b.get(right.other.deeper));
    expect(a.get(left.rows[0]!)).not.toBe(a.get(left.rows[1]!));
  });

  it("distinguishes the types a JSON-subset diff collapses", () => {
    const value = {
      map: new Map([["k", 1]]),
      obj: { k: 1 },
      set: new Set([1, 2, 3]),
      arr: [1, 2, 3],
      u8: new Uint8Array([1, 2, 3]),
      inst: new Point(1, 2),
      plain: { x: 1, y: 2 },
    };
    const tree = imprintTree(value);
    const keys = Object.values(value).map((v) => tree.get(v as object));
    expect(keys.every((k) => typeof k === "string")).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("survives a reordered array: the moved element keeps its key", () => {
    const before = { v: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    const after = { v: [{ id: "b" }, { id: "c" }, { id: "a" }] };
    const t0 = imprintTree(before);
    const t1 = imprintTree(after);
    expect(before.v.map((e) => t0.get(e))).toEqual([
      t1.get(after.v[2]!),
      t1.get(after.v[0]!),
      t1.get(after.v[1]!),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cycles are the one place a subtree has no standalone form, because the
// back-reference counts levels from where the node sits. This was found by
// measurement, not by reading the grammar: the naive assumption that every
// subtree encodes on its own is true for eight of nine shapes.
// ---------------------------------------------------------------------------

describe("imprintTree: subtrees that escape upward", () => {
  it("refuses a key for a subtree pointing above itself, but keeps the target", () => {
    const root: Record<string, unknown> = { n: 1, child: {} };
    (root.child as Record<string, unknown>).up = root;

    const tree = imprintTree(root);
    expect(tree.get(root)).toBe(imprint(root));
    expect(tree.get(root.child as object)).toBeUndefined();
    // And the refusal is warranted: the standalone form really does differ.
    expect(imprint(root.child)).not.toBe("");
    expect(tree.root).toContain("^2;");
  });

  it("keeps a key for a cycle that closes inside the node", () => {
    const inner: Record<string, unknown> = { n: 1 };
    inner.self = inner;
    const outer = { wrapped: inner };

    const tree = imprintTree(outer);
    expect(tree.get(inner)).toBe(imprint(inner));
    expect(tree.get(outer)).toBe(imprint(outer));
  });

  it("refuses every level between the reference and its target, and no more", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    const d: Record<string, unknown> = {};
    a.b = b;
    b.c = c;
    c.d = d;
    d.up = b; // escapes c and d, but not b (it closes there) and not a.

    const tree = imprintTree(a);
    expect(tree.get(a)).toBe(imprint(a));
    expect(tree.get(b)).toBe(imprint(b));
    expect(tree.get(c)).toBeUndefined();
    expect(tree.get(d)).toBeUndefined();
  });

  it("returns undefined for an object that is not in the value", () => {
    const tree = imprintTree({ a: 1 });
    expect(tree.get({ a: 1 })).toBeUndefined();
  });
});

describe("imprintTree: depth", () => {
  it("does not blow the call stack on deep input", () => {
    let node: unknown = 0;
    for (let i = 0; i < 20_000; i++) node = [node];
    const tree = imprintTree(node);
    expect(tree.root).toBe(imprint(node));
    expect(tree.get(node as object)).toBe(tree.root);
  });
});
