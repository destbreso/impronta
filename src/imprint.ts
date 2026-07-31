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

// One shape for every entry on the work stack, rather than five.
//
// `k` selects the meaning of the rest, and the fields that do not apply are
// left null. Five different object shapes made every `op.k` read polymorphic,
// and the stack is the hottest loop in the library.
//
//   k=0  visit `v`, after emitting the literal `s` (its key token, or "")
//   k=1  emit the literal `s`
//   k=2  close container `o`, sorting its buffered items if `sort`
//   k=3  begin one sortable item
//   k=4  end one sortable item
interface Op {
  k: 0 | 1 | 2 | 3 | 4;
  v: unknown;
  s: string;
  o: object | null;
  sort: boolean;
  /**
   * Where this value sits, for an error message and nothing else.
   *
   * A parent link and one raw segment, never a built string. Composing the
   * path eagerly cost 15% of every run to produce text that is read only when
   * a value turns out to have no canonical form, which for almost every caller
   * is never. {@link formatPath} walks this chain on the way out of a throw.
   */
  par: Op | null;
  seg: string | number;
  segKind: SegKind;
  /** k=2 only: which span slot this container claimed when it opened. */
  slot: number;
}

const enum SegKind { Root, Key, Index, MapKey, MapValue, SetMember }

function op(k: Op["k"], v: unknown, s: string, par: Op | null, seg: string | number, segKind: SegKind): Op {
  return { k, v, s, o: null, sort: false, par, seg, segKind, slot: -1 };
}

/** Rebuild the human-readable path to a value, on the error path only. */
function formatPath(node: Op | null): string {
  if (node === null) return "";
  const parent = formatPath(node.par);
  switch (node.segKind) {
    case SegKind.Root: return "";
    case SegKind.Key: return parent ? `${parent}.${node.seg as string}` : (node.seg as string);
    case SegKind.Index: return `${parent}[${node.seg}]`;
    case SegKind.MapKey: return `${parent}<key ${node.seg}>`;
    case SegKind.MapValue: return `${parent}<value ${node.seg}>`;
    case SegKind.SetMember: return `${parent}<member ${node.seg}>`;
  }
}

/**
 * The token for a value that has no children, or null if it needs the walk.
 *
 * This is what lets a run of primitive siblings collapse into one string
 * instead of one stack entry each. An array of five thousand numbers used to
 * allocate five thousand work items to emit five thousand short strings; now it
 * allocates one.
 *
 * Symbols and functions deliberately return null. They have no canonical form
 * and must throw, and the throw needs the position, so they take the slow path
 * where a stack entry carries the parent link.
 */
function primitiveToken(v: unknown): string | null {
  if (v === null) return "z";
  switch (typeof v) {
    case "undefined": return "u";
    case "boolean": return v ? "t" : "f";
    case "number": return numberToken(v);
    case "bigint": return `i${v.toString()};`;
    case "string": return str(v);
    default: return null;
  }
}

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
 * Cost: linear, in the default insertion order. A node's token is a CONTIGUOUS
 * range of the root, because the grammar is self-delimiting and nothing is
 * interleaved, so this records a start and a length per node instead of a
 * string per node. The earlier version materialized every token, which cost the
 * sum of all subtree lengths: O(n * depth) in time and memory, invisible on the
 * wide shallow documents everybody tests with and fatal on a deep one, where a
 * 160 KB chain of nested objects reached 2.6 GB of heap.
 *
 * `order: "sorted"` still materializes. Sorting reorders a container's items at
 * close, so a child's token is no longer where the walk emitted it, and offsets
 * into the root would point at the wrong text. That path keeps the old cost.
 *
 * Prefer {@link ImprintTree.sameAs} over comparing two {@link ImprintTree.get}
 * results. `get` has to build the string; `sameAs` does not, and it answers in
 * constant time unless the two really are equal.
 */
