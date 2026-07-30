import { describe, expect, it } from "vitest";
import { RFC8785_VECTORS } from "serializer-conformance";
import { canonicalize, digest, imprint, jcs, UnrepresentableValueError } from "../src/index.js";

class Point {
  constructor(public x: number, public y: number) {}
}
class Vector {
  constructor(public x: number, public y: number) {}
}

// ---------------------------------------------------------------------------
// RFC 8785. The one part with an external authority to check against.
// ---------------------------------------------------------------------------

describe("jcs: RFC 8785 conformance", () => {
  for (const vector of RFC8785_VECTORS) {
    it(`matches the official "${vector.name}" vector byte for byte`, () => {
      expect(jcs(JSON.parse(vector.input))).toBe(vector.expected);
    });
  }

  it("sorts by UTF-16 code unit, not code point", () => {
    // The discriminating case. U+1F602 has first code unit 0xD83D, which is
    // below 0xFB33, so it sorts first. By code point it would sort last.
    const out = jcs({ "\u{1f602}": 1, "דּ": 2, "€": 3 });
    expect(out).toBe('{"€":3,"\u{1f602}":1,"דּ":2}');
  });

  it("does not normalize Unicode", () => {
    const decomposed = jcs({ v: "Å" });
    const precomposed = jcs({ v: "Å" });
    expect(decomposed).not.toBe(precomposed);
  });

  it("serializes numbers with the ES6 algorithm", () => {
    expect(jcs({ v: 1e21 })).toBe('{"v":1e+21}');
    expect(jcs({ v: 4.5 })).toBe('{"v":4.5}');
    expect(jcs({ v: 2e-3 })).toBe('{"v":0.002}');
    expect(jcs({ v: 100.0 })).toBe('{"v":100}');
    expect(jcs({ v: -0 })).toBe('{"v":0}'); // JSON cannot express -0; JCS says 0
  });
});

describe("jcs: what it refuses", () => {
  it("refuses values RFC 8785 cannot represent, and says where", () => {
    for (const [label, value] of [
      ["NaN", { a: { b: NaN } }],
      ["Infinity", { a: { b: Infinity } }],
      ["BigInt", { a: { b: 1n } }],
      ["Map", { a: { b: new Map() } }],
      ["Set", { a: { b: new Set() } }],
      ["Uint8Array", { a: { b: new Uint8Array() } }],
    ] as const) {
      const run = () => jcs(value);
      expect(run, label).toThrow(UnrepresentableValueError);
      try { run(); } catch (err) {
        expect((err as UnrepresentableValueError).path, label).toBe("a.b");
      }
    }
  });

  it("refuses circular references", () => {
    const o: Record<string, unknown> = { a: 1 };
    o["self"] = o;
    expect(() => jcs(o)).toThrow(/circular/);
  });

  it("refuses a bare undefined at the root", () => {
    expect(() => jcs(undefined)).toThrow(UnrepresentableValueError);
  });

  it('applies JSON.stringify coercions under unrepresentable:"json"', () => {
    expect(jcs({ v: NaN }, { unrepresentable: "json" })).toBe('{"v":null}');
    expect(jcs({ v: new Map([["a", 1]]) }, { unrepresentable: "json" })).toBe('{"v":{}}');
  });

  it("honours toJSON, like JSON.stringify", () => {
    expect(jcs({ v: new Date(0) })).toBe('{"v":"1970-01-01T00:00:00.000Z"}');
    expect(jcs({ v: { toJSON: () => ({ b: 1, a: 2 }) } })).toBe('{"v":{"a":2,"b":1}}');
  });
});

// ---------------------------------------------------------------------------
// Injectivity. The whole promise of the package in one property.
// ---------------------------------------------------------------------------

