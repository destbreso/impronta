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
| ohash | 1 | not JCS | ~4,800 |
| stable-hash | 2 | not JCS | ~7,600 |
| object-hash | 1 | not JCS | ~4,800 |
| **impronta.imprint** | **0** | not JCS | **unbounded** |
| **impronta.jcs** | 3, all inherent to JSON | **6/6** | **unbounded** |

Zero collisions is trivially achievable by refusing everything, and the harness
counts a refusal as acceptable. impronta answers every probe and the answers are
distinct, which the test suite asserts separately.

`npx serializer-conformance all` reproduces the table against whatever you have
installed.

## Depth is not a footnote

Every implementation measured is recursive and dies with a `RangeError` between
roughly 1,800 and 5,900 levels of nesting. Anything doing content addressing eats
untrusted input by definition, and "send a deeply nested document" is the
cheapest denial of service there is. impronta's traversal is iterative: depth
costs heap, not call stack.

Iterative is necessary but not sufficient. The first version here was iterative
*and quadratic*, because it buffered every item and so copied the deeper encoding
once per level. It passed every correctness test and took 26 seconds where it now
takes 0.2. A test asserts the ratio stays linear, because moving a denial of
service from the call stack to the clock is not a fix.

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

## API

```ts
imprint(value, { order?: "insertion" | "sorted" }): string
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
