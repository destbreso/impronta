# Changelog

All notable changes to this project are documented here.

## 0.3.0

`imprintTree` is linear in depth instead of quadratic, and gains three methods
for asking about a node without building its string. `imprint` is untouched and
the encoding is unchanged, byte for byte.

The old tree mode gave every subtree its own materialized token, which costs the
sum of all subtree lengths: fine on the wide shallow documents everybody tests
with, and quadratic on a deep one, where a 160 KB chain of nested objects
reached 2.6 GB of heap. A node's token is a CONTIGUOUS range of the root,
because the grammar is self-delimiting, so a start and a length are enough.

New on `ImprintTree`, all of them exact:

- `sameAs(node, otherTree, otherNode)`: whether two nodes agree, across trees,
  without building either string. Leaves on a length mismatch in the common case.
- `bucket(node)`: a cheap grouping key. May collide, so confirm with `sameAs`.
- `size(node)`: the length of the imprint, which is what `get` would cost.
- `keyWithin(node, inlineLimit)`: the token when it is short enough to be worth
  materializing, the bucket otherwise, in one lookup.

Both representations are kept, because neither wins everywhere. A string per
node makes comparison a native string equality, which V8 does with a memcmp and
which nothing written in JavaScript matches; offsets make deep documents
possible. The offsets pass already knows every node's length, so the total is
free to compute, and the choice is made on that number rather than on a guess
about the shape. `order: "sorted"` always materializes, since sorting moves a
child's token away from where the walk emitted it.

Measured against 0.2.1, same machine, interleaved runs and medians: a deep chain
is about 10x faster in tree mode with memory falling from 322 MB to 5 MB at eight
thousand levels, and wide shallow documents are unchanged to slightly better.

Verified byte for byte against the published encoding over 80,000 encodings in
both ordering modes, and `sameAs` and `bucket` agreed with string comparison on
185,000 node pairs, including cycles.

## 0.2.1

Faster, with byte-identical output. No API change, no grammar change.

Roughly **1.5x** on a document of five thousand mixed rows, **1.9x** on Map and
Set heavy input, and **1.4x** on a long array of primitives, measured against
0.2.0 on the same machine with interleaved runs and medians rather than one
timed loop each. That methodology is not a detail: a single sample per variant
first told me two of these changes made things slower, and they do not.

The profile said the time was not where guessing put it. Very little was
arithmetic; most was allocation, and a fifth of the run was the garbage
collector.

- **Error paths are built on the error path.** Every value used to compose the
  string naming its position, so that a throw could report it. Almost no caller
  ever sees one, and it cost 15% of every run. A work item now carries a parent
  link and one raw segment, and the string is composed on the way out of a
  throw. The messages are unchanged, and there is a test for each shape of path.
- **A run of primitive siblings is one work item, not one each.** An array of
  ten thousand numbers allocated ten thousand stack entries to emit ten thousand
  short strings. The run collapses into one string, and the run preceding a
  child worth descending into rides along on that child's entry.
- **One work-item shape instead of five.** Every `op.k` read was polymorphic in
  the hottest loop in the library.
- **The per-container work array is reused.** It is filled, copied onto the work
  stack, and then dead, so a document of five thousand rows was building fifteen
  thousand throwaway arrays.
- **Key tokens are interned, and the cache gives up when they do not repeat.** A
  document of rows repeats the same field names on every row; a flat dictionary
  of five thousand distinct keys repeats none, and caching made that shape
  slower than not caching. The cache is bounded and switches itself off after a
  sample with a poor hit rate, so both shapes come out ahead.
- **Object keys are checked for order before being sorted**, since most come out
  of `Object.keys` already in order and checking is cheaper than sorting.

Verified byte for byte against 0.2.0 over 80,000 encodings in both ordering
modes, 22,444 subtree imprints, 1,230 cyclic values, and every error path.

## 0.2.0