export function imprintTree(value: unknown, options: ImprintOptions = {}): ImprintTree {
  const { root, nodes, escaping, slotOf, starts, lengths, claimed, addressable } = encode(value, options, true);
  const spanStarts = starts();
  const spanLengths = lengths();

  // Materialize every token, but only when that is affordable.
  //
  // Two representations, and neither wins everywhere. Holding a string per node
  // makes comparison a native string equality, which V8 does with a length
  // check and a memcmp and which nothing written in JavaScript comes close to.
  // It also costs the sum of all subtree lengths, which on a wide shallow
  // document is a small multiple of the document and on a deep one is
  // quadratic: that is what made a 160 KB chain cost 2.6 GB.
  //
  // The offsets pass above already knows every node's length, so the sum is
  // free to compute and the choice can be made on the real number rather than
  // on a guess about the shape. Shallow documents get the fast comparison,
  // deep ones stay linear, and nothing has to be assumed about either.
  let materialized: WeakMap<object, string> | null = null;
  if (addressable) {
    let total = 0;
    for (let i = 0; i < claimed.length; i++) total += spanLengths[i]!;
    if (total <= Math.min(root.length * 16, 64_000_000)) {
      materialized = new WeakMap<object, string>();
      for (let i = 0; i < claimed.length; i++) {
        const at = spanStarts[i]!;
        materialized.set(claimed[i]!, root.slice(at, at + spanLengths[i]!));
      }
    }
  }
  const stored = materialized;

  // Hashing a range, by direct scan at first and from a prefix table later.
  //
  // The table answers in constant time but costs two Uint32Arrays the length of
  // the whole root, and on a wide shallow document only a couple of nodes are
  // ever long enough to be hashed at all: building it for them cost more than
  // it saved and showed up as 9% of a diff plus a third more collector time.
  // On a deep document every node is hashed and the table is essential. So the
  // first few hashes are scanned directly and the table appears only if the
  // caller keeps asking. Both routes compute the same polynomial, so a value
  // hashed before the switch still matches one hashed after.
  let prefix: Prefix | null = null;
  let hashes = 0;
  const PREFIX_AFTER = 32;
  const hashRange = (at: number, length: number): number => {
    if (prefix !== null) return rangeHash(prefix, at, length);
    if (++hashes >= PREFIX_AFTER) {
      prefix = buildPrefix(root);
      return rangeHash(prefix, at, length);
    }
    let acc = 0;
    for (let i = 0; i < length; i++) acc = (Math.imul(acc, HASH_BASE) + root.charCodeAt(at + i)) >>> 0;
    return acc;
  };

  const core: TreeCore = {
    root,
    addressable: addressable && stored === null,
    startOf: (node) => {
      if (escaping.has(node)) return undefined;
      const slot = slotOf(node);
      return slot === undefined ? undefined : spanStarts[slot];
    },
    lengthOf: (node) => {
      if (escaping.has(node)) return undefined;
      const slot = slotOf(node);
      return slot === undefined ? undefined : spanLengths[slot];
    },
    text: (node) => (escaping.has(node) ? undefined : (stored ?? nodes).get(node)),
    hashRange,
  };

  const tree: ImprintTree = {
    root,
    get(node: object): string | undefined {
      if (escaping.has(node)) return undefined;
      if (!addressable) return nodes.get(node);
      if (stored !== null) return stored.get(node);
      const slot = slotOf(node);
      if (slot === undefined) return undefined;
      return root.slice(spanStarts[slot], spanStarts[slot]! + spanLengths[slot]!);
    },
    sameAs(node: object, other: ImprintTree, otherNode: object): boolean {
      const right = CORES.get(other);
      return right === undefined ? false : sameContent(core, node, right, otherNode);
    },
    size(node: object): number | undefined {
      if (escaping.has(node)) return undefined;
      if (!addressable) return nodes.get(node)?.length;
      const slot = slotOf(node);
      return slot === undefined ? undefined : spanLengths[slot];
    },
    keyWithin(node: object, inlineLimit: number): string | number | undefined {
      if (escaping.has(node)) return undefined;
      if (stored !== null) {
        const text = stored.get(node);
        if (text === undefined) return undefined;
        return text.length <= inlineLimit ? text : hashString(text);
      }
      if (!addressable) {
        const text = nodes.get(node);
        if (text === undefined) return undefined;
        return text.length <= inlineLimit ? text : hashString(text);
      }
      const slot = slotOf(node);
      if (slot === undefined) return undefined;
      const at = spanStarts[slot]!;
      const length = spanLengths[slot]!;
      return length <= inlineLimit ? root.slice(at, at + length) : hashRange(at, length);
    },
    bucket(node: object): number | undefined {
      if (escaping.has(node)) return undefined;
      if (!addressable) {
        const text = nodes.get(node);
        return text === undefined ? undefined : hashString(text);
      }
      const slot = slotOf(node);
      if (slot === undefined) return undefined;
      return hashRange(spanStarts[slot]!, spanLengths[slot]!);
    },
  };
  CORES.set(tree, core);
  return tree;
}

