// impronta: canonical form and content hash in one call, over the whole
// JavaScript value graph.
//
//   imprint(value)                 the extended canonical form
//   imprintTree(value)             the same, plus the form of every node inside
//   jcs(value)                     byte-exact RFC 8785, for cross-language interop
//   canonicalize(value, { mode })  either of the two, by option
//   digest(value)                  canonicalize and hash, one call
//
// The name is the thesis. An imprint is what a value leaves behind: a mark that
// is the same every time for the same object and different for a different one.
// That second half is the hard part, and it is where the JSON-subset tools give
// up quietly.

export { imprint, imprintTree } from "./imprint.js";
export type { ImprintTree } from "./imprint.js";
export { jcs } from "./jcs.js";
export { canonicalize, digest } from "./hash.js";
export { UnrepresentableValueError } from "./types.js";
export type { DigestOptions, ImprintOptions, JcsOptions } from "./types.js";
