# impronta

Canonical form and content hash in one call, over the whole JavaScript value
graph.

## What this is

A content hash is a short fixed-length string computed from a value, with two
properties: the same value always produces the same string, and two different
values never do. With one in hand, "have I seen this before" is a comparison of
a few dozen characters instead of a walk over two object graphs, and the answer
holds across processes, across machines and across years, because nothing about
it depends on where the value sat in memory. Git names commits this way, and so
do S3 ETags, container image layers, lockfiles, and every cache that keys on its
own input.

Over a file this is easy: a file is already bytes, and SHA-256 takes bytes. Over
a JavaScript value it is not, because a value is not bytes and there is more
than one way to write it down. `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are the
same value, and `JSON.stringify` hands back two different strings for them. So a
hash worth trusting has to be preceded by a **canonical form**: one agreed way
of writing a value down, chosen so that equal values always produce identical
text and different values never share any. That is the class of tool this
package belongs to, and for the JSON subset that form is standardized as RFC
8785, which this implements byte for byte.

The first property, equal in means equal out, is the one everybody gets right:
sort the keys and you are most of the way there. The second one, different in
means different out, is where the field gives up quietly.

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

## Install

```bash
npm i impronta
```

Zero dependencies. Web Crypto for the digest, so the same code runs on Node 18+,
Deno, Bun, browsers and edge runtimes.

## Use

```ts
import { digest, imprint, jcs } from "impronta";

await digest({ user: "ada", roles: new Set(["admin"]) });  // SHA-256, hex
imprint(new Map([["a", 1]]));                              // the canonical form
jcs({ b: 1, a: 2 });                                       // '{"a":2,"b":1}'  RFC 8785
```

```ts
import { canonicalize, digest } from "impronta";