/**
 * Everything one tree needs to answer a question about a node in ANOTHER tree.
 *
 * Kept in a side table rather than on the returned object so the public shape
 * stays exactly the three documented methods.
 */
interface TreeCore {
  root: string;
  /** False when tokens are materialized instead of addressed by offset. */
  addressable: boolean;
  startOf(node: object): number | undefined;
  lengthOf(node: object): number | undefined;
  text(node: object): string | undefined;
  hashRange(at: number, length: number): number;
}

const CORES = new WeakMap<ImprintTree, TreeCore>();

interface Prefix {
  h: Uint32Array;
  p: Uint32Array;
}

// A polynomial rolling hash over the root, so the hash of any node is O(1)
// rather than O(its length). Odd base, arithmetic mod 2^32 via Math.imul.
//
// It is a BUCKETING device and nothing else. Mod 2^32 polynomial hashing is
// easy to collide on purpose, which does not matter here because every reported
// match is confirmed against the actual characters. A collision costs one
// comparison, never a wrong answer.
const HASH_BASE = 131;

function buildPrefix(s: string): Prefix {
  const n = s.length;
  const h = new Uint32Array(n + 1);
  const p = new Uint32Array(n + 1);
  p[0] = 1;
  for (let i = 0; i < n; i++) {
    h[i + 1] = (Math.imul(h[i]!, HASH_BASE) + s.charCodeAt(i)) >>> 0;
    p[i + 1] = Math.imul(p[i]!, HASH_BASE) >>> 0;
  }
  return { h, p };
}

const rangeHash = (pre: Prefix, start: number, length: number): number =>
  (pre.h[start + length]! - Math.imul(pre.h[start]!, pre.p[length]!)) >>> 0;

function hashString(s: string): number {
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc = (Math.imul(acc, HASH_BASE) + s.charCodeAt(i)) >>> 0;
  return acc;
}

/** Compare two nodes without building either string. */
function sameContent(left: TreeCore, a: object, right: TreeCore, b: object): boolean {
  if (!left.addressable || !right.addressable) {
    const x = left.text(a);
    const y = right.text(b);
    return x !== undefined && x === y;
  }
  const sa = left.startOf(a);
  const sb = right.startOf(b);
  if (sa === undefined || sb === undefined) return false;
  const la = left.lengthOf(a)!;
  if (la !== right.lengthOf(b)!) return false;
  // Same tree, same offset: the same node, so no need to look at the text.
  if (left === right && sa === sb) return true;
  if (left.hashRange(sa, la) !== right.hashRange(sb, la)) return false;
  const x = left.root;
  const y = right.root;
  for (let i = 0; i < la; i++) if (x.charCodeAt(sa + i) !== y.charCodeAt(sb + i)) return false;
  return true;
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
   *
   * This builds a string. When the question is only whether two nodes agree,
   * {@link ImprintTree.sameAs} answers it without building one.
   */
  get(node: object): string | undefined;
  /**
   * Whether two nodes have the same imprint, without building either string.
   *
   * The nodes may come from different trees, which is the point: a diff holds
   * one tree per document and asks this across them. Equal imprints mean equal
   * values, in both directions, so this is exact and not a heuristic.
   *
   * Constant time when the two differ in length or in their bucket, which is
   * the common case while descending; a full comparison only happens when they
   * really are equal. False if either node has no standalone imprint.
   */
  sameAs(node: object, other: ImprintTree, otherNode: object): boolean;
  /**
   * A cheap grouping key for a node's content, or `undefined` if it has none.
   *
   * Equal imprints always give the same bucket. Different imprints almost
   * always give different ones, but MAY collide, so a caller matching values by
   * content must confirm with {@link ImprintTree.sameAs} rather than trust this
   * alone. It exists so that grouping a thousand elements by content costs a
   * thousand integer comparisons instead of a thousand string builds.
   */
  bucket(node: object): number | undefined;
  /**
   * How long this node's imprint is, without building it.
   *
   * Useful as a cheap first discriminator, and as a way to decide whether
   * building the string is worth it at all: the cost of {@link ImprintTree.get}
   * is exactly this number.
   */
  size(node: object): number | undefined;
  /**
   * A comparison key for a node, materializing the token only when it is cheap.
   *
   * Returns the token itself when it is at most `inlineLimit` characters, and
   * the {@link ImprintTree.bucket} otherwise. This exists because the caller
   * that wants it (a structural diff, keying every node it walks) would
   * otherwise ask for the size and then the value, paying two lookups per node
   * to answer one question.
   *
   * A token never begins with `#` or a digit-only form that could be confused
   * with a bucket, and the two returns are distinguishable by `typeof`, so a
   * caller can key on the result directly. Equal nodes have equal sizes, so the
   * two are never keyed by different routes; a numeric result still has to be
   * confirmed with {@link ImprintTree.sameAs}, since buckets may collide.
   */
  keyWithin(node: object, inlineLimit: number): string | number | undefined;
}