Adds `imprintTree`, which returns the imprint of a value together with the
imprint of every object inside it.

- The grammar is length-prefixed and self-delimiting, so a container's token is
  its header followed by its children's tokens verbatim. Every subtree already
  carried a complete canonical form; this only exposes it. One traversal
  annotates the graph, and afterwards structural equality between any two nodes,
  from any two values, is a string comparison, exact in both directions.
- A subtree holding a back-reference to an ancestor above it has no standalone
  form, because the cycle token counts levels to climb. `get` returns
  `undefined` there rather than a key that would be wrong somewhere else; a
  cycle closing inside the node is unaffected. This came from measuring the
  claim rather than reading the grammar: eight of nine shapes encode standalone
  and the ninth does not.
- `imprint` is untouched and still linear. Tree mode buffers each level, so it
  costs O(n × depth), and the shared traversal is guarded so the default path
  does no extra work. Measured: no change to `imprint`, and `imprintTree` costs
  1.2x on a wide, shallow document.

## 0.1.2

No library code changes. Documentation and the report script, and two of these
are fixes to charts that were saying something false.

- **The depth chart claimed every implementation was unbounded.** The report
  script passed each suite straight to `Array.map`, which supplies
  `(element, index, array)`, so the array index arrived as `runDepth`'s
  `ceiling` argument: the first subject was probed to depth 0, succeeded, and
  was recorded as having no limit. The chart contradicted the table printed
  beside it. Every suite is now called through an arrow.

- **The README charts were unreadable on npm.** They carried a
  `prefers-color-scheme` block, and an SVG embedded with `<img>` resolves that
  against the viewer's operating system rather than the page it sits on. npm
  renders READMEs on white, so anyone browsing with a dark OS got the dark
  palette on a white page: washed-out labels and no contrast. The charts now use
  one fixed palette and paint their own background, so they render identically
  on npm, on GitHub in either theme, and anywhere else.
- Adds the growth-exponent chart, so "the iterative kernel is linear, not
  quadratic" is a measurement rather than a claim. Both modes come out linear on
  depth and on width.
- `docs/REPORT.md` gains the scaling suite from serializer-conformance 0.3.0.

## 0.1.1

No code changes. Packaging and documentation only.

- The conformance harness is now a normal registry dependency rather than a
  `file:../serializer-conformance` path, which made the repository
  uninstallable for anyone who cloned it without the sibling checkout.
- Declares `repository`, `homepage` and `bugs`.
- README: adds the regenerable collision and depth charts, splits the `ohash`
  row into `serialize` and `hash` (their depth ceilings differ by 3x), and
  corrects a depth range that contradicted the table printed directly above it.
- `npm run report` regenerates `docs/REPORT.md` and the charts by running the
  harness over this repository's own `dist/`, so the published comparison
  tracks the code in the tree instead of whichever release npm resolves. It
  replaces a `conformance` script that could never have worked: it asked the
  harness to load `impronta` from `node_modules`, and a package cannot resolve
  itself that way.

## 0.1.0

First release.

- `imprint(value)`: extended canonical form over the whole JavaScript value
  graph. Injective by construction, via type tags plus length-prefixed payloads.
  Covers BigInt, Map, Set, every TypedArray, ArrayBuffer, Date, RegExp, class
  instances, null-prototype objects and cycles.
- `jcs(value)`: byte-exact RFC 8785, verified against the six official vectors
  from the reference implementation.
- `digest(value)`: canonicalize and hash in one call, via Web Crypto. SHA-256 by
  default; hex, base64url or raw bytes.
- Both kernels are iterative, so nesting depth costs heap rather than call stack
  and there is no level at which they throw RangeError.
- `order: "sorted"` for order-insensitive Map and Set imprints. The default is
  order-preserving, chosen because its failure mode is a slow cache rather than
  a wrong one.
- 44 tests, including an injectivity corpus, a linear-time regression guard, and
  a gate that runs the external serializer-conformance harness in CI.
