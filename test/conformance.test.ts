// impronta measured by the harness that was built before it.
//
// These assertions are not restatements of the unit tests. They are the same
// battery, run by an outside tool with its own idea of what a serializer owes
// its caller, against the same adapters it runs on every other package in the
// field. If impronta only passed its own tests, "no silent collisions" would be
// a claim about the tests rather than about the library.

import { describe, expect, it } from "vitest";
import {
  COLLISION_PROBES,
  defineSubject,
  runCollisions,
  runConformance,
  runDepth,
  runDeterminism,
} from "serializer-conformance";
import { imprint, jcs } from "../src/index.js";

const asImprint = defineSubject({
  name: "impronta.imprint",
  kind: "serializer",
  run: (value) => imprint(value),
});

const asJcs = defineSubject({
  name: "impronta.jcs",
  kind: "jcs",
  run: (value) => jcs(value),
});

describe("harness: RFC 8785 conformance", () => {
  it("passes every official vector", () => {
    const result = runConformance(asJcs);
    const failures = result.vectors.filter((v) => !v.pass);
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
    expect(result.passed).toBe(result.total);
  });
});

describe("harness: collisions", () => {
  it("imprint mode has zero collisions", () => {
    // The headline claim of the package, checked by the outside tool. Every
    // JSON-subset canonicalizer measured scores 7 or 8 here.
    const result = runCollisions(asImprint);
    const collided = result.findings.filter((f) => f.verdict === "collides");
    expect(
      collided,
      `collides on: ${collided.map((c) => `${c.probe} (${c.expectedToDiffer})`).join("; ")}`,
    ).toHaveLength(0);
  });

  it("imprint answers every probe rather than dodging by throwing", () => {
    // Zero collisions is trivially achievable by refusing everything, and the
    // harness scores a refusal as acceptable. This asserts the harder thing:
    // impronta produces an answer for each probe and the answers are distinct.
    const result = runCollisions(asImprint);
    const distinct = result.findings.filter((f) => f.verdict === "distinct");
    expect(distinct).toHaveLength(COLLISION_PROBES.length);
  });

  it("jcs mode collides only where JSON itself is lossy, and never silently elsewhere", () => {
    // JCS mode inherits JSON's semantics by definition. A Date and its ISO
    // string, and a class instance and its plain twin, are the same JSON
    // document, so they must collide; that is conformance, not a defect. Every
    // other probe must be either distinct or refused outright.
    const inherentToJson = new Set(["date-vs-string", "class-vs-plain", "signed-zero"]);
    const result = runCollisions(asJcs);
    const unexpected = result.findings.filter(
      (f) => f.verdict === "collides" && !inherentToJson.has(f.probe),
    );
    expect(
      unexpected,
      `unexpected jcs collisions: ${unexpected.map((c) => c.probe).join(", ")}`,
    ).toHaveLength(0);
  });
});

describe("harness: determinism", () => {
  it("both modes are keyed on content, never on object identity", () => {
    for (const subject of [asImprint, asJcs]) {
      const result = runDeterminism(subject);
      const unstable = result.findings.filter((f) => !f.stable).map((f) => f.case);
      expect(unstable, `${subject.name} unstable on: ${unstable.join(", ")}`).toHaveLength(0);
    }
  });
});

describe("harness: depth", () => {
  it("both modes are unbounded where every incumbent has a ceiling", () => {
    // The harness reports Infinity when its probe ceiling is reached without a
    // failure, which only an iterative implementation manages. Measured
    // ceilings elsewhere: json-canonicalize ~1.8k, canonicalize ~4.1k,
    // safe-stable-stringify ~4.1k, fast-json-stable-stringify ~5.9k.
    // serializer-conformance 0.4.0 turned the second argument from a bare
    // ceiling into an options object. This call kept passing a number and kept
    // passing, because vitest does not typecheck: the harness saw an options
    // object with no `ceiling` and used its default instead of 50,000. A green
    // suite is not a compiled suite, and `npm run typecheck` was the only thing
    // in this repo that could tell the two apart.
    expect(runDepth(asImprint, { ceiling: 50_000 }).maxDepth).toBe(Infinity);
    expect(runDepth(asJcs, { ceiling: 50_000 }).maxDepth).toBe(Infinity);
  });
});