describe("imprint: injectivity", () => {
  /**
   * A corpus of pairwise-distinct values. Every pair in here is genuinely two
   * different values, so every pair must produce two different imprints. This
   * is the single most important test in the package: a collision is silent at
   * the call site, so it can only ever be caught here.
   */
  const corpus: Array<[string, () => unknown]> = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["false", () => false],
    ["true", () => true],
    ["zero", () => 0],
    ["minus zero", () => -0],
    ["one", () => 1],
    ["NaN", () => NaN],
    ["Infinity", () => Infinity],
    ["-Infinity", () => -Infinity],
    ["bigint 1", () => 1n],
    ["bigint 0", () => 0n],
    ["string 1", () => "1"],
    ["string empty", () => ""],
    ["string null", () => "null"],
    ["string of the number", () => "0"],
    ["array empty", () => []],
    ["array [1]", () => [1]],
    ["array [1,2]", () => [1, 2]],
    ["array [2,1]", () => [2, 1]],
    ["object empty", () => ({})],
    ["object {a:1}", () => ({ a: 1 })],
    ["object {a:2}", () => ({ a: 2 })],
    ["object {b:1}", () => ({ b: 1 })],
    ["object {a:1,b:2}", () => ({ a: 1, b: 2 })],
    ["null-prototype empty", () => Object.create(null) as object],
    ["null-prototype {a:1}", () => Object.assign(Object.create(null), { a: 1 }) as object],
    ["map empty", () => new Map()],
    ["map {a:1}", () => new Map([["a", 1]])],
    ["map {a:2}", () => new Map([["a", 2]])],
    ["map {a:1,b:2}", () => new Map([["a", 1], ["b", 2]])],
    ["map {b:2,a:1} other order", () => new Map([["b", 2], ["a", 1]])],
    ["set empty", () => new Set()],
    ["set {1}", () => new Set([1])],
    ["set {1,2}", () => new Set([1, 2])],
    ["set {2,1} other order", () => new Set([2, 1])],
    ["uint8 [1,2,3]", () => new Uint8Array([1, 2, 3])],
    ["int8 [1,2,3]", () => new Int8Array([1, 2, 3])],
    ["uint8 [1,2]", () => new Uint8Array([1, 2])],
    ["uint16 [1,2,3]", () => new Uint16Array([1, 2, 3])],
    ["index object", () => ({ 0: 1, 1: 2, 2: 3 })],
    ["arraybuffer 3", () => new Uint8Array([1, 2, 3]).buffer],
    ["date epoch", () => new Date(0)],
    ["date one", () => new Date(1)],
    ["date invalid", () => new Date(NaN)],
    ["date as string", () => "1970-01-01T00:00:00.000Z"],
    ["regexp ab", () => /ab/],
    ["regexp ab gi", () => /ab/gi],
    ["regexp ac", () => /ac/],
    ["class Point", () => new Point(1, 2)],
    ["class Vector, same shape", () => new Vector(1, 2)],
    ["plain twin of Point", () => ({ x: 1, y: 2 })],
    ["nested a", () => ({ a: { b: 1 } })],
    ["nested b", () => ({ a: { b: 2 } })],
    // Grammar-ambiguity probes. Each is a value whose *content* looks like the
    // encoding's own punctuation, which is what the length prefixes exist to
    // defuse. Without them, a key containing a delimiter could imitate a
    // different structure.
    ["key containing the delimiters", () => ({ "a:1,b": 2 })],
    ["length prefix probe 1", () => ["s1", ":a"]],
    ["length prefix probe 2", () => ["s1:a"]],
  ];

  it("gives every distinct value a distinct imprint", () => {
    const seen = new Map<string, string>();
    for (const [label, make] of corpus) {
      const out = imprint(make());
      const previous = seen.get(out);
      expect(
        previous,
        `COLLISION: "${label}" and "${previous}" both imprint to ${JSON.stringify(out)}`,
      ).toBeUndefined();
      seen.set(out, label);
    }
    expect(seen.size).toBe(corpus.length);
  });

  it("gives equal values equal imprints, built twice", () => {
    // The other identity failure: an implementation keyed on object identity
    // passes every collision test and is still useless as a content hash.
    for (const [label, make] of corpus) {
      expect(imprint(make()), label).toBe(imprint(make()));
    }
  });

  it("is stable across insertion order of plain object keys", () => {
    expect(imprint({ a: 1, b: 2 })).toBe(imprint({ b: 2, a: 1 }));
  });

  it("distinguishes a Map from a plain object with the same entries", () => {
    expect(imprint(new Map([["a", 1]]))).not.toBe(imprint({ a: 1 }));
  });

  it("reflects a change to Map content", () => {
    const m = new Map<string, number>([["a", 1]]);
    const before = imprint(m);
    m.set("b", 2);
    expect(imprint(m)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Ordering semantics, the one genuinely debatable design choice.
// ---------------------------------------------------------------------------

describe("imprint: collection ordering", () => {
  it("preserves Map and Set order by default", () => {
    expect(imprint(new Map([["a", 1], ["b", 2]])))
      .not.toBe(imprint(new Map([["b", 2], ["a", 1]])));
    expect(imprint(new Set([1, 2]))).not.toBe(imprint(new Set([2, 1])));
  });

  it('collapses order under order:"sorted"', () => {
    const opts = { order: "sorted" } as const;
    expect(imprint(new Map([["a", 1], ["b", 2]]), opts))
      .toBe(imprint(new Map([["b", 2], ["a", 1]]), opts));
    expect(imprint(new Set([1, 2]), opts)).toBe(imprint(new Set([2, 1]), opts));
  });

  it("never lets sorting separate a Map key from its value", () => {
    // Sorting operates on whole entries. If it sorted keys and values
    // independently, these two would converge, which would be a data-corrupting
    // collision rather than a merely surprising one.
    const opts = { order: "sorted" } as const;
    expect(imprint(new Map([["a", 1], ["b", 2]]), opts))
      .not.toBe(imprint(new Map([["a", 2], ["b", 1]]), opts));
  });

  it("never sorts arrays: order is part of the value", () => {
    const opts = { order: "sorted" } as const;
    expect(imprint([1, 2], opts)).not.toBe(imprint([2, 1], opts));
  });
});

// ---------------------------------------------------------------------------
// Structure: cycles, sharing, and what has no content to address.
// ---------------------------------------------------------------------------

describe("imprint: structure", () => {
  it("encodes a cycle instead of throwing or hanging", () => {
    const o: Record<string, unknown> = { a: 1 };
    o["self"] = o;
    expect(imprint(o)).toContain("^");
  });

  it("distinguishes a self-cycle from a two-step cycle", () => {
    const a: Record<string, unknown> = {};
    a["next"] = a;
    const b: Record<string, unknown> = {};
    const c: Record<string, unknown> = { next: b };
    b["next"] = c;
    expect(imprint(a)).not.toBe(imprint(b));
  });

  it("expands a shared reference, so a diamond equals its expanded twin", () => {
    const leaf = { v: 1 };
    expect(imprint({ l: leaf, r: leaf })).toBe(imprint({ l: { v: 1 }, r: { v: 1 } }));
  });

  it("refuses values whose meaning is their identity", () => {
    expect(() => imprint(Symbol("s"))).toThrow(UnrepresentableValueError);
    expect(() => imprint(() => 1)).toThrow(UnrepresentableValueError);
    expect(() => imprint(new WeakMap())).toThrow(UnrepresentableValueError);
    expect(() => imprint(Promise.resolve(1))).toThrow(UnrepresentableValueError);
  });

  it("reports the path of the offending value", () => {
    try {
      imprint({ a: { b: [1, Symbol("s")] } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as UnrepresentableValueError).path).toBe("a.b[1]");
    }
  });

  it("ignores symbol-keyed properties, as Object.keys does", () => {
    expect(imprint({ [Symbol("s")]: 1, b: 2 })).toBe(imprint({ b: 2 }));
  });
});

// ---------------------------------------------------------------------------
// Depth. The differentiator that is pure implementation, not semantics.
// ---------------------------------------------------------------------------

describe("depth", () => {
  function nest(depth: number): unknown {
    let o: unknown = { leaf: 1 };
    for (let i = 0; i < depth; i++) o = { a: o };
    return o;
  }

  it("survives nesting that overflows every recursive implementation", () => {
    // Measured ceilings of the incumbents run from ~1,800 to ~5,900. 200,000 is
    // far past all of them and past any engine stack.
    expect(() => imprint(nest(200_000))).not.toThrow();
    expect(() => jcs(nest(200_000))).not.toThrow();
  });

  it("still produces the right answer at depth, not just a non-throw", () => {
    // A kernel that silently truncated deep input would pass the test above.
    const deep = jcs(nest(50_000));
    expect(deep.startsWith('{"a":'.repeat(100))).toBe(true);
    expect(deep.endsWith('{"leaf":1}' + "}".repeat(50_000))).toBe(true);
  });

  it("stays roughly linear in depth, not quadratic", () => {
    // Regression guard with teeth. The first kernel was iterative and still
    // quadratic: it buffered every item, so closing a level copied the whole
    // deeper encoding, once per level. It passed every correctness test and
    // took 26 seconds, which is not a failed assertion but is still a denial of
    // service, moved from the call stack to the clock.
    //
    // Timing assertions are flaky by nature, so this one is deliberately loose:
    // it compares a ratio rather than an absolute, and allows 4x slack over the
    // linear expectation. The quadratic version was ~100x over.
    const time = (depth: number): number => {
      const value = nest(depth);
      const started = performance.now();
      imprint(value);
      return performance.now() - started;
    };

    time(20_000); // warm up, so JIT compilation is not charged to the first run
    const small = Math.max(time(20_000), 0.5); // floor: avoid dividing by ~0
    const large = time(80_000);

    // 4x the input should cost about 4x the time. Quadratic would be ~16x.
    expect(large / small).toBeLessThan(16);
  });

  it("handles a wide value too, not only a deep one", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
    expect(imprint(wide).length).toBeGreaterThan(50_000);
  });
});

// ---------------------------------------------------------------------------
// The digest layer.
// ---------------------------------------------------------------------------

describe("digest", () => {
  it("hashes the canonical form, matching an independently computed SHA-256", async () => {
    // Anchored to a value computed from the canonical string by node:crypto,
    // so the test would catch a change in either the encoding or the hashing.
    const { createHash } = await import("node:crypto");
    const value = { b: 1, a: [1, 2, { c: 3 }] };
    const expected = createHash("sha256").update(imprint(value), "utf8").digest("hex");
    await expect(digest(value)).resolves.toBe(expected);
  });

  it("hashes the JCS form under mode:jcs", async () => {
    const { createHash } = await import("node:crypto");
    const value = { b: 1, a: 2 };
    const expected = createHash("sha256").update(jcs(value), "utf8").digest("hex");
    await expect(digest(value, { mode: "jcs" })).resolves.toBe(expected);
  });

  it("supports the other algorithms and encodings", async () => {
    const value = { a: 1 };
    await expect(digest(value, { algorithm: "SHA-512" })).resolves.toHaveLength(128);
    const bytes = await digest(value, { encoding: "bytes" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    const b64 = await digest(value, { encoding: "base64url" });
    expect(b64).not.toMatch(/[+/=]/);
  });

  it("gives different digests to the values that must stay apart", async () => {
    const a = await digest(new Map([["a", 1]]));
    const b = await digest({ a: 1 });
    expect(a).not.toBe(b);
  });

  it("canonicalize() exposes the string behind the digest", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(imprint({ b: 1, a: 2 }));
    expect(canonicalize({ b: 1, a: 2 }, { mode: "jcs" })).toBe('{"a":2,"b":1}');
  });
});
