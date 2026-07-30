// The half nobody else ships: canonical form and digest in one call.
//
// The audit that started this library found the field split cleanly in two.
// `canonicalize` and `json-canonicalize` produce the string and never hash it.
// `object-hash`, `ohash` and `stable-hash` produce a digest and are not RFC
// 8785. If you need a content address, you are expected to glue one of each
// together and get the composition right yourself, which is where the type
// handling of the serializer silently becomes the collision resistance of your
// hash.
//
// Web Crypto is used directly, so there is no dependency and the same code runs
// on Node 18+, Deno, Bun, browsers and edge runtimes.

import { imprint } from "./imprint.js";
import { jcs } from "./jcs.js";
import type { DigestOptions } from "./types.js";

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // btoa is available in every runtime this package targets (Node 16+ included).
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Return type inferred on purpose: naming SubtleCrypto would pull in the DOM
// lib, and this package must typecheck in a Node-only, DOM-free project.
function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "Web Crypto is unavailable. impronta needs globalThis.crypto.subtle, " +
      "which exists in Node 18+, Deno, Bun, browsers and edge runtimes. " +
      "In an older Node, `globalThis.crypto = require('node:crypto').webcrypto`.",
    );
  }
  return c.subtle;
}

/**
 * The canonical form of a value, without hashing it.
 *
 * Defaults to the extended form. Pass `mode: "jcs"` for byte-exact RFC 8785,
 * which is what you want when the bytes have to match an implementation in
 * another language.
 */
export function canonicalize(value: unknown, options: DigestOptions = {}): string {
  return (options.mode ?? "imprint") === "jcs" ? jcs(value, options) : imprint(value, options);
}

/**
 * Canonicalize a value and hash it, in one call.
 *
 * Async because Web Crypto is async. If you need the digest synchronously,
 * canonicalize first and hash with whatever synchronous primitive you already
 * have; the canonical form is the part that is hard to get right.
 *
 * @example
 * await digest({ b: 1, a: 2 });                       // hex SHA-256
 * await digest(value, { algorithm: "SHA-512" });
 * await digest(value, { mode: "jcs" });               // cross-language
 * await digest(value, { encoding: "bytes" });         // Uint8Array
 */
export async function digest(
  value: unknown,
  options: DigestOptions & { encoding: "bytes" },
): Promise<Uint8Array>;
export async function digest(value: unknown, options?: DigestOptions): Promise<string>;
export async function digest(
  value: unknown,
  options: DigestOptions = {},
): Promise<string | Uint8Array> {
  const canonical = canonicalize(value, options);
  const encoded = new TextEncoder().encode(canonical);
  const buffer = await subtle().digest(options.algorithm ?? "SHA-256", encoded);
  const bytes = new Uint8Array(buffer);

  switch (options.encoding ?? "hex") {
    case "bytes": return bytes;
    case "base64url": return bytesToBase64Url(bytes);
    default: return bytesToHex(bytes);
  }
}
