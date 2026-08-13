// Does the committed lockfile agree with the manifest?
//
//   node scripts/verify-lockfile.mjs
//
// This runs in `prepublishOnly` because the repository has already shipped the
// failure twice. 0.2.1 pinned `diff-conformance` to `link: true` into a sibling
// working directory, so `npm ci` produced a dangling symlink for everyone but
// me. 0.2.2 fixed that one and left `impronta`, the runtime dependency, still
// linked. Both times `npm install` had exited zero, and exiting zero was what
// got checked.
//
// The specific trap this closes: raising a dependency range for a package that
// is not on the registry yet. `npm install` cannot resolve it, so the manifest
// moves and the lockfile does not, and nothing notices until a stranger clones
// the repository. The fix is always the same and always available at publish
// time: publish the dependency first, then `npm install` here, then publish
// this. The point of the check is that it fails loudly at the moment the order
// was skipped, instead of quietly later.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = join(HERE, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

/**
 * Range satisfaction for the shapes a manifest in this repository uses:
 * `^x.y.z`, `~x.y.z`, an exact version, or `*`. Deliberately not a semver
 * dependency: a check that needs an install to run cannot run before one.
 */
function satisfies(version, range) {
  if (range === "*" || range === "latest") return true;
  const clean = range.replace(/^[\^~]/, "");
  const [rv, lv] = [clean, version].map((v) => v.split(".").map(Number));
  if (lv.some(Number.isNaN) || rv.some(Number.isNaN)) return undefined;
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!range.startsWith("^") && !range.startsWith("~")) return cmp(lv, rv) === 0;
  if (cmp(lv, rv) < 0) return false;
  // Caret on a 0.x range is minor-locked, which is the case that matters here:
  // every package in this fleet is below 1.0.
  if (range.startsWith("~") || (range.startsWith("^") && rv[0] === 0)) {
    return lv[0] === rv[0] && lv[1] === rv[1];
  }
  return lv[0] === rv[0];
}

const problems = [];

if (lock.version !== manifest.version) {
  problems.push(`the lockfile says this package is ${lock.version} and the manifest says ${manifest.version}`);
}

const declared = { ...manifest.dependencies, ...manifest.devDependencies };
const lockRoot = lock.packages?.[""] ?? {};
const lockDeclared = { ...lockRoot.dependencies, ...lockRoot.devDependencies };

for (const [name, range] of Object.entries(declared)) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) {
    problems.push(`${name} is in the manifest and absent from the lockfile`);
    continue;
  }
  if (entry.link) {
    problems.push(`${name} is recorded as a link to ${entry.resolved ?? "a local path"}, which no consumer has`);
    continue;
  }
  if (lockDeclared[name] !== range) {
    problems.push(`${name}: the manifest asks for ${range} and the lockfile was built for ${lockDeclared[name]}`);
    continue;
  }
  const ok = satisfies(entry.version, range);
  if (ok === false) problems.push(`${name}: the lockfile resolved ${entry.version}, which is outside ${range}`);
}

if (problems.length > 0) {
  process.stderr.write("the lockfile does not agree with the manifest:\n");
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.stderr.write(
    "\nIf a dependency range was raised to a version that is not published yet,\n" +
      "publish that package first, then run `npm install` here, then publish this.\n",
  );
  process.exit(1);
}

process.stdout.write(`the lockfile agrees with the manifest on ${Object.keys(declared).length} dependencies\n`);
