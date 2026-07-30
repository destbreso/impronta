// The extended canonical form: the whole JavaScript value graph, not the JSON
// subset.
//
// The problem this solves. Every JSON-subset canonicalizer collapses the types
// JSON cannot express. `new Map([["a",1]])` and `{}` serialize identically.
// `new Uint8Array([1,2,3])` and `{0:1,1:2,2:3}` serialize identically. Nothing
// throws and nothing warns, so the cache returns an entry stored under a
// different value, or a signature verifies over data that is not what was
// signed. Silence is the failure mode.
//
// The encoding is therefore designed to be INJECTIVE BY CONSTRUCTION rather
// than by inspection. Two properties give that:
//
//   1. Every value carries a type tag, so no two types can ever produce the
//      same token. A Map is not an object, a Uint8Array is not an Int8Array.
//   2. Every variable-length payload is length-prefixed, so the grammar is
//      self-delimiting and needs no escaping. Without this, `s` + "a:b" and a
//      two-field structure could coincide; with it, a decoder always knows
//      exactly how many code units to consume, which is the same thing as
//      saying no two distinct values can share an encoding.
//
// The grammar:
//
//   undefined        u
//   null             z
//   false            f
//   true             t
//   number           n<repr>;              -0 and NaN and +/-Infinity distinct
//   bigint           i<digits>;
//   string           s<len>:<code units>
//   Date             d<time>;              invalid date -> dNaN;
//   RegExp           x<len>:<source><len>:<flags>
//   Array            a<count>:<items>
//   plain object     o<count>:<key><value>...      keys sorted by code unit
//   null-prototype   O<count>:<key><value>...
//   class instance   c<len>:<name><object body>
//   Map              m<count>:<key><value>...
//   Set              e<count>:<items>
//   TypedArray       y<len>:<name><byteLength>:<hex>
//   ArrayBuffer      B<byteLength>:<hex>
//   cycle            ^<levels up>;
//
// The traversal is iterative. Depth costs heap, not call stack, so there is no
// nesting level at which this throws RangeError.

import { UnrepresentableValueError, type ImprintOptions } from "./types.js";

type Op =
  | { k: 0; v: unknown; p: string }        // visit a value
  | { k: 1; s: string }                    // emit a literal
  | { k: 2; o: object; sort: boolean }     // close a container
  | { k: 3 }                               // begin one item
  | { k: 4 };                              // end one item

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]!];
  return s;
}

/** A string token, length-prefixed in UTF-16 code units. */
function str(s: string): string {
  return `s${s.length}:${s}`;
}

/** Raw length-prefixed text, for payloads that are not string *values*. */
function raw(s: string): string {
  return `${s.length}:${s}`;
}

function numberToken(n: number): string {
  if (Number.isNaN(n)) return "nNaN;";
  if (n === Infinity) return "nInfinity;";
  if (n === -Infinity) return "n-Infinity;";
  // -0 and 0 are distinct IEEE-754 doubles. JSON cannot say so; this can, and
  // must, because `Object.is(-0, 0)` is false and they are not the same value.
  if (Object.is(n, -0)) return "n-0;";
  // String() is the ECMAScript Number::toString algorithm: shortest round-trip.
  return `n${String(n)};`;
}

/**
 * Produce the extended canonical form of any JavaScript value.
 *
 * Throws {@link UnrepresentableValueError} only for values that have no content
 * to address: functions, symbols and the identity-only weak collections. Those
 * are not omissions, they are values whose meaning *is* their identity, and an
 * identity has no canonical form. Everything else encodes.
 *
 * Known and deliberate limits, documented rather than hidden:
 *
 *   - Symbol-keyed properties are ignored, as `Object.keys` and JSON ignore
 *     them. A symbol key cannot be content-addressed.
 *   - Two different classes that share a name encode identically. Resolving
 *     that would require identity, which is exactly what a content hash must
 *     not depend on.
 *   - A shared (non-cyclic) reference is expanded, so a diamond and its
 *     fully-expanded twin agree. Only true cycles become back-references.
 */
export function imprint(value: unknown, options: ImprintOptions = {}): string {
  return encode(value, options, false).root;
}

/**
 * The imprint of a value together with the imprint of every object inside it.
 *
 * The grammar is length-prefixed and self-delimiting, which has a consequence
 * worth naming: a container's token is its header followed by its children's
 * tokens verbatim, so every subtree already carries a complete canonical form
 * of its own. This exposes it. One traversal annotates the whole graph, and
 * afterwards structural equality of any two nodes, from any two values, is a
 * string comparison.
 *
 * That is the property a structural diff needs. Two nodes with equal imprints
 * are the same value, so a diff can stop descending; two nodes with different
 * imprints differ somewhere, so a diff must. Neither direction can be wrong,
 * because the encoding is injective. It also supplies a content identity for
 * arrays of objects, which is what move detection otherwise asks the caller to
 * hand-write as an `objectHash`.
 *
 * Cost: {@link imprint} is linear, this is not. Producing a string per node
 * costs the sum of all subtree lengths, so O(n * depth) in time and memory.
 * For ordinary documents, which are wide and shallow, that is a small constant.
 * For a pathologically deep one it is not, and {@link imprint} remains the
 * right call when only the root form is wanted.
 */