await digest(value, { mode: "jcs" });        // the cross-language bytes
await digest(value, { algorithm: "SHA-512" });
await digest(value, { encoding: "bytes" });  // Uint8Array
canonicalize(value);                         // the string behind the digest
```

`digest` is async because Web Crypto is. `canonicalize` hands you the string if
you would rather hash it with something synchronous you already have.

## Where this earns its place

**A cache or memo key over arguments that are not plain JSON.** The real
arguments to a real function include a `Date` range, a `Set` of scopes, a
`BigInt` id, a `Uint8Array` of raw input. A JSON-subset stringifier writes a Map
or a Set as `{}`, so two calls with different scopes get the same key and the
second one is served the first one's answer: a wrong result, delivered fast, with
nothing in the logs. `await digest(args)` changes when any of that changes, and
`{ order: "sorted" }` is there for when you want the key to ignore Map and Set
ordering on purpose.

**Deduplicating records that can arrive twice.** A webhook redelivery, a retried
upload, a re-imported file, an at-least-once queue, an idempotency key on a
payment. Store the digest, drop the second copy. This is where a collision is
most expensive and least visible, because the symptom is a record that was never
written and no line anywhere saying why: every JSON-subset canonicalizer in the
table below collides on seven or eight of the ten probes.

**Change detection, including which part changed.** "Is this the config I
already applied", "did the rendered document move", an ETag over something
computed rather than stored: compare two digests instead of deep-equalling two
graphs, and keep one string instead of the whole previous version. `imprintTree`
takes it further, giving every node inside the value its own content key, so you
can find the row that changed rather than only learning that something did.

**Signing, and audit trails that get checked later.** A signature is over bytes,
so the signer and the verifier have to agree on which bytes, possibly years
apart and possibly in different languages. `mode: "jcs"` produces the bytes a
JCS implementation in another language produces for the same document, checked
against the official vectors. A canonicalizer that collapses a type does not
fail loudly here: it verifies a signature over data that is not what was signed.

**Structural diff and move detection.** Two nodes with equal imprints are the
same value, so a diff can stop descending; two with different imprints differ
somewhere, so it must. Neither direction can be wrong, because the encoding is
injective. That is the content identity a diff library otherwise asks you to
hand-write as an `objectHash` callback, and here it covers `Map`, `Set`,
`TypedArray` and class instances rather than only plain JSON.

**Fingerprinting input that came from outside.** Anything content-addressing
untrusted data hashes whatever arrives, including a document nested deeper than
any recursive implementation survives. That case has its own section below,
because every implementation measured except this one falls over on it.

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
| stable-hash | 2 | not JCS | ~7,600 |
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

Iterative is necessary and not sufficient. An iterative kernel that buffers each
level copies the whole deeper encoding once per level, which is quadratic, and a
quadratic kernel has not removed the denial of service: it has moved it from the
call stack to the clock. Nothing buffers on the common path here, and a test
asserts the ratio stays linear as depth grows.

That is not a claim you have to take on trust either. The harness fits log(time)
against log(size), so the number below is an exponent: 1 is linear, 2 is
quadratic. Both modes come out linear in depth, which is the axis the denial of
service lives on.

![Growth exponent by depth, one bar per implementation, with reference lines at linear and quadratic](https://raw.githubusercontent.com/destbreso/impronta/main/docs/scaling-depth.svg)

## When not to use this

Both ends, because a package that only names where it wins is advertising.

**Your values are plain JSON and you already depend on a stringifier.** Every
collision in the table above is a type outside the JSON data model, plus signed
zero. If your values only ever hold strings, finite numbers, booleans, null,
arrays and plain objects, those probes describe inputs your data cannot produce,
and `fast-json-stable-stringify`, `safe-stable-stringify` or `canonicalize`
already give you a stable string. `ohash` gives you a digest in one call, and
signed zero is its only collision in that table. Adding a dependency to defend
against a case that cannot occur is not a trade worth making. The one thing to
check is that `-0`, which arithmetic produces more often than people expect,
really is the same value as `0` for you: every implementation measured writes it
as `0`, JCS included, and only the extended mode keeps them apart.

**You need the digest synchronously.** `digest` is async because Web Crypto is.
Call `canonicalize` and hash the string with `node:crypto`'s `createHash`, or
with whatever synchronous primitive you already have. The canonical form is the
part that is hard to get right; the hashing is one line.

**You are hashing something too big to hold in memory.** `imprint` builds the
whole canonical form as one string and the digest encodes that string, so peak
memory is proportional to the encoded document, and there is no incremental or
streaming entry point. For a payload measured in gigabytes, frame it yourself
and feed a streaming hasher.

**You need to read the canonical form back.** The extended grammar is built to
be injective and to be hashed, and the package ships no decoder for it. If the
artifact itself has to be stored, transmitted and parsed by something else, use
`jcs`, which is JSON and which anything can read, or keep the original value
beside the digest.

**You are hashing bytes, not values.** A file, a request body, an image,
anything that is already a byte sequence: hash it with Web Crypto and skip all
of this. Canonicalization earns its keep only where the same value can be
written down in more than one way.

**What you actually need is identity.** Two instances of the same class with the
same fields get the same imprint, and that is the point of a content hash rather
than a defect in it. If the question is "is this the same object", a `WeakMap`
or an id field answers it and a content hash never will.

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

Asking about a node does not require building its string, which matters for the
caller that keys every node it walks. `sameAs(node, otherTree, otherNode)`
compares two nodes across two trees without materializing either, and answers in
constant time unless they really are equal. `bucket(node)` is a cheap integer
grouping key: equal nodes always land in the same bucket, different ones almost
always land in different ones, so a match has to be confirmed with `sameAs`.
`size(node)` is the length of the token, which is exactly what `get` would cost.
`keyWithin(node, inlineLimit)` returns the token when it is short enough to be
worth materializing and the bucket otherwise, in one lookup instead of two.

One node in the graph has no standalone form, and `get` returns `undefined` for
it: a subtree containing a back-reference to an ancestor *above* it. The cycle
token counts levels to climb, so that subtree does not mean the same thing
anywhere else, and refusing is the only honest answer. A cycle that closes inside
the node is fine and gets an imprint like anything else.

A node's token is a contiguous range of the root, because the grammar is
self-delimiting and nothing is interleaved, so a start and a length are enough to
address it and the default traversal stays linear. Tokens are materialized as
strings as well when the sum of all subtree lengths is small next to the document,
because then a comparison is a native string equality, which nothing written in
JavaScript matches; the offsets pass already knows every node's length, so that
choice is made on the real total rather than on a guess about the shape.
`order: "sorted"` always materializes, since sorting moves a child's token away
from where the walk emitted it. `imprint` remains the right call when you only
want the root form.

## API

```ts
imprint(value, { order?: "insertion" | "sorted" }): string
imprintTree(value, { order? }): ImprintTree
jcs(value, { unrepresentable?: "throw" | "json" }): string
canonicalize(value, { mode?: "imprint" | "jcs", ... }): string
digest(value, {
  mode?: "imprint" | "jcs",
  algorithm?: "SHA-256" | "SHA-384" | "SHA-512" | "SHA-1",
  encoding?: "hex" | "base64url" | "bytes",
}): Promise<string | Uint8Array>

interface ImprintTree {
  root: string
  get(node: object): string | undefined
  sameAs(node: object, other: ImprintTree, otherNode: object): boolean
  bucket(node: object): number | undefined
  size(node: object): number | undefined
  keyWithin(node: object, inlineLimit: number): string | number | undefined
}
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

## License

MIT
