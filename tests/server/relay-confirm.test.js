const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const express = require("express");
const request = require("supertest");

const { classifyRisk, checkConfirmation } = require("../../lib/plugin/relay-guard/confirm");
const { createRelayGuardPlugin } = require("../../lib/plugin/relay-guard");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { openRemoteStore, sha256 } = require("../../lib/server/relay/remote-store");
const { createRelayConfirmations } = require("../../lib/server/relay/confirmations");
const { registerRelayConfirmRoutes } = require("../../lib/server/routes/relay-confirm");
const { createRelayService } = require("../../lib/server/relay");
const { relayPaths } = require("../../lib/server/relay/constants");

// Relay trust v2 PR2 (GST-2090): a delegate's high-risk call waits for the
// owner's one-tap confirmation, which admits that one call once.
const kClient = "d1df4e9e-8f1b-4520-98f6-2db9ab5d035f";
const kAgent = "capy-25cf4e98b5b6";
const kHour = 60 * 60 * 1000;
const quiet = { log: () => {}, warn: () => {}, info: () => {}, error: () => {} };

describe("relay confirmations: the signing key and relay files by any path that lands on them", () => {
  let root;
  let workspace;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-keypath-")));
    workspace = path.join(root, ".openclaw", "workspace-scout");
    fs.mkdirSync(path.join(root, "relay"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(root, "relay", "provenance-key.json"), "{}");
    fs.writeFileSync(path.join(root, "relay", "bridge.db"), "");
    fs.symlinkSync(path.join(root, "relay", "provenance-key.json"), path.join(workspace, "notes.txt"));
    fs.symlinkSync(path.join(root, "relay"), path.join(workspace, "box"));
    fs.symlinkSync(root, path.join(root, "..", path.basename(root) + "-link"));
  });
  afterEach(() => {
    fs.rmSync(path.join(root, "..", path.basename(root) + "-link"), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (filePath, toolName = "write") => classifyRisk({ toolName, params: toolName === "apply_patch" ? { input: "*** Begin Patch\n*** Update File: " + filePath + "\n*** End Patch" } : { path: filePath }, rootDir: root, agentId: "scout" });

  it.each([
    ["a relative path with . and ..", "../../relay/./provenance-key.json"],
    ["a relative path through a sibling directory", "../workspace/../../relay/provenance-key.json"],
    ["a symlink in the workspace to the key", "notes.txt"],
    ["a linked directory over relay/", "box/provenance-key.json"],
    ["a linked directory over a relay database", "box/bridge.db"],
    ["an absolute path through a linked root", "ROOTLINK/relay/provenance-key.json"],
    ["an absolute path to the key with a .. in it", "ROOT/relay/../relay/provenance-key.json"],
    ["the key by name anywhere", "some/dir/provenance-key.json"],
    ["a file reference with a leading @", "@notes.txt"],
    ["an @ path through a linked directory", "@box/bridge.db"],
    ["an @ path under relay/", "@ROOT/relay/sub/x"],
    ["a percent-encoded file: URL to the key", "file://ROOT/relay/provenance%2Dkey.json"],
    ["a percent-encoded file: URL to a relay database", "file://ROOT/relay/bridge%2Edb"],
  ])("holds %s", (_name, given) => {
    const filePath = given.replace("ROOTLINK", path.join(root, "..", path.basename(root) + "-link")).replace("ROOT", root);
    for (const tool of ["write", "edit", "apply_patch"]) {
      const risk = write(filePath, tool);
      expect(risk.kind, tool + " " + filePath).toBe("high");
    }
  });

  it("names the file the write lands on, and leaves ordinary workspace files alone", () => {
    expect(write("notes.txt").action).toBe("write provenance-key.json");
    expect(write("box/bridge.db").target).toContain("/relay/bridge.db");
    fs.writeFileSync(path.join(workspace, "plain.md"), "x");
    for (const given of ["plain.md", "drafts/new.md", "../workspace-scout/plain.md", "relay-notes/key.txt"]) {
      expect(write(given).kind, given).toBe("low");
    }
  });

  it("walks .. from the real directory a link reaches, not from the link's own parent", () => {
    fs.mkdirSync(path.join(root, "relay", "child"));
    fs.symlinkSync(path.join(root, "relay", "child"), path.join(workspace, "child"));
    for (const tool of ["write", "edit", "apply_patch"]) {
      const risk = write(workspace + "/child/../bridge.db", tool);
      expect(risk.kind, tool).toBe("high");
      expect(risk.target, tool).toBe(path.join(root, "relay", "bridge.db"));
    }
  });

  it("folds .. before following links for a relative path, as OpenClaw's write tool does", () => {
    fs.mkdirSync(path.join(root, "elsewhere", "deep"), { recursive: true });
    fs.symlinkSync(path.join(root, "elsewhere", "deep"), path.join(workspace, "child"));
    for (const tool of ["write", "edit", "apply_patch"]) {
      const risk = write("child/../notes.txt", tool);
      expect(risk.kind, tool).toBe("high");
      expect(risk.target, tool).toBe(path.join(root, "relay", "provenance-key.json"));
    }
  });

  it("names the file OpenClaw writes when a relative path climbs out through a link", () => {
    const far = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-far-")));
    try {
      fs.mkdirSync(path.join(far, "a", "b"), { recursive: true });
      fs.symlinkSync(path.join(far, "a", "b"), path.join(workspace, "L"));
      for (const tool of ["write", "edit", "apply_patch"]) {
        const config = write("L/../../openclaw.json", tool);
        expect(config.kind, tool).toBe("high");
        expect(config.target.split(","), tool).toContain(path.join(root, ".openclaw", "openclaw.json"));
        expect(write("L/../../../relay/bridge.db", tool).target.split(","), tool).toContain(path.join(root, "relay", "bridge.db"));
      }
    } finally {
      fs.rmSync(far, { recursive: true, force: true });
    }
  });

  it("keeps trailing spaces in a path, as the write tool does", () => {
    fs.symlinkSync(path.join(root, "relay", "provenance-key.json"), path.join(workspace, "notes.md "));
    for (const tool of ["write", "edit"]) expect(write("notes.md ", tool).kind, tool).toBe("high");
  });

  it("binds a link with a protected name to the file it lands on", () => {
    fs.symlinkSync(path.join(root, "relay", "provenance-key.json"), path.join(workspace, ".env"));
    const risk = write(".env");
    expect(risk.action).toBe("write provenance-key.json");
    expect(risk.target).toBe(path.join(root, "relay", "provenance-key.json"));
    fs.writeFileSync(path.join(root, "elsewhere.txt"), "");
    fs.symlinkSync(path.join(root, "elsewhere.txt"), path.join(workspace, "secrets.json"));
    expect(write("secrets.json")).toMatchObject({ kind: "high", action: "write elsewhere.txt", target: path.join(root, "elsewhere.txt") });
  });

  it("decodes a file: URL before the name rules, for every protected name", () => {
    for (const given of ["file:///data/.openclaw/openclaw%2Ejson", "file:///data/secrets%2Ejson", "file:///data/%2Eenv", "file:///data/exec-approvals%2Ejson"]) {
      expect(write(given).kind, given).toBe("high");
    }
  });

  it("reads a leading @ the way the pinned OpenClaw does", async () => {
    const dist = path.resolve(__dirname, "../../node_modules/openclaw/dist");
    const file = fs.readdirSync(dist).find((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(dist, name), "utf8").includes("function normalizeFileReferencePrefix("));
    expect(file, "OpenClaw's normalizeFileReferencePrefix moved; recheck openclawPathOf in confirm.js").toBeTruthy();
    const mod = await import(pathToFileURL(path.join(dist, file)).href);
    const normalize = Object.values(mod).find((value) => typeof value === "function" && value.name === "normalizeFileReferencePrefix");
    expect(normalize).toBeTypeOf("function");
    fs.symlinkSync(path.join(root, "relay", "provenance-key.json"), path.join(workspace, "@lit"));
    for (const [given, lands] of [["@notes.txt", "notes.txt"], ["@@lit", "./@lit"], ["notes.txt", "notes.txt"], ["@box/bridge.db", "box/bridge.db"]]) {
      expect(normalize(given), given).toBe(lands);
      expect(write(given).kind, given).toBe("high");
    }
  });

  it("holds a link to a protected file that does not exist yet, since the write creates it", () => {
    fs.rmSync(path.join(root, "relay", "provenance-key.json"));
    fs.symlinkSync(path.join(root, "relay", "bridge.db-journal"), path.join(workspace, "journal.txt"));
    fs.symlinkSync(path.join(root, "missing", "exec-approvals.json"), path.join(workspace, "approvals.txt"));
    for (const given of ["notes.txt", "journal.txt", "approvals.txt"]) {
      for (const tool of ["write", "edit", "apply_patch"]) expect(write(given, tool).kind, tool + " " + given).toBe("high");
    }
    expect(write("notes.txt").target).toBe(path.join(root, "relay", "provenance-key.json"));
  });

  it("holds a patch header OpenClaw applies after trimming its indent", () => {
    for (const header of ["  *** Update File: .env", "\t*** Add File: box/bridge.db", " *** Delete File: notes.txt", "*** Update File: plain.md\n  *** Move to: x/openclaw.json"]) {
      const risk = classifyRisk({ toolName: "apply_patch", params: { input: "*** Begin Patch\n" + header + "\n*** End Patch" }, rootDir: root, agentId: "scout" });
      expect(risk.kind, header).toBe("high");
    }
  });

  it("resolves a relative write against the main workspace and the workspace openclaw.json sets for the agent", () => {
    const main = path.join(root, ".openclaw", "workspace");
    const custom = path.join(root, ".openclaw", "scout-files");
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    fs.symlinkSync(path.join(root, "relay"), path.join(main, "mainbox"));
    fs.symlinkSync(path.join(root, "relay"), path.join(custom, "custombox"));
    const at = (agentId, given) => classifyRisk({ toolName: "write", params: { path: given }, rootDir: root, agentId }).kind;
    expect(at("main", "mainbox/bridge.db")).toBe("high");
    expect(at("", "mainbox/bridge.db")).toBe("high");
    expect(at("scout2", "custombox/bridge.db")).toBe("low");
    fs.writeFileSync(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "scout2", workspace: custom }] } }));
    expect(at("scout2", "custombox/bridge.db")).toBe("high");
    expect(at("scout2", "custombox/notes.md")).toBe("high");
    expect(at("scout2", "plain.md")).toBe("low");
    fs.writeFileSync(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { entries: { scout2: { workspace: custom } } } }));
    expect(at("scout2", "custombox/bridge.db")).toBe("high");
    fs.writeFileSync(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "scout" }] } }));
    expect(at("scout", "mainbox/bridge.db")).toBe("high");
  });

  it("never lets one approval cover a longer file list than the notice showed", () => {
    const pad = [1, 2, 3, 4].map((i) => "*** Add File: .env." + String(i).repeat(75) + "\n+x").join("\n");
    const patch = (extra) => classifyRisk({ toolName: "apply_patch", params: { input: "*** Begin Patch\n" + pad + extra + "\n*** End Patch" }, rootDir: root, agentId: "scout" });
    const four = patch("");
    const five = patch("\n*** Update File: " + path.join(root, "relay", "provenance-key.json") + "\n@@\n+x");
    expect(four.kind).toBe("high");
    expect(five.target).not.toBe(four.target);
    expect(five.action).toMatch(/ \+5 files$/);
  });
});

