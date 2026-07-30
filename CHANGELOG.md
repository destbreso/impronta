# Changelog

All notable changes to this project are documented here.

## 0.1.2

No code changes. Documentation only, and one of them is a fix.

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
