# impronta

Canonical form and content hash in one call, over the whole JavaScript value
graph.

```ts
import { digest, imprint, jcs } from "impronta";

await digest({ user: "ada", roles: new Set(["admin"]) });  // SHA-256, hex
imprint(new Map([["a", 1]]));                              // the canonical form
jcs({ b: 1, a: 2 });                                       // '{"a":2,"b":1}'  RFC 8785
```

Zero dependencies. Web Crypto for the digest, so the same code runs on Node 18+,
Deno, Bun, browsers and edge runtimes.

## The problem

Every JSON-subset canonicalizer collapses the types JSON cannot express, and
does it silently:

```ts
canonicalize({ v: new Map([["a", 1]]) })      // '{"v":{}}'   the entries are gone
canonicalize({ v: new Uint8Array([1,2,3]) })  // '{"v":{"0":1,"1":2,"2":3}}'
```

Nothing throws and nothing warns. The cache returns an entry stored under a
different value; the signature verifies over data that is not what was signed.
Silence is the failure mode, which is why it survives code review.

## What impronta does about it

Two modes, because two different jobs are hiding under the word "canonical".

**`jcs(value)`** is byte-exact RFC 8785, for when the bytes have to match a JCS
implementation in Go, Java or Python. It refuses what JSON cannot express rather
than guessing, and it inherits JSON's own conflations by definition: a `Date` and
its ISO string are the same JSON document.

**`imprint(value)`** is the extended form, and the reason this package exists. It
covers `BigInt`, `Map`, `Set`, every `TypedArray`, `ArrayBuffer`, `Date`,
`RegExp`, class instances, null-prototype objects and cycles, giving each a
distinct encoding. It is injective **by construction**, not by inspection:

1. Every value carries a type tag, so no two types can share an encoding. A Map
   is not an object. A `Uint8Array` is not an `Int8Array`.
2. Every variable-length payload is length-prefixed, so the grammar is
   self-delimiting and needs no escaping. A key containing the encoding's own
   punctuation cannot imitate a different structure.

## Measured, not claimed

