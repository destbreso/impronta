// Resolving the previous release, which is what the differential scripts compare
// the working tree against.
//
// The property these scripts protect is "the same answer as before, only faster",
// and for that the published code IS the specification. So the baseline has to be
// a real published tarball rather than a copy of it sitting in the repo, which
// would rot silently into a copy of nothing in particular.
//
//   npm install --no-save impronta-baseline@npm:impronta@0.2.1
//
// Point IMPRONTA_BASELINE somewhere else to compare against a different release
// or a local build.

const spec = process.env.IMPRONTA_BASELINE ?? "impronta-baseline";

export const loadBaseline = async () => {
  try {
    return await import(spec);
  } catch (cause) {
    throw new Error(
      `could not load the baseline "${spec}". Install the release you want to ` +
        `compare against, aliased so it can sit next to the working tree:\n\n` +
        `  npm install --no-save impronta-baseline@npm:impronta@<version>\n\n` +
        `or set IMPRONTA_BASELINE to a path or another specifier.`,
      { cause },
    );
  }
};

export const loadCurrent = async () => {
  const url = new URL("../dist/index.js", import.meta.url);
  try {
    return await import(url.href);
  } catch (cause) {
    throw new Error("no dist/ to test. Run `npm run build` first.", { cause });
  }
};
