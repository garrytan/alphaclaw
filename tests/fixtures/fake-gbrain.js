#!/usr/bin/env node
// A fake gbrain CLI for the relay brain archive tests, speaking gbrain
// 0.60.593's argv and exit contract. State lives in GBRAIN_FAKE_DIR:
//   calls.jsonl   one line per invocation: { argv, stdin, envKeys }
//   script.json   optional queues of scripted answers per command
//                 { "put": [{ "exit": 10, "json": {...}, "stderr": "..." }], ... }
//                 commands: sources, put, get, write-request, commit-push
//                 an entry { "hang": true } never answers; { "hangGrandchild": true }
//                 also leaves a child holding the pipes (pid in grandchild.pid)
//   pages.json    the brain: slug -> { revision, markdown }
// Without a scripted answer it behaves like gbrain: create-only without a
// revision, revision_conflict on a stale one, committed_local on commit-push.
const fs = require("fs");
const path = require("path");

const dir = process.env.GBRAIN_FAKE_DIR;
const argv = process.argv.slice(2);
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const command = argv[0] === "sources" ? "sources" : argv[0] === "git" ? "commit-push" : argv[0];

const finish = (stdin) => {
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, stdin, envKeys: Object.keys(process.env).sort() }) + "\n");
  const script = readJson("script.json", {});
  const queue = Array.isArray(script[command]) ? script[command] : [];
  const scripted = queue.shift();
  writeJson("script.json", script);
  const answer = (exit, json, stderr = "") => {
    if (json !== undefined) process.stdout.write(JSON.stringify(json));
    if (stderr) process.stderr.write(stderr);
    process.exit(exit);
  };
  if (scripted?.hangGrandchild) {
    const grandchild = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    fs.writeFileSync(path.join(dir, "grandchild.pid"), String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (scripted?.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  if (scripted) return answer(scripted.exit ?? 0, scripted.json, scripted.stderr || "");
  const pages = readJson("pages.json", {});
  if (command === "sources") {
    return answer(0, { sources: [{ id: "default", local_path: "/brain/default", federated: true }, { id: "relay", local_path: process.env.GBRAIN_FAKE_CHECKOUT || "/brain/relay", federated: false }] });
  }
  if (command === "put") {
    const slug = argv[1];
    const expected = flag("--expected-revision");
    const existing = pages[slug];
    if (existing && !expected) return answer(1, { code: "revision_required", retryable: false, write_request: { state: "conflict" } });
    if (existing && expected !== existing.revision) return answer(1, { code: "revision_conflict", retryable: false, write_request: { state: "conflict" } });
    if (!existing && expected) return answer(1, { code: "page_not_found", retryable: false });
    const revision = "rev-" + (Object.keys(pages).length + 1) + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    pages[slug] = { revision, markdown: stdin, conversationId: (/conversation_id: "([^"]*)"/.exec(stdin) || [])[1] };
    writeJson("pages.json", pages);
    return answer(0, { slug, revision, state: "committed", request_id: flag("--request-id"), persistence: { git_state: "queued" } });
  }
  if (command === "get") {
    const slug = argv[argv.length - 1];
    const page = pages[slug];
    if (!page) return answer(1, { code: "page_not_found", retryable: false });
    const body = String(page.markdown || "").replace(/^---\n[\s\S]*?\n---\n/, "");
    return answer(0, { slug, revision: page.revision, frontmatter: { conversation_id: page.conversationId }, compiled_truth: body, timeline: "" });
  }
  if (command === "write-request") return answer(0, { request_id: argv[argv.length - 1], state: "committed", revision: "rev-pending-committed" });
  if (command === "commit-push") {
    const paths = argv.slice(argv.indexOf("--") + 1);
    return answer(0, { outcome: "committed_local", sha: "abc1234", paths });
  }
  return answer(2, { code: "unknown_command" });
};

let stdin = "";
if (command === "put") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (stdin += chunk));
  process.stdin.on("end", () => finish(stdin));
} else {
  finish(null);
}