Run by [serializer-conformance](https://github.com/destbreso/serializer-conformance),
a neutral harness built before this library and which treats it as one more
adapter:

| | collisions | RFC 8785 | max nesting depth |
|---|---|---|---|
| canonicalize | 7 | 6/6 | ~4,100 |
| json-canonicalize | 7 | 6/6 | ~1,800 |
| safe-stable-stringify | 8 | 6/6 | ~4,100 |
| fast-json-stable-stringify | 7 | 6/6 | ~5,900 |
| ohash.serialize | 1 | not JCS | ~1,500 |
| ohash.hash | 1 | not JCS | ~4,800 |
| stable-hash | 2 | not JCS | ~7,000 |
| object-hash | 1 | not JCS | ~4,800 |
| **impronta.imprint** | **0** | not JCS | **unbounded** |
| **impronta.jcs** | 3, all inherent to JSON | **6/6** | **unbounded** |

Zero collisions is trivially achievable by refusing everything, and the harness
counts a refusal as acceptable. impronta answers every probe and the answers are
distinct, which the test suite asserts separately.

The full run of every suite is committed at [docs/REPORT.md](docs/REPORT.md),
and `npm run report` regenerates it and the charts below from this repository's
own build, so these numbers describe the code in the tree rather than a release.
`npx serializer-conformance all` reproduces it against whatever you have
installed. A number in a README is a claim; a command that regenerates it is
evidence.

The harness publishes its own numbers with impronta deliberately *not*
installed, because an instrument should describe the field rather than the thing
its author also ships. This is the other half, where the conflict of interest
belongs to the package making the claim.

![Collision grid: ten probes against every implementation installed](https://raw.githubusercontent.com/destbreso/impronta/main/docs/collisions.svg)

## Depth is not a footnote

Every implementation measured is recursive and dies with a `RangeError` somewhere
in the low thousands of levels. Anything doing content addressing eats untrusted
input by definition, and "send a deeply nested document" is the cheapest denial
of service there is: a few dozen kilobytes of JSON that `JSON.parse` handles
without complaint and the fingerprinting step does not. impronta's traversal is
iterative, so depth costs heap, not call stack.

![Nesting depth before failure, by implementation](https://raw.githubusercontent.com/destbreso/impronta/main/docs/depth.svg)

Iterative is necessary but not sufficient. The first version here was iterative
*and quadratic*, because it buffered every item and so copied the deeper encoding
once per level. It passed every correctness test and took 26 seconds where it now
takes 0.2. A test asserts the ratio stays linear, because moving a denial of
service from the call stack to the clock is not a fix.

That is not a claim you have to take on trust either. The harness fits log(time)
against log(size), so the number below is an exponent: 1 is linear, 2 is
quadratic. Both modes come out linear on both axes.

![Growth exponent by depth, one bar per implementation, with reference lines at linear and quadratic](https://raw.githubusercontent.com/destbreso/impronta/main/docs/scaling-depth.svg)

## Ordering: the one debatable choice

`Map` and `Set` preserve iteration order by default, so two Maps with the same
entries in a different order get different imprints. Iteration order is part of
what a Map observably *is*.

```ts
imprint(new Map([["a",1],["b",2]]), { order: "sorted" })  // order-insensitive
```

The default is the conservative direction, chosen by failure mode rather than by
taste. Sorting when you should not produces a false **match**: a cache serves an
entry stored under a different value. Not sorting when you could produces a false
**miss**: the lookup fails and the work is redone. One is a correctness bug, the
other is a performance cost, so the default is the one that can only ever be slow.

Plain object keys are always sorted, in both modes: property order is not part of
the value, and RFC 8785 says the same.

## Every subtree is addressable too

The grammar is length-prefixed and self-delimiting, and that has a consequence
worth using: a container's token is its header followed by its children's tokens
verbatim, so every node inside a value already carries a complete canonical form
of its own. `imprintTree` annotates the whole graph in one traversal.

```ts
import { imprintTree } from "impronta";

const before = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }] };
const after  = { rows: [{ id: "b" }, { id: "c" }, { id: "a" }] };

const t0 = imprintTree(before);
const t1 = imprintTree(after);

t0.get(before.rows[0]) === t1.get(after.rows[2]); // true: the same row, moved
t0.root === t1.root;                              // false: the value changed
```

Afterwards, structural equality between any two nodes, from any two values, is a
string comparison, and it is exact in both directions: equal imprints mean equal
values, different imprints mean different values. That is a content identity for
arrays of objects, the thing structural diffs usually ask you to hand-write as an
`objectHash` callback, and it works for `Map`, `Set`, `TypedArray` and class
instances rather than only for plain JSON.

One node in the graph has no standalone form, and `get` returns `undefined` for
it: a subtree containing a back-reference to an ancestor *above* it. The cycle
token counts levels to climb, so that subtree does not mean the same thing
anywhere else, and refusing is the only honest answer. A cycle that closes inside
the node is fine and gets an imprint like anything else.

`imprint` is linear; `imprintTree` is not. A string per node costs the sum of all
subtree lengths, so O(n × depth). Documents are usually wide and shallow, where
that is a small constant, but `imprint` remains the right call when you only want
the root form.

## API

```ts
imprint(value, { order?: "insertion" | "sorted" }): string
imprintTree(value, { order? }): { root: string, get(node: object): string | undefined }
jcs(value, { unrepresentable?: "throw" | "json" }): string
canonicalize(value, { mode?: "imprint" | "jcs", ... }): string
digest(value, {
  mode?: "imprint" | "jcs",
  algorithm?: "SHA-256" | "SHA-384" | "SHA-512" | "SHA-1",
  encoding?: "hex" | "base64url" | "bytes",
}): Promise<string | Uint8Array>
```

`UnrepresentableValueError` carries a `path` pointing at the offending value.

## What it refuses, and why that is the honest answer

`imprint` throws only for values whose meaning *is* their identity: functions,
symbols, `WeakMap`, `WeakSet`, `WeakRef`, `Promise`. An identity has no canonical
form, and inventing one would be the same silent lie this library exists to
avoid.

`jcs` additionally throws for everything outside the JSON data model, unless you
ask for `unrepresentable: "json"`, which reinstates `JSON.stringify`'s lossy
coercions for bug-compatibility with an existing pipeline.

## Known limits, stated rather than hidden

- Symbol-keyed properties are ignored, as `Object.keys` and JSON ignore them.
- Two different classes sharing a name encode identically. Fixing that needs
  identity, which is exactly what a content hash must not depend on.
- A shared non-cyclic reference is expanded, so a diamond and its fully expanded
  twin agree. Only true cycles become back-references.
- `-0` and `0` are distinct in `imprint` and identical in `jcs`, because JSON has
  no way to say otherwise.

## Install

```bash
npm i impronta
```

## License

MIT