describe("relay confirmations: only a command that can change a protected file is held", () => {
  const root = "/data/.alphaclaw";
  const exec = (command) => classifyRisk({ toolName: "exec", params: { command }, rootDir: root });
  const backtick = String.fromCharCode(96);

  // The three holds that reached the owner on the box before this change
  // (relay_confirmations rc_f987f71119f72b8e, rc_6a777d4fc7d348ee and
  // rc_83276ef4285dc973), as the agent sent them: two reads and two notes.
  it.each([
    ["a grep whose regex spells process.env", 'cd /data/.openclaw/workspace && grep -rn -i -E "openphone|quo_api|QUO_" memory/reference/tools-reference.md TOOLS.md MEMORY.md 2>/dev/null | cut -c1-200 | head -10; grep -rln -i "openphone" scripts lib skills services hooks/transforms 2>/dev/null | head -10; grep -rhoE "process\\.env\\.[A-Z_]*(OPENPHONE|QUO)[A-Z_]*" scripts lib skills services hooks 2>/dev/null | sort -u'],
    ["a note that mentions alphaclaw.json and openclaw.json", 'cd /data/.openclaw/workspace && echo "- 2026-11-10T05:12:21Z removed hooks/bootstrap/reference/AGENTS.md from hooks.internal.entries.bootstrap-extra-files.paths … Undo: Doctor POST /api/doctor/prompt-files/reference… Pending: alphaclaw.json promptFiles.reference opt-out … openclaw.json mode reset 0644->0600 … <!-- project: example -->" >> memory/2026-11-10.md && echo ok'],
    ["the word alphaclaw.json written to a scratch file", "echo alphaclaw.json > /data/tmp/tap-test.txt"],
  ])("does not hold %s", (_name, command) => {
    expect(exec(command)).toEqual({ kind: "low", action: null, target: null });
  });

  it.each([
    ["a hash and a listing", "sha256sum /data/.openclaw/openclaw.json && ls -la /data/.env*"],
    ["tests and a cut of .env", "test -f .env && cat .env | cut -d= -f1"],
    ["a note then a read of it", 'echo "checked alphaclaw.json" >> memory/n.md && tail -3 memory/n.md'],
    ["a mkdir then a note", "mkdir -p memory && echo 'checked .env today' >> memory/2026-11-10.md"],
    ["a count through sort and uniq", "cat openclaw.json | sort | uniq -c | head"],
    ["a grep by its /usr/bin path", "/usr/bin/grep x openclaw.json"],
  ])("does not hold %s", (_name, command) => {
    expect(exec(command).kind).toBe("low");
  });

  const kProtected = [
    ["/data/.openclaw/openclaw.json", "openclaw.json"],
    ["/data/.openclaw/alphaclaw.json", "alphaclaw.json"],
    ["/data/.openclaw/exec-approvals.json", "exec-approvals.json"],
    ["/data/.alphaclaw/relay/secrets.json", "secrets.json"],
    ["/data/.alphaclaw/relay/internal.secret", "internal.secret"],
    ["/data/.alphaclaw/relay/provenance-key.json", "provenance-key.json"],
    ["/data/.openclaw/agents/main/agent/auth-profiles.json", "auth-profiles.json"],
    ["/data/.env", ".env"],
    ["/data/.env.local", ".env.local"],
    ["/app/lib/plugin/relay-guard/policy.js", "relay-guard"],
    ["/data/.openclaw/extensions/wm-guards/index.js", "wm-guards"],
    ["/data/.alphaclaw/relay/bridge.db", "bridge.db"],
    ["/data/.alphaclaw/relay/remote.db", "remote.db"],
    ["/data/.alphaclaw/relay/relaycast.db", "relaycast.db"],
    ["/data/.alphaclaw/relay/archive.db", "archive.db"],
  ];
  const kWrites = [
    (file) => "echo x >> " + file,
    (file) => "cd /tmp && echo x >" + file,
    (file) => "rm -f " + file,
    (file) => "cp /tmp/x " + file,
    (file) => "mv " + file + " /tmp/x",
    (file) => "echo x | tee -a " + file,
    (file) => "sed -i s/a/b/ " + file,
    (file) => "python3 - <<'EOF'\nopen('" + file + "', 'w')\nEOF",
    (file) => "echo rm " + file + " | sh",
  ];
  it.each(kProtected.flatMap(([file, name]) => kWrites.map((write) => [write(file), name])))("still holds %s", (command, name) => {
    const risk = exec(command);
    expect(risk.kind).toBe("high");
    expect(risk.action).toBe("run a command on " + name);
  });

  it.each([
    ["a script piped into sh", "printf 'rm openclaw.json' | sh"],
    ["a printf note", "printf '%s\\n' 'see openclaw.json' >> notes/today.md"],
    ["a PATH set by printf %n", "printf '%s%n' xxxx PATH; cat openclaw.json"],
    ["a here-document fed to bash", "cat <<'EOF' | bash\nrm openclaw.json\nEOF"],
    ["a here-string fed to sh", 'sh <<< "rm openclaw.json"'],
    ["a delete inside $( )", "echo $(rm openclaw.json)"],
    ["a delete inside backticks", "echo " + backtick + "rm openclaw.json" + backtick],
    ["a delete inside a variable default", 'echo "$' + '{x:-$(rm openclaw.json)}"'],
    ["a delete inside an unquoted here-document", "cat <<EOF > memory/x.md\n$(rm openclaw.json)\nEOF"],
    ["a redirect through a variable", "f=openclaw.json; echo {} > $f"],
    ["a delete through a variable", 'f=openclaw.json; rm "$f"'],
    ["a variable set by printf -v", "printf -v f %s openclaw.json; rm $f"],
    ["a reassigned HOME", "HOME=/data/.openclaw/openclaw.json; echo {} > $HOME"],
    ["a function argument", 'f() { rm "$1"; }; f openclaw.json'],
    ["a loop variable", "for f in openclaw.json; do echo {} > $f; done"],
    ["file names piped into xargs", "echo openclaw.json | xargs rm"],
    ["a literal script file", "printf '%s\n' 'sed -i s/a/b/ openclaw.json' > /tmp/x.sh"],
    ["a login file", "echo 'rm /data/.openclaw/openclaw.json' >> ~/.profile"],
    ["a copy out into a json file", "cat openclaw.json > /tmp/copy.json"],
    ["a copy of a protected file into a text note", "cat openclaw.json > /tmp/copy.txt"],
    ["a dotfile note", "echo openclaw.json >> memory/.notes.md"],
    ["a script written and then run", 'echo "rm alphaclaw.json" > /tmp/s.sh; sh /tmp/s.sh'],
    ["a script written and then piped into sh", 'echo "rm alphaclaw.json" > /tmp/s; cat /tmp/s | sh'],
    ["a script written by tee and then run", 'echo "rm alphaclaw.json" | tee /tmp/s; sh /tmp/s'],
    ["a process substitution", "cat <(echo openclaw.json) | tee >(sh)"],
    ["an fd redirect", "echo x 1>openclaw.json"],
    ["an &> redirect", "echo x &>openclaw.json"],
    ["a clobbering redirect", "echo x >| openclaw.json"],
    ["a read-write redirect", "exec 3<>openclaw.json"],
    ["a >& file redirect", "cat x >&openclaw.json"],
    ["dd of=", "echo {} | dd of=openclaw.json"],
    ["an escaped dot", "rm openclaw\\.json"],
    ["a name split by quotes", "rm open''claw.json"],
    ["sudo tee", "sudo tee /data/.env < x"],
    ["sqlite3 opening the bridge database read-only", "sqlite3 ~/.alphaclaw/relay/bridge.db .tables"],
    ["a command the reader cannot split", 'echo "alphaclaw.json >> x'],
    ["a quoted here-document note", "cat <<'EOF' >> memory/notes.md\nChecked alphaclaw.json and .env today.\n$(rm openclaw.json) stays text\nEOF"],
    ["a dated note with substitutions", 'echo "$(date -u +%H:%M) checked alphaclaw.json" >> "memory/$(date +%F).md"'],
    ["a note under $HOME after a read", 'grep -q x ~/.openclaw/openclaw.json && echo "openclaw.json ok" >> $HOME/memory/n.md'],
    ["a [ ] test before a cut of .env", "test -w openclaw.json && echo ok; [ -f .env ] && cat .env | cut -d= -f1"],
    ["a copy out through tee", "cat openclaw.json | tee /tmp/copy.json"],
    ["a here-string into grep", 'grep -c x <<< "openclaw.json"'],
  ])("still holds %s", (_name, command) => {
    expect(exec(command).kind).toBe("high");
  });

  // Commands that got past the shell reader this rule replaced, or that a
  // literal split must not take as a read or a note.
  it.each([
    'f=openclaw.json; echo "rm $f" | sh',
    'f=openclaw.json; echo "rm $f" > /tmp/s; sh /tmp/s',
    'cat() { sh; }; echo "rm openclaw.json" | cat',
    "cat() { xargs rm; }; echo openclaw.json | cat",
    "echo 'rm \"$1\"' > /tmp/cat; chmod +x /tmp/cat; /tmp/cat openclaw.json",
    "shopt -s expand_aliases\nalias cat=rm\ncat openclaw.json",
    "f=openclaw.json; echo $f | xargs rm",
    'f=openclaw.json; sh <<< "rm $f"',
    "f=openclaw.json; sh <<EOF\nrm $f\nEOF",
    "export f=openclaw.json; sh <<'EOF'\nrm $f\nEOF",
    "printf '#!/bin/sh\\nrm \"$1\"' > /usr/local/bin/cat; cat openclaw.json",
    "cp /tmp/x /usr/local/bin/cat; cat openclaw.json",
    'function cat { sh; }; echo "rm openclaw.json" | cat',
    "PATH=/tmp cat openclaw.json",
    "PATH=/tmp; cat openclaw.json",
    "/tmp/cat openclaw.json",
    "./cat openclaw.json",
    "/tmp/cat; cat openclaw.json",
    "echo $(cp /tmp/x /usr/local/bin/cat); cat openclaw.json",
    'f=openclaw.json; echo "rm $f" | tee /tmp/s; sh /tmp/s',
    "printf -v PATH /tmp; cat openclaw.json",
    "echo x | sort -o/usr/bin/cat; cat openclaw.json",
    "echo x | sort --output=/usr/bin/cat; cat openclaw.json",
    "sort -o /usr/bin/cat x; cat openclaw.json",
    "sort --compress-program=sh openclaw.json",
    "echo() { cat openclaw.json; }; cp /tmp/x /usr/local/bin/cat; hash -r; echo",
    "while cat openclaw.json; do cp /tmp/x /usr/local/bin/cat; hash -r; done",
    "{ head -c 100000000 /dev/zero | wc -c; cat openclaw.json; } & cp /tmp/x /usr/local/bin/cat",
    "LD_PRELOAD=/tmp/x.so cat openclaw.json",
    "LD_LIBRARY_PATH=/tmp cat openclaw.json",
    "echo $[PATH=0]; cat openclaw.json",
    "echo ${HOME:+'}'}; rm openclaw.json # '",
    "f=openclaw.json; rm ${HOME:+$f}",
    "echo $[ cat , PATH=0 ]; cat openclaw.json",
    "echo ${x:-$[PATH=0]}; cat openclaw.json",
    'PATH="/tmp:/bin/cat"; cat openclaw.json',
    "echo $(echo 'rm $1' | tee /usr/local/bin/cat); cat openclaw.json",
    "[[ PATH=0 -eq 0 ]]; cat openclaw.json",
    "f=openclaw.json; eval 'rm $f'",
    'f=openclaw.json; sh -c "rm \\$f"',
    "f=openclaw.json; export f; sh -c 'rm $f'",
    "f=openclaw.json; export f; python3 -c 'import os; os.remove(os.environ[\"f\"])'",
    "echo openclaw.json > /data/.openclaw/o*",
    "echo note >> memory/n # '\nrm openclaw.json\n'",
    'echo \\"; rm openclaw.json; echo \\"',
    "echo x &>openclaw.json",
  ])("still holds %s", (command) => {
    expect(exec(command).kind).toBe("high");
  });

  it("holds a note written through a symlink onto the signing key", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-note-link-")));
    try {
      fs.mkdirSync(path.join(dir, "relay"));
      fs.writeFileSync(path.join(dir, "relay", "provenance-key.json"), "{}");
      fs.symlinkSync(path.join(dir, "relay", "provenance-key.json"), path.join(dir, "note.md"));
      const risk = classifyRisk({ toolName: "exec", params: { command: "echo openclaw.json > " + path.join(dir, "note.md") }, rootDir: dir });
      expect(risk.kind).toBe("high");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds a note written over an executable", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-note-exec-")));
    try {
      fs.writeFileSync(path.join(dir, "cat"), "#!/bin/sh\n");
      fs.chmodSync(path.join(dir, "cat"), 0o755);
      fs.writeFileSync(path.join(dir, "tool.txt"), "#!/bin/sh\n");
      fs.chmodSync(path.join(dir, "tool.txt"), 0o755);
      fs.writeFileSync(path.join(dir, "plain.txt"), "");
      expect(exec("echo openclaw.json > " + path.join(dir, "cat")).kind).toBe("high");
      expect(exec("echo openclaw.json > " + path.join(dir, "tool.txt")).kind).toBe("high");
      expect(exec("echo openclaw.json > " + path.join(dir, "plain.txt")).kind).toBe("low");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a double-quoted line continuation and a quoted ~ as bash does", () => {
    expect(exec('echo openclaw.json >> "/data/.alphaclaw/rel\\\nay/x.md"').kind).toBe("high");
    expect(exec('echo openclaw.json > "/data/.openclaw/plugins/relay-\\\nguard/notes.md"').kind).toBe("high");
    expect(exec('rm "open\\\nclaw.json"').kind).toBe("high");
    expect(exec('cd /data/.alphaclaw/relay && mkdir "~" && echo openclaw.json > "~/x.md"').kind).toBe("high");
    expect(exec('cd "~/x" && echo openclaw.json >> notes.md').kind).toBe("high");
    expect(exec('echo "a\\\nb" openclaw.json >> /data/tmp/notes.md').kind).toBe("low");
    expect(exec("echo openclaw.json >> ~/notes.md").kind).toBe("low");
  });

  it("holds a read run with exec env overrides", () => {
    const run = (params) => classifyRisk({ toolName: "exec", params: { command: "cat openclaw.json", ...params }, rootDir: root }).kind;
    expect(run({ env: { PATH: "/tmp" } })).toBe("high");
    expect(run({ env: {} })).toBe("low");
    expect(run({})).toBe("low");
  });

  it("resolves a relative note from the exec workdir and an absolute cd only", () => {
    const run = (command, params = {}) => classifyRisk({ toolName: "exec", params: { command, ...params }, rootDir: root }).kind;
    expect(run("echo openclaw.json >> notes.md", { workdir: os.tmpdir() })).toBe("low");
    expect(run("echo openclaw.json >> notes.md", { workdir: "sub" })).toBe("high");
    expect(run("cd " + os.tmpdir() + " && echo openclaw.json >> notes.md")).toBe("low");
    expect(run("cd .. && echo openclaw.json >> notes.md")).toBe("high");
    expect(run("cd .. && echo openclaw.json >> " + path.join(os.tmpdir(), "notes.md"))).toBe("low");
  });

  it("holds a program outside /bin and /usr/bin typed into a process", () => {
    expect(classifyRisk({ toolName: "process", params: { action: "write", sessionId: "s1", data: "/tmp/cat openclaw.json" } }).kind).toBe("high");
    expect(classifyRisk({ toolName: "process", params: { action: "write", sessionId: "s1", data: "cat openclaw.json" } }).kind).toBe("low");
  });
});

