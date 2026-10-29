// Build a test inventory from one or more vitest JSON reports: every test
// with its file, full name, occurrence index (two tests may share a name),
// final status, assertion count and retry count (tests/setup-inventory.js).
// Several reports are the legs of one tier: a file that ran in two of them,
// or an empty report, is an error rather than a quietly merged inventory.
//
// Usage: node scripts/ci/test-inventory.mjs [--root <dir>] --out <inventory.json> <report.json>...
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A name that embeds the clock (an it.each row rendering a Date) differs on
// every run; key it on a placeholder so the same test matches itself.
const kTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g;
export const stableName = (name) => name.replace(kTimestamp, "<timestamp>");

const kStatus = { passed: "passed", failed: "failed", skipped: "skipped", pending: "skipped", disabled: "skipped", todo: "todo" };

export const buildInventory = (reports, { root = process.cwd() } = {}) => {
  if (reports.length === 0) throw new Error("no vitest JSON reports given");
  const fileSource = new Map();
  const files = [];
  const tests = [];
  for (const { source, report } of reports) {
    if (!report?.testResults?.length) throw new Error(`${source}: the report lists no test files`);
    for (const result of report.testResults) {
      const file = path.relative(root, result.name).split(path.sep).join("/");
      if (fileSource.has(file)) throw new Error(`${file} ran in two reports (${fileSource.get(file)} and ${source})`);
      fileSource.set(file, source);
      files.push({ file, status: result.status });
      const seen = new Map();
      for (const test of result.assertionResults) {
        const name = stableName(test.fullName);
        const occurrence = seen.get(name) ?? 0;
        seen.set(name, occurrence + 1);
        tests.push({
          file,
          name,
          occurrence,
          status: kStatus[test.status] ?? test.status,
          assertions: test.meta?.assertions ?? null,
          retries: test.meta?.retries ?? null,
        });
      }
    }
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { schema: 1, files, tests };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args.splice(i, 2)[1];
  };
  const out = take("--out");
  const root = path.resolve(take("--root") ?? process.cwd());
  if (!out || args.length === 0) {
    console.error("usage: test-inventory.mjs [--root <dir>] --out <inventory.json> <report.json>...");
    process.exit(2);
  }
  try {
    const inventory = buildInventory(
      args.map((source) => ({ source, report: JSON.parse(readFileSync(source, "utf8")) })),
      { root },
    );
    writeFileSync(out, JSON.stringify(inventory, null, 1) + "\n");
    console.log(`inventory: ${inventory.files.length} files, ${inventory.tests.length} tests -> ${out}`);
  } catch (err) {
    console.error(`inventory ERROR: ${err.message}`);
    process.exit(1);
  }
}