export function imprintTree(value: unknown, options: ImprintOptions = {}): ImprintTree {
  const { root, nodes, escaping } = encode(value, options, true);
  return {
    root,
    get(node: object): string | undefined {
      return escaping.has(node) ? undefined : nodes.get(node);
    },
  };
}

/** The result of {@link imprintTree}. */
export interface ImprintTree {
  /** The imprint of the whole value. Identical to `imprint(value)`. */
  readonly root: string;
  /**
   * The imprint of one object inside the value, or `undefined` if it has none.
   *
   * A node has no standalone imprint in exactly one situation: something inside
   * it is a back-reference to an ancestor *above* it. A cycle is encoded as the
   * number of levels to climb, which is a statement about where the node sits,
   * so such a subtree does not mean the same thing anywhere else and refusing
   * to give it a content key is the only honest answer. A cycle contained
   * entirely within the node is fine and gets an imprint like anything else.
   *
   * `undefined` also comes back for an object that is not in this value at all,
   * and for one that was never reached, such as a symbol-keyed property.
   */
  get(node: object): string | undefined;
}

interface Encoded {
  root: string;
  nodes: WeakMap<object, string>;
  escaping: WeakSet<object>;
}

function encode(value: unknown, options: ImprintOptions, tree: boolean): Encoded {
  const sortCollections = (options.order ?? "insertion") === "sorted";

  // Populated only in tree mode. In the default mode both stay empty and the
  // walk below is byte for byte the same work it has always done.
  const nodes = new WeakMap<object, string>();
  const escaping = new WeakSet<object>();
  // open[d] is the container currently open at depth d, so a back-reference
  // can name every subtree it escapes from without searching for them.
  const open: object[] = [];

  // Output buffers. Almost everything appends straight to the root buffer in
  // document order; a buffer is pushed ONLY for a container that has to sort,
  // and for each of that container's direct children.
  //
  // The first version buffered every item, which made the whole thing
  // quadratic: closing an item joins its parts into one string, so a chain of
  // depth n copied the entire deeper encoding once per level. An iterative
  // kernel that is O(n^2) in depth has not removed the denial-of-service
  // surface, it has moved it from the call stack to the clock. Buffering only
  // where sorting genuinely requires it keeps the common path linear.
  const acc: string[][] = [[]];
  // One frame per open SORTING container, collecting children as whole items.
  const frames: { items: string[] }[] = [];

  const ancestors = new Map<object, number>();
  let depth = 0;

  const emit = (s: string): void => {
    acc[acc.length - 1]!.push(s);
  };

  /** Emit an object whose whole token is one string, recording it in tree mode. */
  const leaf = (o: object, token: string): void => {
    if (tree) nodes.set(o, token);
    emit(token);
  };

  const stack: Op[] = [{ k: 0, v: value, p: "" }];
  const pushAll = (ops: Op[]): void => {
    for (let i = ops.length - 1; i >= 0; i--) stack.push(ops[i]!);
  };

  /** Wrap a child's ops so the container sees it as one sortable unit. */
  const item = (ops: Op[]): Op[] => [{ k: 3 }, ...ops, { k: 4 }];

  while (stack.length > 0) {
    const op = stack.pop()!;

    if (op.k === 1) {
      emit(op.s);
      continue;
    }
    if (op.k === 3) {
      acc.push([]);
      continue;
    }
    if (op.k === 4) {
      frames[frames.length - 1]!.items.push(acc.pop()!.join(""));
      continue;
    }
    if (op.k === 2) {
      if (op.sort) {
        const frame = frames.pop()!;
        frame.items.sort();
        emit(frame.items.join(""));
      }
      if (tree) {
        // The node's own buffer holds its header and every child token, in
        // final order. Joining it here is what makes the subtree addressable,
        // and it is also the whole reason tree mode is not linear.
        const token = acc.pop()!.join("");
        nodes.set(op.o, token);
        emit(token);
      }
      ancestors.delete(op.o);
      depth--;
      continue;
    }

    const v = op.v;

    // ---------------------------------------------------------- primitives
    if (v === null) { emit("z"); continue; }
    if (v === undefined) { emit("u"); continue; }

    switch (typeof v) {
      case "boolean": emit(v ? "t" : "f"); continue;
      case "number": emit(numberToken(v)); continue;
      case "bigint": emit(`i${v.toString()};`); continue;
      case "string": emit(str(v)); continue;
      case "symbol":
        throw new UnrepresentableValueError(
          "a symbol is an identity, not content, and has no canonical form",
          op.p,
        );
      case "function":
        throw new UnrepresentableValueError(
          "a function has no canonical form",
          op.p,
        );
    }

    const obj = v as object;

    // ------------------------------------------------------------- cycles
    const seenAt = ancestors.get(obj);
    if (seenAt !== undefined) {
      // Levels up rather than an absolute index, so the reference does not
      // depend on where in the document the cycle happens to appear, and stays
      // valid when a container reorders its children.
      emit(`^${depth - seenAt};`);
      // Every open container below the target now contains a reference that
      // points outside itself, which is precisely the set of subtrees whose
      // encoding depends on where they sit. The target itself is unaffected:
      // the cycle closes inside it.
      if (tree) for (let d = seenAt + 1; d < depth; d++) escaping.add(open[d]!);
      continue;
    }

    // ------------------------------------------------- leaf-like exotic types
    if (v instanceof Date) {
      const time = v.getTime();
      leaf(v, `d${Number.isNaN(time) ? "NaN" : String(time)};`);
      continue;
    }
    if (v instanceof RegExp) {
      leaf(v, `x${raw(v.source)}${raw(v.flags)}`);
      continue;
    }
    if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      // The constructor name is part of the encoding: Uint8Array and Int8Array
      // over identical bytes are different values.
      leaf(v, `y${raw(v.constructor.name)}${bytes.length}:${toHex(bytes)}`);
      continue;
    }
    if (v instanceof ArrayBuffer) {
      const bytes = new Uint8Array(v);
      leaf(v, `B${bytes.length}:${toHex(bytes)}`);
      continue;
    }
    if (v instanceof WeakMap || v instanceof WeakSet || v instanceof WeakRef) {
      throw new UnrepresentableValueError(
        `${v.constructor.name} holds identities, not content, and has no canonical form`,
        op.p,
      );
    }
    if (v instanceof Promise) {
      throw new UnrepresentableValueError(
        "a Promise has no canonical form: its value does not exist yet",
        op.p,
      );
    }

    // ---------------------------------------------------------- containers
    ancestors.set(obj, depth);
    if (tree) {
      open[depth] = obj;
      // Its own buffer, so the close op can join a complete token. The default
      // mode deliberately does not do this: buffering every level is what made
      // an earlier version quadratic, and it is a cost only tree mode needs.
      acc.push([]);
    }
    depth++;

    if (v instanceof Map) {
      emit(`m${v.size}:`);
      if (sortCollections) frames.push({ items: [] });
      const ops: Op[] = [];
      let i = 0;
      for (const [k, val] of v) {
        // Key and value form ONE item, so sorting can never separate a key from
        // its value. Sorting them independently would not merely reorder the
        // output, it would rewrite the data.
        const pair: Op[] = [
          { k: 0, v: k, p: `${op.p}<key ${i}>` },
          { k: 0, v: val, p: `${op.p}<value ${i}>` },
        ];
        ops.push(...(sortCollections ? item(pair) : pair));
        i++;
      }
      ops.push({ k: 2, o: obj, sort: sortCollections });
      pushAll(ops);
      continue;
    }

    if (v instanceof Set) {
      emit(`e${v.size}:`);
      if (sortCollections) frames.push({ items: [] });
      const ops: Op[] = [];
      let i = 0;
      for (const member of v) {
        const one: Op[] = [{ k: 0, v: member, p: `${op.p}<member ${i}>` }];
        ops.push(...(sortCollections ? item(one) : one));
        i++;
      }
      ops.push({ k: 2, o: obj, sort: sortCollections });
      pushAll(ops);
      continue;
    }

    // Arrays never sort: element order IS the value. So no buffering.
    if (Array.isArray(v)) {
      emit(`a${v.length}:`);
      const ops: Op[] = [];
      for (let i = 0; i < v.length; i++) {
        // A hole is not an explicit undefined at the language level, but both
        // read as undefined and neither carries content, so both encode as `u`.
        ops.push({ k: 0, v: v[i], p: `${op.p}[${i}]` });
      }
      ops.push({ k: 2, o: obj, sort: false });
      pushAll(ops);
      continue;
    }

    // Plain objects, null-prototype objects and class instances.
    const proto = Object.getPrototypeOf(v) as object | null;
    const ctorName =
      proto === null || proto === Object.prototype
        ? null
        : (v.constructor?.name ?? "");

    // Keys are sorted here, up front, so the container never needs buffering:
    // object key order is not part of the value, and JCS agrees.
    const keys = Object.keys(v as Record<string, unknown>).sort();
    if (ctorName !== null) emit(`c${raw(ctorName)}`);
    emit(`${proto === null ? "O" : "o"}${keys.length}:`);

    const ops: Op[] = [];
    for (const key of keys) {
      ops.push(
        { k: 1, s: str(key) },
        { k: 0, v: (v as Record<string, unknown>)[key], p: op.p ? `${op.p}.${key}` : key },
      );
    }
    ops.push({ k: 2, o: obj, sort: false });
    pushAll(ops);
  }

  return { root: acc[0]!.join(""), nodes, escaping };
}