describe("relay confirmations: the risk kinds", () => {
  const root = "/data/.alphaclaw";
  it.each([
    ["a workspace write", { toolName: "write", params: { path: "/data/.openclaw/workspace/notes.md" } }, "low", null],
    ["openclaw.json", { toolName: "write", params: { path: "/data/.openclaw/openclaw.json" } }, "high", "write openclaw.json"],
    ["an edit of .env", { toolName: "edit", params: { file_path: "/data/.env" } }, "high", "edit .env"],
    ["a .env.local", { toolName: "write", params: { path: "x/.env.local" } }, "high", "write .env.local"],
    ["the relay guard's own code", { toolName: "edit", params: { path: "/app/node_modules/alphaclaw/lib/plugin/relay-guard/policy.js" } }, "high", "edit policy.js"],
    ["wm-guards", { toolName: "write", params: { path: "/data/.openclaw/extensions/wm-guards/index.js" } }, "high", "write index.js"],
    ["remote.db under the relay dir", { toolName: "write", params: { path: root + "/relay/remote.db" } }, "high", "write remote.db"],
    ["a patch touching auth-profiles.json", { toolName: "apply_patch", params: { input: "*** Begin Patch\n*** Update File: agents/main/auth-profiles.json\n@@\n-a\n+b\n*** End Patch" } }, "high", "apply_patch auth-profiles.json"],
    ["a patch of plain files", { toolName: "apply_patch", params: { input: "*** Begin Patch\n*** Add File: notes/a.md\n+hi\n*** End Patch" } }, "low", null],
    ["an alphaclaw admin read", { toolName: "exec", params: { command: "alphaclaw admin GET /api/status" } }, "low", null],
    ["an alphaclaw admin grant", { toolName: "exec", params: { command: "alphaclaw admin POST /api/relay/remote/grants --data '{}'" } }, "high", "alphaclaw admin POST /api/relay/remote/grants"],
    ["openclaw config get", { toolName: "exec", params: { command: "openclaw config get gateway.bind" } }, "low", null],
    ["openclaw config set", { toolName: "exec", params: { command: "openclaw config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw secrets set", { toolName: "exec", params: { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123" } }, "high", "openclaw secrets set OPENAI_API_KEY"],
    ["openclaw plugins install", { toolName: "exec", params: { command: "cd /tmp && openclaw plugins install ./evil" } }, "high", "openclaw plugins install ./evil"],
    ["a plain shell command", { toolName: "exec", params: { command: "ls -la" } }, "low", null],
    ["a shell write to openclaw.json", { toolName: "exec", params: { command: "node -e \"fs.writeFileSync('/data/.openclaw/openclaw.json', x)\"" } }, "high", "run a command on openclaw.json"],
    ["sed on .env", { toolName: "exec", params: { command: "sed -i s/a/b/ /data/.env" } }, "high", "run a command on .env"],
    ["a redirect into a relative .env", { toolName: "exec", params: { command: "echo KEY=x >> .env" } }, "high", "run a command on .env"],
    ["sqlite3 on the bridge database from inside relay/", { toolName: "exec", params: { command: "cd ~/.alphaclaw/relay && sqlite3 bridge.db \"delete from relay_confirmations\"" } }, "high", "run a command on bridge.db"],
    ["a script opening a relay database", { toolName: "exec", params: { command: "python3 -c \"open('/data/.alphaclaw/relay/remote.db','w')\"" } }, "high", "run a command on remote.db"],
    ["a copy into the guard's directory", { toolName: "exec", params: { command: "cp x ~/.openclaw/extensions/wm-guards/index.js" } }, "high", "run a command on wm-guards"],
    ["a read hidden behind a substitution", { toolName: "exec", params: { command: "cat $(echo /data/.env) | sh" } }, "high", "run a command on .env"],
    ["a plain read of openclaw.json", { toolName: "exec", params: { command: "cat ~/.openclaw/openclaw.json | jq .gateway" } }, "low", null],
    ["a delete backgrounded behind a read", { toolName: "exec", params: { command: "cat openclaw.json & rm -f openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["rg running a program through --pre", { toolName: "exec", params: { command: "rg --pre=/bin/rm x openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["rg with --pre-glob only", { toolName: "exec", params: { command: "rg --pre-glob '*.gz' token ~/.openclaw/openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["rg with an escaped --pre", { toolName: "exec", params: { command: "rg --pr\\e=/bin/rm x openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["a pager on openclaw.json", { toolName: "exec", params: { command: "less ~/.openclaw/openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["openclaw config set inside $( )", { toolName: "exec", params: { command: "echo $(openclaw config set gateway.bind lan)" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw secrets set inside backticks", { toolName: "exec", params: { command: "x=`openclaw secrets set OPENAI_API_KEY sk-live-abc123`" } }, "high", "openclaw secrets set OPENAI_API_KEY"],
    ["openclaw config set in a ( ) subshell", { toolName: "exec", params: { command: "(openclaw config set gateway.bind lan)" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw behind a backslash", { toolName: "exec", params: { command: "\\openclaw config set gateway.auth.mode none" } }, "high", "openclaw config set gateway.auth.mode"],
    ["a backslashed openclaw inside $( )", { toolName: "exec", params: { command: "echo $(\\openclaw config set gateway.bind lan)" } }, "high", "openclaw config set gateway.bind"],
    ["a backslash inside the openclaw path", { toolName: "exec", params: { command: "/usr/bin/\\openclaw config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["OPENCLAW in capitals", { toolName: "exec", params: { command: "OPENCLAW config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw split by a quoted empty string", { toolName: "exec", params: { command: "open''claw config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw plugins install in a { } group", { toolName: "exec", params: { command: "{ openclaw plugins install ./evil; }" } }, "high", "openclaw plugins install ./evil"],
    ["a redirect with no space", { toolName: "exec", params: { command: "cd ~/.openclaw && echo {} >openclaw.json" } }, "high", "run a command on openclaw.json"],
    ["a move by brace expansion", { toolName: "exec", params: { command: "cd ~/.openclaw && mv openclaw.json{,.bak}" } }, "high", "run a command on openclaw.json"],
    ["a read of a backup copy", { toolName: "exec", params: { command: "cat ~/.openclaw/openclaw.json.bak" } }, "low", null],
    ["openclaw with a global flag first", { toolName: "exec", params: { command: "openclaw --profile x config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["a quoted admin route", { toolName: "exec", params: { command: "alphaclaw admin POST '/api/relay/remote/grants'" } }, "high", "alphaclaw admin POST /api/relay/remote/grants"],
    ["input typed into a running editor", { toolName: "process", params: { action: "write", sessionId: "s1", data: "vi /data/.openclaw/openclaw.json\n" } }, "high", "run a command on openclaw.json"],
    ["keys sent to a running shell", { toolName: "process", params: { action: "send-keys", sessionId: "s1", keys: ["sqlite3 relay/bridge.db", "Enter"] } }, "high", "run a command on bridge.db"],
    ["a process poll", { toolName: "process", params: { action: "poll", sessionId: "s1" } }, "low", null],
    ["a relative relay database write", { toolName: "write", params: { path: "relay/bridge.db" } }, "high", "write bridge.db"],
    ["a patch touching two protected files", { toolName: "apply_patch", params: { input: "*** Begin Patch\n*** Update File: a/.env\n*** Update File: b/openclaw.json\n*** End Patch" } }, "high", "apply_patch .env,openclaw.json"],
    ["a message", { toolName: "message", params: { to: "@lupe" } }, "medium", null],
    ["a read of openclaw.json", { toolName: "read", params: { path: "/data/.openclaw/openclaw.json" } }, "low", null],
  ])("%s", (_name, call, kind, action) => {
    const risk = classifyRisk({ ...call, rootDir: root });
    expect(risk.kind).toBe(kind);
    expect(risk.action).toBe(action);
  });

  it("cuts what the delegate chose to plain path characters, so nothing in it can render as a link or markup", () => {
    const risk = classifyRisk({ toolName: "write", params: { path: "/tmp/[Approve](https://evil.example/login)/<x|y>\u202e cookie: z/.env" } });
    expect(risk.kind).toBe("high");
    expect(risk.target).toMatch(/^[A-Za-z0-9._/@+,?-]+$/);
    const config = classifyRisk({ toolName: "exec", params: { command: "openclaw config set [a](https://evil.example) b" } });
    expect(config.action).toMatch(/^openclaw config set [A-Za-z0-9._/@+,?-]*$/);
  });

  it("binds an approved command to that exact command, flags and value included", () => {
    const a = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.bind lan" } });
    const b = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.bind custom" } });
    const flag = classifyRisk({ toolName: "exec", params: { command: "openclaw config set --json gateway.auth '{}'" } });
    expect(a.action).toBe(b.action);
    expect(a.target).not.toBe(b.target);
    expect(a.target).toMatch(/^openclaw config set gateway\.bind #[a-f0-9]{16}$/);
    expect(flag.action).toBe("openclaw config set");
    expect(flag.target).not.toBe(classifyRisk({ toolName: "exec", params: { command: "openclaw config set --json gateway.bind '{}'" } }).target);
  });

  it("names key names and paths only, never a value", () => {
    const risk = classifyRisk({ toolName: "exec", params: { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123" } });
    expect(JSON.stringify(risk)).not.toContain("sk-live-abc123");
    const config = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.auth.token hunter2" } });
    expect(JSON.stringify(config)).not.toContain("hunter2");
  });
});

const makeBox = ({ clock = { now: Date.now() }, grantedBy = "legacy" } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-confirm-"));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const bridge = openBridgeStore({ dbPath: paths.bridgeDb, now: () => clock.now });
  const remote = openRemoteStore({ dbPath: paths.remoteDb });
  remote.clients.insert({ client_id: kClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
  remote.clients.markConsented(kClient);
  remote.bindings.upsert({ agent: kAgent, threadId: "jam_A", clientId: kClient, webhookUrl: "https://api.capy.ai/w/x", until: Date.now() + kHour, capabilityHash: sha256("arcap_test"), agentToken: "at_capy" });
  const grant = remote.grants.create({ agent: kAgent, createdBy: grantedBy });
  let next = 800;
  // A delegate turn in flight, as the bridge stamps it right before chat.send.
  const running = ({ lane = null, generation = 1, confirmationRef = null } = {}) => {
    const id = String(++next);
    const sessionKey = "agent:main:relay-" + kAgent + (lane ? ":lane-" + lane : "");
    bridge.insert({ messageId: id, sender: kAgent, conversationId: "dm_1", threadRoot: id, sessionKey, state: "queued", lane, bindingGeneration: generation, confirmationRef });
    bridge.update(id, { state: "dispatched", runId: "relay-" + id, trust: "delegate", grantId: grant.id, dispatchedAt: Date.now() });
    return { id, ctx: { sessionKey, runId: "relay-" + id } };
  };
  const handlers = {};
  const warnings = [];
  createRelayGuardPlugin().register({
    pluginConfig: { rootDir },
    logger: { info: () => {}, warn: (line) => warnings.push(line), error: (line) => warnings.push(line) },
    on: (name, handler) => (handlers[name] = handler),
  });
  const call = (run, toolName, params) => handlers.before_tool_call({ toolName, params }, run.ctx);
  const notices = [];
  const digests = [];
  const told = [];
  const confirmations = createRelayConfirmations({
    getStore: () => bridge,
    notify: (text, opts) => (opts.eventType === "relay_digest" ? digests : notices).push({ text, opts }),
    resolveSetupUrl: () => "https://box.example.test/",
    sendToAgent: async (row, text, data) => told.push({ row, text, data }),
    readRevokes: () => 0,
    resolveGrantCreator: (id) => remote.grants.get(id)?.createdBy || null,
    now: () => clock.now,
    setTimer: () => null,
    clearTimer: () => {},
    logger: quiet,
  });
  return {
    rootDir,
    paths,
    bridge,
    remote,
    grant,
    running,
    call,
    warnings,
    notices,
    digests,
    told,
    confirmations,
    clock,
    cleanup: () => {
      bridge.close();
      remote.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
};

const linkToken = (notice) => notice.text.match(/\/relay\/confirm\/(rcl_[a-f0-9]{48})/)[1];
const refOf = (result) => result.blockReason.match(/rc_[a-f0-9]{16}/)[0];

describe("relay confirmations: the guard, the owner's link and the retry", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  const configPath = () => path.join(box.rootDir, ".openclaw", "openclaw.json");
  const approve = async (notice) => box.confirmations.decide({ token: linkToken(notice), approve: true, by: "owner" });

  it("holds a high-risk call, sends the owner one link, and admits the retry once after Approve", async () => {
    box = makeBox();
    const first = box.running({ lane: "gbrain" });
    const held = box.call(first, "write", { path: configPath(), content: "{}" });
    expect(held.block).toBe(true);
    expect(held.blockReason).toMatch(/^\[relay-guard\] write openclaw\.json needs your owner's confirmation rc_[a-f0-9]{16}\. AlphaClaw is sending them a one-tap link now/);
    const ref = refOf(held);
    expect(box.call(first, "write", { path: configPath(), content: "{}" }).blockReason).toContain("is waiting for your owner's confirmation " + ref);
    // Low-risk work in the same turn is untouched.
    expect(box.call(first, "write", { path: path.join(box.rootDir, "notes.md"), content: "x" })).toEqual({});
    expect(box.call(first, "exec", { command: "ls" })).toEqual({});

    box.confirmations.tick();
    box.confirmations.tick();
    expect(box.notices).toHaveLength(1);
    const [notice] = box.notices;
    expect(notice.text).toContain("@" + kAgent + " (lane gbrain) wants to `write openclaw.json`");
    expect(notice.text).toContain("https://box.example.test/relay/confirm/rcl_");
    expect(notice.opts).toEqual({ eventType: "relay_confirm", id: "relay-confirm-" + ref });
    expect(box.bridge.confirmations.get(ref)).toMatchObject({ state: "pending", sender: kAgent, lane: "gbrain", generation: 1, kind: "high" });

    const decided = await approve(notice);
    expect(decided).toMatchObject({ ok: true, state: "confirmed" });
    expect(box.told).toHaveLength(1);
    expect(box.told[0].text).toContain("approved: write openclaw.json (confirmation " + ref + ")");
    expect(box.told[0].data).toEqual({ relay_status: "confirmation", relay_confirmation_ref: ref, relay_confirmation_state: "confirmed" });
    // The link works once.
    expect(await approve(notice)).toEqual({ ok: false });
    expect(box.confirmations.resolveToken(linkToken(notice))).toBeNull();

    const retry = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(retry, "write", { path: configPath(), content: "{}" })).toEqual({});
    expect(box.bridge.confirmations.get(ref)).toMatchObject({ state: "spent", spentMessageId: retry.id });
    // Spent: the same call again asks anew.
    const again = box.call(retry, "write", { path: configPath(), content: "{}" });
    expect(again.block).toBe(true);
    expect(refOf(again)).not.toBe(ref);
    const replay = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(replay, "write", { path: configPath(), content: "{}" }).block).toBe(true);
  });

  it("resolves a relative write against the agent named in the session key when the hook context has none", () => {
    box = makeBox();
    const workspace = path.join(box.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(box.paths.dir, path.join(workspace, "box"));
    const run = box.running();
    expect(run.ctx.agentId).toBeUndefined();
    const held = box.call(run, "write", { path: "box/bridge.db", content: "x" });
    expect(held.block).toBe(true);
    expect(held.blockReason).toContain("write bridge.db needs your owner's confirmation");
    expect(box.call(run, "write", { path: "notes.md", content: "x" })).toEqual({});
  });

  it("an approved automations change is admitted once for the same call, and the next one asks again (PR4)", async () => {
    box = makeBox();
    const first = box.running({ lane: "gbrain" });
    const params = { action: "run", jobId: "job-1" };
    const held = box.call(first, "automations", params);
    expect(held.block).toBe(true);
    expect(held.blockReason).toContain("automations run job-1 needs your owner's confirmation");
    const ref = refOf(held);
    box.confirmations.tick();
    expect(await approve(box.notices[0])).toMatchObject({ ok: true, state: "confirmed" });
    const other = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(other, "automations", { action: "run", jobId: "job-2" }).block).toBe(true);
    const retry = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(retry, "automations", { action: "run", jobId: "job-1" })).toEqual({});
    expect(box.bridge.confirmations.get(ref)).toMatchObject({ state: "spent", spentMessageId: retry.id });
    expect(box.call(retry, "automations", params).block).toBe(true);
  });

  it("keeps markup in a delegate's target out of the owner's notice on every transport, after redaction too", () => {
    const { renderTelegramHtml } = require("../../lib/server/utils/telegram-html");
    const { formatSlackMessage } = require("../../lib/server/watchdog-notify");
    const { redactSecretText } = require("../../lib/server/utils/redact");
    box = makeBox();
    const run = box.running();
    for (const target of ["/tmp/[Approve on the secure page](https://evil.example/login)/.env", "/tmp/cookie: x [Approve](https://evil.example/a)/.env", "/tmp/<https://evil.example/b|Approve>/.env"]) {
      expect(box.call(run, "write", { path: target, content: "x" }).block).toBe(true);
    }
    box.confirmations.tick();
    expect(box.notices).toHaveLength(3);
    for (const notice of box.notices) {
      const text = redactSecretText(notice.text);
      expect(text).toMatch(/Target: \x60[A-Za-z0-9._/@+,?-]+\x60\n/);
      expect(text).not.toMatch(/https?:\/\/evil/);
      const { html } = renderTelegramHtml(text);
      expect(html).not.toMatch(/href="[^"]*evil/);
      expect(formatSlackMessage(text)).not.toMatch(/<https?:\/\/evil/);
    }
  });


  it("a confirmation admits nothing for another target, another generation or another lane's message", async () => {
    box = makeBox();
    const first = box.running({ lane: "gbrain" });
    const ref = refOf(box.call(first, "exec", { command: "openclaw config set gateway.bind lan" }));
    box.confirmations.tick();
    await approve(box.notices[0]);

    const otherTarget = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(otherTarget, "exec", { command: "openclaw config set gateway.auth.mode none" }).block).toBe(true);
    const otherGeneration = box.running({ lane: "gbrain", generation: 2, confirmationRef: ref });
    expect(box.call(otherGeneration, "exec", { command: "openclaw config set gateway.bind lan" }).block).toBe(true);
    const otherLane = box.running({ lane: "evals" });
    expect(box.call(otherLane, "exec", { command: "openclaw config set gateway.bind lan" }).block).toBe(true);
    expect(box.bridge.confirmations.get(ref).state).toBe("confirmed");
    // The message that carries the ref, on its own lane, still spends it.
    const retry = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(retry, "exec", { command: "openclaw config set gateway.bind lan" })).toEqual({});
  });

  it("Deny tells the sender and refuses the retry", async () => {
    box = makeBox();
    const first = box.running();
    const ref = refOf(box.call(first, "edit", { path: path.join(box.rootDir, ".env"), old_string: "a", new_string: "b" }));
    box.confirmations.tick();
    expect(await box.confirmations.decide({ token: linkToken(box.notices[0]), approve: false, by: "owner" })).toMatchObject({ ok: true, state: "denied" });
    expect(box.told[0].text).toContain("denied: edit .env");
    const retry = box.running({ confirmationRef: ref });
    const refused = box.call(retry, "edit", { path: path.join(box.rootDir, ".env"), old_string: "a", new_string: "b" });
    expect(refused.blockReason).toContain("was denied by your owner (confirmation " + ref + ")");
  });

  it("an unanswered link expires after 15 minutes, and so does an approval nobody used", async () => {
    const clock = { now: Date.now() };
    box = makeBox({ clock });
    const action = { kind: "high", action: "write openclaw.json", target: "/x/openclaw.json" };
    const asked = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m1", generation: 1, ...action, now: clock.now });
    expect(asked).toMatchObject({ admitted: false, state: "requested" });
    box.confirmations.tick();
    const token = linkToken(box.notices[0]);
    clock.now += 15 * 60 * 1000 + 1;
    expect(box.confirmations.resolveToken(token)).toBeNull();
    expect(await box.confirmations.decide({ token, approve: true, by: "owner" })).toEqual({ ok: false });
    box.confirmations.tick();
    expect(box.bridge.confirmations.get(asked.ref).state).toBe("expired");

    const second = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m2", generation: 1, ...action, now: clock.now });
    box.confirmations.tick();
    await box.confirmations.decide({ token: linkToken(box.notices[1]), approve: true, by: "owner" });
    clock.now += 15 * 60 * 1000 + 1;
    const late = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m3", generation: 1, confirmationRef: second.ref, ...action, now: clock.now });
    expect(late).toMatchObject({ admitted: false, state: "requested" });
  });

  it("refuses with no bridge database, and a revoke cancels the sender's open confirmations", () => {
    box = makeBox();
    const missing = checkConfirmation({ rootDir: path.join(box.rootDir, "nope"), sender: kAgent, messageId: "m1", kind: "high", action: "a", target: "t" });
    expect(missing).toEqual({ admitted: false, state: "unavailable", ref: null });
    const run = box.running();
    const ref = refOf(box.call(run, "write", { path: configPath(), content: "{}" }));
    box.bridge.demoteSender(kAgent, "grant_revoked");
    expect(box.bridge.confirmations.get(ref).state).toBe("cancelled");
  });

  it("holds at most 5 open requests per sender and refuses a sixth without asking the owner", () => {
    box = makeBox();
    const ask = (n) => checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m" + n, kind: "high", action: "write .env", target: "/x" + n + "/.env" });
    for (let n = 0; n < 5; n += 1) expect(ask(n).state).toBe("requested");
    expect(ask(5)).toEqual({ admitted: false, state: "too_many", ref: null });
  });

  it("the owner's message names the action and key, never the value or the message text", () => {
    box = makeBox();
    const run = box.running();
    box.call(run, "exec", { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123def456" });
    box.confirmations.tick();
    expect(box.notices[0].text).toContain("openclaw secrets set OPENAI_API_KEY");
    expect(box.notices[0].text).not.toContain("sk-live");
    expect(JSON.stringify(box.bridge.confirmations.listOpen())).not.toContain("sk-live");
  });

  it("sends the daily digest once a day after 15:00 UTC, counts only", () => {
    const clock = { now: Date.parse("2026-11-09T14:00:00Z") };
    box = makeBox({ clock });
    box.running({ lane: "gbrain" });
    box.running();
    box.confirmations.tick();
    expect(box.digests).toEqual([]);
    clock.now = Date.parse("2026-11-09T15:05:00Z");
    box.confirmations.tick();
    box.confirmations.tick();
    expect(box.digests).toHaveLength(1);
    expect(box.digests[0].opts).toEqual({ eventType: "relay_digest", id: "relay-digest-2026-11-09" });
    expect(box.digests[0].text).toContain("@" + kAgent + ": 2 delegate messages, lanes default, gbrain, grant " + box.grant.id);
    expect(box.digests[0].text).toContain("Confirmations: 0 asked");
    // The next day's digest covers that day only: nothing new, nothing sent.
    clock.now = Date.parse("2026-11-10T15:05:00Z");
    box.confirmations.tick();
    expect(box.digests).toHaveLength(1);
  });
});

describe("relay confirmations: the owner's page", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  const setup = (identity = { kind: "legacy", role: "admin" }, options = {}) => {
    box = makeBox(options);
    const run = box.running({ lane: "gbrain" });
    box.call(run, "write", { path: path.join(box.rootDir, ".openclaw", "openclaw.json"), content: "{}" });
    box.confirmations.tick();
    const app = express();
    let who = identity;
    registerRelayConfirmRoutes({ app, resolveRequestIdentity: () => who, confirmations: box.confirmations, resolveSetupUrl: () => "https://box.example.test", logger: quiet });
    return { app, token: linkToken(box.notices[0]), setIdentity: (value) => (who = value) };
  };
  const csrfOf = (html) => html.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  it("shows the request to a signed-in admin and takes one answer, same origin with the page's CSRF", async () => {
    const { app, token } = setup();
    const page = await request(app).get("/relay/confirm/" + token);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("write openclaw.json");
    expect(page.text).toContain("lane <code>gbrain</code>");
    const csrf = csrfOf(page.text);
    const crossOrigin = await request(app).post("/relay/confirm/" + token).set("Origin", "https://evil.test").type("form").send({ csrf, decision: "approve" });
    expect(crossOrigin.status).toBe(403);
    const badCsrf = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf: "0".repeat(32), decision: "approve" });
    expect(badCsrf.status).toBe(403);
    const approved = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.text).toContain("Approved");
    expect(box.told).toHaveLength(1);
    const again = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "deny" });
    expect(again.status).toBe(410);
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(410);
  });

  it("sends a signed-out visitor to the login page and refuses a member who is not an admin", async () => {
    const { app, token, setIdentity } = setup(null);
    const signedOut = await request(app).get("/relay/confirm/" + token);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.location).toBe("/login.html?next=" + encodeURIComponent("/relay/confirm/" + token));
    expect((await request(app).post("/relay/confirm/" + token).type("form").send({ decision: "approve" })).status).toBe(401);
    setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(403);
    expect((await request(app).get("/relay/confirm/not-a-token")).status).toBe(410);
    expect(box.bridge.confirmations.listOpen()[0].state).toBe("pending");
  });

  it("in team mode takes an answer only from the owner or the admin who added the sender's grant", async () => {
    const { app, token, setIdentity } = setup({ kind: "member", memberId: "m_other", role: "admin" }, { grantedBy: "member:m_owner" });
    const refused = await request(app).get("/relay/confirm/" + token);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Only the owner who connected @" + kAgent);
    setIdentity({ kind: "member", memberId: "m_owner", role: "admin" });
    const page = await request(app).get("/relay/confirm/" + token);
    expect(page.status).toBe(200);
    const csrf = csrfOf(page.text);
    setIdentity({ kind: "member", memberId: "m_other", role: "admin" });
    const otherPost = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "approve" });
    expect(otherPost.status).toBe(403);
    expect(box.bridge.confirmations.listOpen()[0].state).toBe("pending");
    setIdentity({ kind: "member", memberId: "m_owner", role: "member" });
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(403);
    setIdentity({ kind: "legacy", role: "admin" });
    const approved = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(box.bridge.confirmations.get(box.told[0].row.id).decidedBy).toBe("owner");
  });

  it("answers through the relay service the server mounts the page with", async () => {
    box = makeBox();
    const run = box.running({ lane: "gbrain" });
    box.call(run, "write", { path: path.join(box.rootDir, ".openclaw", "openclaw.json"), content: "{}" });
    box.confirmations.tick();
    const service = createRelayService({ env: {}, rootDir: box.rootDir, logger: quiet });
    service._internal.state.confirmations = box.confirmations;
    const app = express();
    registerRelayConfirmRoutes({ app, resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }), confirmations: service.confirmations, resolveSetupUrl: () => "https://box.example.test", logger: quiet });
    const token = linkToken(box.notices[0]);
    const page = await request(app).get("/relay/confirm/" + token);
    expect(page.status).toBe(200);
    const approved = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf: csrfOf(page.text), decision: "approve" });
    expect(approved.status).toBe(200);
    expect(box.told).toHaveLength(1);
  });

  it("refuses every member for a grant imported from the env list, which only the owner answers", async () => {
    const { app, token } = setup({ kind: "member", memberId: "m1", role: "admin" }, { grantedBy: "env:ALPHACLAW_RELAY_DELEGATE_AGENTS" });
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(403);
  });
});