interface Encoded {
  root: string;
  /** Materialized tokens. Populated only when `addressable` is false. */
  nodes: WeakMap<object, string>;
  escaping: WeakSet<object>;
  /** A node's slot in `starts` and `lengths`, when `addressable`. */
  slotOf(node: object): number | undefined;
  starts(): Uint32Array;
  lengths(): Uint32Array;
  /** Every node that claimed a slot, in slot order. */
  claimed: object[];
  /**
   * Whether node tokens are contiguous ranges of `root`.
   *
   * True except in sorted mode, where a container's items are reordered when it
   * closes, so where the walk emitted a child is not where it ends up.
   */
  addressable: boolean;
}

function encode(value: unknown, options: ImprintOptions, tree: boolean): Encoded {
  const sortCollections = (options.order ?? "insertion") === "sorted";

  // Populated only in tree mode. In the default mode both stay empty and the
  // walk below is byte for byte the same work it has always done.
  const nodes = new WeakMap<object, string>();
  const escaping = new WeakSet<object>();
  // Sorting reorders a container's items when it closes, so a child's token
  // stops being where the walk emitted it and an offset into the root would
  // address the wrong text. Only that mode falls back to materializing.
  const addressable = tree && !sortCollections;
  // One WeakMap write per node, not two.
  //
  // The span is two numbers, and holding them in two WeakMaps cost two hashed
  // writes per node, which on a wide shallow document is more than the short
  // join it replaced. So the WeakMap holds a SLOT and the numbers live in
  // parallel typed arrays, and the close op carries its own slot so closing
  // touches no map at all.
  // Deliberately NOT filled during the walk. Which node owns which slot is only
  // needed if the tree ends up addressing tokens by offset, and the walk cannot
  // know that yet, so paying a hashed write per node here would be a write the
  // common case throws away. `claimed` is slot-ordered, so the map can be built
  // afterwards, once, and only if it is going to be read.
  let slots = 0;
  let starts = new Uint32Array(256);
  let lengths = new Uint32Array(256);
  const claimed: object[] = [];
  const claimSlot = (o: object): number => {
    claimed.push(o);
    void o;
    if (slots === starts.length) {
      const grownStarts = new Uint32Array(slots * 2);
      grownStarts.set(starts);
      starts = grownStarts;
      const grownLengths = new Uint32Array(slots * 2);
      grownLengths.set(lengths);
      lengths = grownLengths;
    }
    return slots++;
  };
  // Characters emitted so far, which is where the next token begins.
  let pos = 0;
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
  // The buffer at the top of `acc`, kept in a variable so the common case is a
  // field write rather than a length lookup and an index on every token.
  let cur: string[] = acc[0]!;
  const openBuffer = (): void => {
    cur = [];
    acc.push(cur);
  };
  const closeBuffer = (): string => {
    const done = acc.pop()!.join("");
    cur = acc[acc.length - 1]!;
    return done;
  };
  // One frame per open SORTING container, collecting children as whole items.
  const frames: { items: string[] }[] = [];

  const ancestors = new Map<object, number>();
  let depth = 0;

  const emit = (s: string): void => {
    cur.push(s);
    pos += s.length;
  };

  /** Emit an object whose whole token is one string, recording it in tree mode. */
  const leaf = (o: object, token: string): void => {
    if (addressable) {
      const slot = claimSlot(o);
      starts[slot] = pos;
      lengths[slot] = token.length;
    } else if (tree) {
      nodes.set(o, token);
    }
    emit(token);
  };

  const root = op(0, value, "", null, "", SegKind.Root);
  const stack: Op[] = [root];
  const pushAll = (ops: Op[]): void => {
    for (let i = ops.length - 1; i >= 0; i--) stack.push(ops[i]!);
  };

  /** Wrap a child's ops so the container sees it as one sortable unit. */
  const item = (wrapped: Op[]): Op[] => [
    op(3, null, "", null, "", SegKind.Root),
    ...wrapped,
    op(4, null, "", null, "", SegKind.Root),
  ];

  // The children of the container currently being expanded, reused rather than
  // reallocated. See where it is cleared, below, for why that is safe.
  const ops: Op[] = [];
  let pending = "";
  let parent: Op | null = null;
  const descend = (child: unknown, seg: string | number, segKind: SegKind): void => {
    ops.push(op(0, child, pending, parent, seg, segKind));
    pending = "";
  };
  const flush = (): void => {
    if (pending !== "") {
      ops.push(op(1, null, pending, null, "", SegKind.Root));
      pending = "";
    }
  };

  // Interned key tokens. A document of rows repeats the same handful of field
  // names on every one of them, and rebuilding `s4:name` five thousand times is
  // waste.
  //
  // It gives up when the keys turn out not to repeat. A flat dictionary of five
  // thousand distinct keys never hits, and paying a failed lookup and an insert
  // for each of them made that shape measurably SLOWER than not caching at all.
  // So the cache is bounded, and after a sample of lookups with a poor hit rate
  // it switches itself off for the rest of the document. Both shapes then come
  // out ahead, where either fixed choice gives one of them up.
  const keyTokens = new Map<string, string>();
  let caching = true;
  let lookups = 0;
  let hits = 0;
  const keyToken = (key: string): string => {
    if (!caching) return str(key);
    lookups++;
    const found = keyTokens.get(key);
    if (found !== undefined) {
      hits++;
      return found;
    }
    if (lookups === 512 && hits * 4 < lookups) caching = false;
    const made = str(key);
    if (keyTokens.size < 1024) keyTokens.set(key, made);
    return made;
  };

  while (stack.length > 0) {
    const cursor = stack.pop()!;

    if (cursor.k === 1) {
      emit(cursor.s);
      continue;
    }
    if (cursor.k === 3) {
      openBuffer();
      continue;
    }
    if (cursor.k === 4) {
      frames[frames.length - 1]!.items.push(closeBuffer());
      continue;
    }
    if (cursor.k === 2) {
      if (cursor.sort) {
        const frame = frames.pop()!;
        frame.items.sort();
        emit(frame.items.join(""));
      }
      if (addressable) {
        // Everything between the header and here belongs to this node, and it
        // is already sitting in the one output buffer in final order. Recording
        // where it starts and how long it is costs two numbers; joining it into
        // a string of its own is what used to cost O(n * depth).
        lengths[cursor.slot] = pos - starts[cursor.slot]!;
      } else if (tree) {
        const token = closeBuffer();
        nodes.set(cursor.o!, token);
        emit(token);
      }
      ancestors.delete(cursor.o!);
      depth--;
      continue;
    }

    // A key token, or the run of primitive siblings that preceded this value.
    if (cursor.s !== "") emit(cursor.s);

    const v = cursor.v;

    // ---------------------------------------------------------- primitives
    const token = primitiveToken(v);
    if (token !== null) { emit(token); continue; }

    switch (typeof v) {
      case "symbol":
        throw new UnrepresentableValueError(
          "a symbol is an identity, not content, and has no canonical form",
          formatPath(cursor),
        );
      case "function":
        throw new UnrepresentableValueError(
          "a function has no canonical form",
          formatPath(cursor),
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
        formatPath(cursor),
      );
    }
    if (v instanceof Promise) {
      throw new UnrepresentableValueError(
        "a Promise has no canonical form: its value does not exist yet",
        formatPath(cursor),
      );
    }

    // ---------------------------------------------------------- containers
    ancestors.set(obj, depth);
    const close = op(2, null, "", null, "", SegKind.Root);
    close.o = obj;
    if (tree) {
      open[depth] = obj;
      // Where this container's token begins. A class instance's `c<name>`
      // prefix has not been emitted yet, and it is part of the token, so this
      // has to be recorded before the header goes out.
      if (addressable) {
        const slot = claimSlot(obj);
        starts[slot] = pos;
        close.slot = slot;
      } else {
        // Sorted mode still needs a buffer per container, because the close op
        // has to join a complete token to record it.
        openBuffer();
      }
    }
    depth++;

    // A run of primitive children collapses into one string rather than one
    // stack entry each, and the run that precedes a child worth descending into
    // rides along on that child's entry. An array of five thousand numbers used
    // to allocate five thousand work items; it now allocates one.
    //
    // `ops` is reused across containers rather than allocated per container. It
    // is filled, handed to `pushAll`, which copies the references onto the work
    // stack, and then dead: nothing reads it again before the next container
    // clears it. A document of five thousand rows built fifteen thousand of
    // these throwaway arrays.
    ops.length = 0;
    pending = "";
    parent = cursor;

    if (v instanceof Map) {
      emit(`m${v.size}:`);
      if (sortCollections) {
        frames.push({ items: [] });
        let i = 0;
        for (const [k, val] of v) {
          // Key and value form ONE item, so sorting can never separate a key
          // from its value. Sorting them independently would not merely reorder
          // the output, it would rewrite the data.
          ops.push(...item([
            op(0, k, "", cursor, i, SegKind.MapKey),
            op(0, val, "", cursor, i, SegKind.MapValue),
          ]));
          i++;
        }
      } else {
        let i = 0;
        for (const [k, val] of v) {
          const kt = primitiveToken(k);
          if (kt !== null) pending += kt;
          else descend(k, i, SegKind.MapKey);
          const vt = primitiveToken(val);
          if (vt !== null) pending += vt;
          else descend(val, i, SegKind.MapValue);
          i++;
        }
        flush();
      }
      close.sort = sortCollections;
      ops.push(close);
      pushAll(ops);
      continue;
    }

    if (v instanceof Set) {
      emit(`e${v.size}:`);
      if (sortCollections) {
        frames.push({ items: [] });
        let i = 0;
        for (const member of v) {
          ops.push(...item([op(0, member, "", cursor, i, SegKind.SetMember)]));
          i++;
        }
      } else {
        let i = 0;
        for (const member of v) {
          const mt = primitiveToken(member);
          if (mt !== null) pending += mt;
          else descend(member, i, SegKind.SetMember);
          i++;
        }
        flush();
      }
      close.sort = sortCollections;
      ops.push(close);
      pushAll(ops);
      continue;
    }

    // Arrays never sort: element order IS the value. So no buffering.
    if (Array.isArray(v)) {
      emit(`a${v.length}:`);
      for (let i = 0; i < v.length; i++) {
        // A hole is not an explicit undefined at the language level, but both
        // read as undefined and neither carries content, so both encode as `u`.
        const t = primitiveToken(v[i]);
        if (t !== null) pending += t;
        else descend(v[i], i, SegKind.Index);
      }
      flush();
      ops.push(close);
      pushAll(ops);
      continue;
    }

    // Plain objects, null-prototype objects and class instances.
    const proto = Object.getPrototypeOf(obj) as object | null;
    const ctorName =
      proto === null || proto === Object.prototype
        ? null
        : ((obj as { constructor?: { name?: string } }).constructor?.name ?? "");

    // Keys are sorted here, up front, so the container never needs buffering:
    // object key order is not part of the value, and JCS agrees.
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record);
    // Most objects come out of `Object.keys` already ordered, and checking is
    // cheaper than sorting. Both this comparison and the default sort order by
    // UTF-16 code unit, so they agree on what "sorted" means.
    for (let i = 1; i < keys.length; i++) {
      if (keys[i - 1]! > keys[i]!) { keys.sort(); break; }
    }
    if (ctorName !== null) emit(`c${raw(ctorName)}`);
    emit(`${proto === null ? "O" : "o"}${keys.length}:`);

    for (const key of keys) {
      pending += keyToken(key);
      const t = primitiveToken(record[key]);
      if (t !== null) pending += t;
      else descend(record[key], key, SegKind.Key);
    }
    flush();
    ops.push(close);
    pushAll(ops);
  }

  // Built on demand, from the slot-ordered list, and only by a caller that
  // actually needs offset lookups.
  let slotOf: WeakMap<object, number> | null = null;
  const spanOf = (node: object): number | undefined => {
    if (slotOf === null) {
      slotOf = new WeakMap<object, number>();
      for (let i = 0; i < claimed.length; i++) slotOf.set(claimed[i]!, i);
    }
    return slotOf.get(node);
  };
  return {
    root: acc[0]!.join(""),
    nodes,
    escaping,
    slotOf: spanOf,
    starts: () => starts,
    lengths: () => lengths,
    claimed,
    addressable,
  };
}
