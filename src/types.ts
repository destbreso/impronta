/** Options shared by the extended canonical form and the digest built on it. */
export interface ImprintOptions {
  /**
   * How to order `Map` entries and `Set` members.
   *
   * `"insertion"` (default) preserves iteration order, because iteration order
   * is part of what a Map and a Set observably *are*: two Maps holding the same
   * entries in a different order behave differently when you loop over them, so
   * they are different values and must not share an imprint.
   *
   * `"sorted"` treats them as an unordered dictionary and an unordered set,
   * which is what you usually want for a cache key, and which deliberately
   * collapses two orderings into one imprint.
   *
   * The default is the conservative direction. Getting this wrong in the
   * `"sorted"` direction produces a false *match*: a cache returns an entry
   * that was stored under a different value, or a signature verifies over data
   * that is not what was signed. Getting it wrong in the `"insertion"`
   * direction produces a false *miss*: a cache lookup fails and the work is
   * redone. One of those is a correctness bug and the other is a performance
   * cost, so the default is the one whose failure mode is merely slow.
   */
  order?: "insertion" | "sorted";
}

/** Options for the JCS (RFC 8785) canonical form. */
export interface JcsOptions {
  /**
   * What to do with values RFC 8785 cannot represent (`undefined`, `BigInt`,
   * `Map`, `Set`, `TypedArray`, functions, symbols, `NaN`, `Infinity`).
   *
   * `"throw"` (default) refuses. That is the honest answer: JCS exists so that
   * independent implementations in different languages agree byte for byte, and
   * a value the format cannot express has no agreed encoding to produce.
   *
   * `"json"` applies the same lossy coercions `JSON.stringify` does (NaN and
   * Infinity become null, a Map becomes `{}`, undefined disappears). Use it
   * only when you need bug-compatibility with an existing pipeline, and know
   * that it reintroduces exactly the silent collisions this library exists to
   * avoid.
   */
  unrepresentable?: "throw" | "json";
}

/** Options for {@link digest}. */
export interface DigestOptions extends ImprintOptions, JcsOptions {
  /** Which canonical form to hash. Default `"imprint"`. */
  mode?: "imprint" | "jcs";
  /** Web Crypto digest algorithm. Default `"SHA-256"`. */
  algorithm?: "SHA-256" | "SHA-384" | "SHA-512" | "SHA-1";
  /** Output encoding. Default `"hex"`. */
  encoding?: "hex" | "base64url" | "bytes";
}

/** Thrown when a value cannot be represented in the requested canonical form. */
export class UnrepresentableValueError extends TypeError {
  override readonly name = "UnrepresentableValueError";
  /** Where in the value the problem is, as a dotted path from the root. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(path ? `${message} (at ${path})` : message);
    this.path = path;
  }
}
