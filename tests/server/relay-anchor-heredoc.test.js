const fs = require("fs");
const path = require("path");
const { classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2473: a pinned binding (Garry's own thread) ran one shell command that
// writes a Python question builder into /data/ops/live-recall/b4/ with a
// here-document and then runs it. The anchor rules read the Python as shell,
// so question text like "OpenClaw (the agent runtime)" counted as an
// openclaw command with a part the shell fills in, and the turn was refused.
// A body is now read in the language that reads it. Anchor names, real
// openclaw changes, shells, writes into the anchor and the relay's files stay
// refused.
const kPinned = "capy-25cf4e98b5b6";
const kDir = "/data/ops/live-recall/b4";
const kScript = kDir + "/build_questions.py";
const repoRoot = path.resolve(__dirname, "..", "..");

const builder = [
  "import json, os",
  "from pathlib import Path",
  "",
  "# Questions about OpenClaw (the runtime) and the gateway; never touches config.",
  "EXCLUDE = set(Path('/data/ops/live-recall/exclusions.txt').read_text().split())",
  "PAGES = Path('/data/ops/live-recall/pages-b4.txt').read_text().split()",
  "QUESTIONS = [",
  '    {"slug": "claw-maintenance", "q": "How does OpenClaw restart the gateway (and drain the running turn)?", "gold": "OpenClaw asks the gateway to drain (up to 30 s) before it exits."},',
  '    {"slug": "plugin-reload", "q": "What broke after the OpenClaw plugins update?", "gold": "A plugin (voice-call) failed to load; see /data/.openclaw/workspace/memory/2026-11-01.md."},',
  '    {"slug": "gateway-config", "q": "Which config does the gateway read at boot?", "gold": "OpenClaw reads its config (with $include files) once at boot."},',
  "]",
  "out = Path('" + kDir + "/questions-b4.jsonl')",
  "with out.open('w') as f:",
  "    for q in QUESTIONS:",
  "        if q['slug'] not in EXCLUDE and 'openclaw' in q['q'].lower():",
  "            f.write(json.dumps(q) + '\\n')",
  "os.chmod(out, 0o600)",
  'print(f"wrote {len(QUESTIONS)} questions")',
].join("\n");

const expectRefusedOutright = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/is refused in every relay session|would change what decides relay trust on this box/);
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

describe("relay anchor and here-documents (GST-2473)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });
  const pinnedRun = async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    return ctx.deliver(ctx.oauthDelegate(kPinned).agent);
  };

  it("runs the b4 builder: a Python script written by a here-document and then run, whose question text mentions OpenClaw, the gateway and plugins", async () => {
    const run = await pinnedRun();
    const commands = [
      "mkdir -p " + kDir + " && cat > " + kScript + " <<'PY'\n" + builder + "\nPY\npython3 " + kScript + " && chmod 600 " + kDir + "/questions-b4.jsonl && wc -l " + kDir + "/questions-b4.jsonl",
      "set -euo pipefail\ncd " + kDir + "\ncat > build_questions.py <<'PY'\n" + builder + "\nPY\npython3 -u build_questions.py 2>&1 | tail -5",
      "python3 - <<'PY'\n" + builder + "\nPY",
      "cat > " + kDir + "/notes.txt <<'EOF'\n" + builder + "\nEOF",
      "tee " + kDir + "/build_questions.py >/dev/null <<'PY'\n" + builder + "\nPY\npython3 " + kScript,
    ];
    for (const command of commands) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).toBeNull();
      expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("runs the exact shape refused on the box: a quoted here-document whose Python has dollar amounts and config, gateway and plugin words in its strings", async () => {
    const run = await pinnedRun();
    const body = [
      "import json,re,os",
      "B='/data/stronghold-brain/brain/'",
      "Q=[",
      '("acme-seed", "What did Acme raise?", "$1.9M ARR, then $450K at $40M"),',
      '("acme-burn", "What was the burn?", "$8K/mo; the plan was $4M-$10M"),',
      '("ngrok-err", "Why did the tunnel fail?", "ngrok: gateway config invalid (plugin missing): $2 retry"),',
      '("lmstudio-err", "What did LM Studio say?", "lmstudio: failed to load plugin config from /data/.openclaw/workspace/skills/lm/SKILL.md"),',
      "]",
      "with open('questions-b4.jsonl','w') as f:",
      "    for s,q,g in Q: f.write(json.dumps({'slug':s,'q':q,'gold':g})+'\\n')",
    ].join("\n");
    const first = "cd " + kDir + " && cat > build.py <<'EOF'\n" + body + "\nEOF\numask 077; python3 build.py";
    const second = "cd " + kDir + " && cat > build.py <<'EOF'\n" + body + "\nEOF\numask 077; python3 build.py; chmod 600 questions-b4.jsonl build.py; sha256sum questions-b4.jsonl | cut -c1-16";
    for (const command of [first, second]) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).toBeNull();
      expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    }
    // The same body run by a shell is still read as shell.
    expectRefusedOutright(await ctx.call(run, "exec", { command: "bash <<'EOF'\n" + body + "\nEOF" }), "bash");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still refuses the same body when a shell runs it", async () => {
    const run = await pinnedRun();
    for (const command of [
      "bash <<'PY'\n" + builder + "\nPY",
      "cat <<'PY' | bash\n" + builder + "\nPY",
      "cat > " + kScript + " <<'PY'\n" + builder + "\nPY\nbash " + kScript,
      "cat > " + kScript + " <<'PY'\n" + builder + "\nPY\nsh -c 'python3 " + kScript + "'",
      "cat > " + kScript + " <<'PY'\n" + builder + "\nPY\nexport PATH=/tmp; python3 " + kScript,
    ]) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).not.toBeNull();
      expectRefusedOutright(await ctx.call(run, "exec", { command }), command);
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still refuses a real openclaw config, plugins or gateway change inside the program", async () => {
    const run = await pinnedRun();
    const programs = [
      'import subprocess\nsubprocess.run(["openclaw", "config", "set", key, "false"])',
      'import subprocess\nsubprocess.run("openclaw config set " + key + " false", shell=True)',
      'import os\nos.system("openclaw plugins disable relay-guard")',
      'import os\nos.system(f"openclaw {group} set plugins.enabled false")',
      'import os\nos.system("openclaw --profile prod config set plugins.enabled false")',
      'import subprocess\nsubprocess.run(["openclaw", "gateway", "call", "config.apply"])',
      'import subprocess\nsubprocess.run(["openclaw", "config", "set", "plugins.load.paths", "[\\"' + repoRoot + '/lib/plugin/relay-guard\\"]"])',
    ];
    for (const program of programs) {
      const command = "cat > " + kScript + " <<'PY'\n" + program + "\nPY\npython3 " + kScript;
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), program).not.toBeNull();
      expectRefusedOutright(await ctx.call(run, "exec", { command }), program);
    }
    const node = "node - <<'JS'\nrequire('child_process').execFileSync('openclaw', ['config', 'set', key, 'false']);\nJS";
    expectRefusedOutright(await ctx.call(run, "exec", { command: node }), node);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still refuses a quoted anchor path passed as a real argument to an openclaw config write", async () => {
    const run = await pinnedRun();
    for (const command of [
      "openclaw config set plugins.load.paths '[\"" + repoRoot + "/lib/plugin/relay-guard\"]'",
      'openclaw config set gateway.trustFile "' + path.join(ctx.rootDir, "relay", "secrets.json") + '"',
    ]) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).not.toBeNull();
      expectRefusedOutright(await ctx.call(run, "exec", { command }), command);
    }
  });

  it("still refuses a here-document written into the anchor, through a symlink too", async () => {
    const run = await pinnedRun();
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(repoRoot, "lib"), path.join(workspace, "ac"));
    fs.symlinkSync(path.join(ctx.rootDir, "relay"), path.join(workspace, "rl"));
    for (const command of [
      "cat > " + path.join(repoRoot, "lib", "x.js") + " <<'EOF'\nhello\nEOF",
      "cat > ac/x.js <<'EOF'\nhello\nEOF",
      "tee ac/x.js >/dev/null <<'EOF'\nhello\nEOF",
      "cd " + workspace + " && cat > ac/x.js <<'EOF'\nhello\nEOF",
      "cat > rl/notes.txt <<'EOF'\nhello\nEOF",
      "cat > " + path.join(ctx.rootDir, "relay", "notes.txt") + " <<'EOF'\nhello\nEOF",
      "cat > " + ctx.openclawJson + " <<'EOF'\n{}\nEOF",
    ]) expectRefusedOutright(await ctx.call(run, "exec", { command }), command);
    expect(classifyAnchor({ toolName: "exec", params: { command: "cat > ac/x.js <<'EOF'\nhello\nEOF" }, rootDir: ctx.rootDir })).toEqual({ action: "write x.js from a shell command" });
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still refuses anchor names and the relay's files in a body, and any body the shell can fill in", async () => {
    const run = await pinnedRun();
    const relay = path.join(ctx.rootDir, "relay");
    for (const [label, body] of [
      ["the guard's directory", "open('" + repoRoot + "/lib/plugin/relay-guard/index.js', 'w')"],
      ["a relay database", "open('bridge.db', 'rb')"],
      ["a trust env name", "os.environ['ALPHACLAW_RELAY_TRUSTED_BINDINGS'] = 'x'"],
      ["openclaw.json", "Path('openclaw.json').write_text('{}')"],
      ["the relay's keys", "print(open('" + relay + "/secrets.json').read())"],
    ]) {
      const command = "cat > " + kScript + " <<'PY'\n" + body + "\nPY\npython3 " + kScript;
      expectRefusedOutright(await ctx.call(run, "exec", { command }), label);
    }
    const unquoted = "cat > " + kScript + " <<PY\n$(openclaw config set plugins.enabled false)\nPY\npython3 " + kScript;
    expectRefusedOutright(await ctx.call(run, "exec", { command: unquoted }), "an unquoted delimiter");
    expect(ctx.confirmationCount()).toBe(0);
  });
  it("still refuses a change hidden in an f-string or template field, behind a Node regular expression, before a sentence end, or in a body a shell runs as a script", async () => {
    const run = await pinnedRun();
    const exec = "require('child_process').execSync";
    const commands = [
      "python3 - <<'PY'\nimport os\nf\"{os.system('openclaw config set plugins.enabled false')}\"\nPY",
      "python3 - <<'PY'\nimport os\nprint(f'''{os.system(\"openclaw gateway call config.apply\")}''')\nPY",
      "node - <<'JS'\n`${" + exec + "('openclaw config set plugins.enabled false')}`\nJS",
      "node - <<'JS'\nconst u = /https?:\\/\\//; " + exec + "('openclaw config set plugins.enabled false')\nJS",
      "node - <<'JS'\nconst q = /'/; " + exec + "('openclaw config set plugins.enabled false')\nJS",
      "python3 - <<'PY'\nimport os\nos.system('openclaw config set plugins.enabled false && echo done.')\nPY",
      "python3 - <<'PY'\nimport os\nos.system('openclaw config set plugins.enabled false.')\nPY",
    ];
    const bin = path.join(ctx.rootDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "jq"), "#!/bin/sh\n", { mode: 0o755 });
    const script = "#!/bin/sh\n$A$B config set plugins.enabled false";
    commands.push(
      "cat > " + path.join(bin, "jq") + " <<'EOF'\n" + script + "\nEOF\njq",
      "cat > " + kDir + "/jq <<'EOF'\n" + script + "\nEOF\nchmod +x " + kDir + "/jq",
      "cat > " + kDir + "/jq <<'EOF'\n" + script + "\nEOF\nchmod 755 " + kDir + "/jq",
    );
    for (const command of commands) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).not.toBeNull();
      expectRefusedOutright(await ctx.call(run, "exec", { command }), command);
    }
    expect(ctx.confirmationCount()).toBe(0);
  });
});
