// The README's comparison table, checked against the committed report.
//
//   npm run verify:claims
//
// The table is transcribed by hand. `npm run report` writes docs/REPORT.md and
// the charts and never touches the README, so the two are free to drift, and
// they have: the release before this one shipped a README claiming both modes
// come out linear on both axes while the repo's own scaling table listed one of
// them superlinear, and describing a cost model two versions out of date.
//
// This does not re-run anything. Regenerating and checking are different jobs
// and only one of them has to be cheap enough to run before every publish.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const report = readFileSync(join(root, "docs/REPORT.md"), "utf8");

const problems = [];
let checked = 0;

/** Cells of a markdown row, stripped of bold and backticks. */
const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().replace(/\*\*/g, "").replace(/`/g, ""));

/**
 * The lines of one `## Section`, and only that one.
 *
 * Scoping matters more than it looks: the report holds several two-column
 * tables keyed by subject, and reading them all left the last one winning, so
 * the checker compared collision counts against output lengths and reported
 * mismatches that were its own. The instrument was wrong before the subject.
 */
function section(name) {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** subject -> collisions, from the summary table inside the collisions section. */
const collisions = new Map();
for (const line of section("Collisions")) {
  const c = cells(line);
  if (c.length === 2 && /^\d+$/.test(c[1])) collisions.set(c[0], Number(c[1]));
}

/** subject -> max depth, from the depth section. */
const depth = new Map();
for (const line of section("Nesting depth")) {
  const c = cells(line);
  if (c.length === 3 && (c[1] === "unbounded" || /^[\d,]+$/.test(c[1]))) {
    depth.set(c[0], c[1] === "unbounded" ? "unbounded" : Number(c[1].replace(/,/g, "")));
  }
}

if (collisions.size === 0 || depth.size === 0) {
  console.log("could not read the report's tables, so this script is checking nothing");
  process.exit(1);
}

for (const line of readme.split("\n")) {
  const c = cells(line);
  if (c.length !== 4) continue;
  const [subject, coll, , maxDepth] = c;
  if (!collisions.has(subject)) continue;

  checked++;

  // The README writes "3, all inherent to JSON"; the count is what must match.
  const claimed = Number((coll.match(/^\d+/) ?? [])[0]);
  const actual = collisions.get(subject);
  if (claimed !== actual) {
    problems.push(`${subject}: README says ${coll} collisions, the report says ${actual}`);
  }

  // Depth is written as an order of magnitude ("~4,100"), so allow 5%, and
  // require "unbounded" to be exact because it is a categorical claim.
  const reportDepth = depth.get(subject);
  if (maxDepth === "unbounded" || reportDepth === "unbounded") {
    if (maxDepth !== reportDepth) {
      problems.push(`${subject}: README says depth ${maxDepth}, the report says ${reportDepth}`);
    }
  } else {
    const claimedDepth = Number(maxDepth.replace(/[~,]/g, ""));
    if (Number.isFinite(claimedDepth) && Math.abs(claimedDepth - reportDepth) / reportDepth > 0.05) {
      problems.push(`${subject}: README says depth ${maxDepth}, the report says ${reportDepth.toLocaleString("en-US")}`);
    }
  }
}

if (checked === 0) {
  console.log("no README rows matched a subject in the report, which means this has stopped checking anything");
  process.exit(1);
}

for (const p of problems) console.log(`  MISMATCH  ${p}`);
console.log(
  problems.length === 0
    ? `${checked} rows of the README's comparison table agree with docs/REPORT.md.`
    : `\n${problems.length} of ${checked} rows disagree with the committed run. Regenerate the report or fix the README.`,
);
process.exit(problems.length === 0 ? 0 : 1);
