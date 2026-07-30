// RFC 8785 (JSON Canonicalization Scheme), byte-exact.
//
// This mode exists for interoperability: the bytes it produces are the bytes a
// JCS implementation in Go, Java or Python produces for the same JSON document,
// which is what makes a signature verifiable across languages. It is table
// stakes rather than the point of this library, because in JavaScript most of
// the specification comes for free:
//
//   - Numbers. The RFC defines number serialization as the ECMAScript
//     Number::toString algorithm, which is exactly what `JSON.stringify`
//     already implements. Implementing JCS in Go or Java means implementing
//     Ryu; here it is a delegation.
//   - Key order. The RFC sorts property names by UTF-16 **code unit**, and
//     JavaScript's default string comparison is code-unit order, so a plain
//     `.sort()` is correct. Note this is *not* code-point order: U+1F602 must
//     sort before U+FB33 because its first code unit is 0xD83D, and an
//     implementation that sorts by code point gets that pair backwards.
//   - String escaping. The RFC defers to the ECMAScript `JSON.stringify`
//     escaping rules.
//
// What is NOT free, and is why this file is 200 lines rather than 20: the
// traversal is iterative. Every other implementation measured is recursive and
// dies with a RangeError somewhere between 1,800 and 5,900 levels of nesting.
// Anything doing content addressing eats untrusted input by definition, and
// "send a deeply nested document" is the cheapest denial of service there is.

import { UnrepresentableValueError, type JcsOptions } from "./types.js";

/** Ops on the explicit traversal stack, in place of recursion. */
type Op =
  | { k: 0; v: unknown; p: string; key: string } // visit a value
  | { k: 1; s: string }                          // emit a literal
  | { k: 2; o: object };                         // leave a container

/** `true` for values RFC 8785 has no representation for. */
function unrepresentable(v: unknown): string | null {
  const t = typeof v;
  if (t === "bigint") return "BigInt";
  if (t === "function") return "function";
  if (t === "symbol") return "symbol";
  if (t === "undefined") return "undefined";
  if (t === "number" && !Number.isFinite(v as number)) {
    return Number.isNaN(v as number) ? "NaN" : String(v);
  }
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (v instanceof WeakMap) return "WeakMap";
  if (v instanceof WeakSet) return "WeakSet";
  if (ArrayBuffer.isView(v)) return v.constructor.name;
  if (v instanceof ArrayBuffer) return "ArrayBuffer";
  return null;
}

/** Values `JSON.stringify` drops from objects and turns into null in arrays. */
function isElided(v: unknown): boolean {
  const t = typeof v;
  return t === "undefined" || t === "function" || t === "symbol";
}

/**
 * Canonicalize a value per RFC 8785.
 *
 * Throws {@link UnrepresentableValueError} for values the format cannot
 * express, unless `unrepresentable: "json"` is set. Throws on circular
 * references always: JSON has no cycles, and inventing a representation for one
 * would break the cross-language agreement this mode exists to provide.
 */
export function jcs(value: unknown, options: JcsOptions = {}): string {
  const strict = (options.unrepresentable ?? "throw") === "throw";
  const out: string[] = [];
  const open = new Set<object>();
  const stack: Op[] = [{ k: 0, v: value, p: "", key: "" }];

  // Children are pushed in reverse so that popping yields document order.
  const pushAll = (ops: Op[]): void => {
    for (let i = ops.length - 1; i >= 0; i--) stack.push(ops[i]!);
  };

  while (stack.length > 0) {
    const op = stack.pop()!;

    if (op.k === 1) {
      out.push(op.s);
      continue;
    }
    if (op.k === 2) {
      open.delete(op.o);
      continue;
    }

    let v = op.v;

    // toJSON first, matching JSON.stringify: it is how Date becomes an ISO
    // string, and how user types opt into a JSON representation.
    if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
      if (open.has(v as object)) {
        throw new UnrepresentableValueError("circular reference", op.p);
      }
      v = (v as { toJSON: (key: string) => unknown }).toJSON(op.key);
    }

    if (v === null) {
      out.push("null");
      continue;
    }

    const bad = unrepresentable(v);
    if (bad !== null) {
      if (strict) {
        throw new UnrepresentableValueError(`${bad} has no RFC 8785 representation`, op.p);
      }
      // Lossy JSON.stringify-compatible fallbacks. BigInt has no fallback:
      // JSON.stringify throws on it too, so there is nothing to be compatible
      // with.
      if (typeof v === "bigint") {
        throw new UnrepresentableValueError("BigInt has no RFC 8785 representation", op.p);
      }
      if (typeof v === "number") {
        out.push("null"); // NaN and Infinity, as JSON.stringify does
        continue;
      }
      // Map, Set, TypedArray and friends fall through and serialize as ordinary
      // objects over their own enumerable keys, which is precisely the silent
      // collapse this library exists to avoid. Reachable only on request.
    }

    switch (typeof v) {
      case "boolean":
        out.push(v ? "true" : "false");
        continue;
      case "number":
        // Finite by now. JSON.stringify implements Number::toString, which is
        // what the RFC requires, including -0 serializing as 0.
        out.push(JSON.stringify(v) as string);
        continue;
      case "string":
        out.push(JSON.stringify(v) as string);
        continue;
    }

    // Containers.
    const obj = v as object;
    if (open.has(obj)) {
      throw new UnrepresentableValueError("circular reference", op.p);
    }
    open.add(obj);

    if (Array.isArray(v)) {
      out.push("[");
      const ops: Op[] = [];
      for (let i = 0; i < v.length; i++) {
        if (i > 0) ops.push({ k: 1, s: "," });
        const item = v[i];
        // JSON.stringify turns array holes and non-serializable slots into null.
        if (isElided(item)) ops.push({ k: 1, s: "null" });
        else ops.push({ k: 0, v: item, p: `${op.p}[${i}]`, key: String(i) });
      }
      ops.push({ k: 1, s: "]" }, { k: 2, o: obj });
      pushAll(ops);
      continue;
    }

    // Objects. Object.keys gives own enumerable string keys in the order
    // JSON.stringify would use; sorting them by code unit is the RFC's rule and
    // JavaScript's default comparison already is code-unit order.
    out.push("{");
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const ops: Op[] = [];
    let first = true;
    for (const key of keys) {
      const child = (v as Record<string, unknown>)[key];
      if (isElided(child)) continue; // JSON.stringify omits these keys entirely
      if (!first) ops.push({ k: 1, s: "," });
      first = false;
      ops.push({ k: 1, s: `${JSON.stringify(key)}:` });
      ops.push({ k: 0, v: child, p: op.p ? `${op.p}.${key}` : key, key });
    }
    ops.push({ k: 1, s: "}" }, { k: 2, o: obj });
    pushAll(ops);
  }

  // A bare `undefined`, function or symbol at the root: JSON.stringify returns
  // undefined here, which is not a string and cannot be a canonical form.
  if (out.length === 0) {
    throw new UnrepresentableValueError(
      `${typeof value} has no RFC 8785 representation`,
      "",
    );
  }

  return out.join("");
}
