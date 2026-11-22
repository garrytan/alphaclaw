const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { classifyAnchor, classifyKeyRead, textLineOf } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2940: an exec that appended a single-quoted note to a memory file was
// refused as a change to relay trust, because the note held a backtick pair
// around the words openclaw qr and the guard read every backtick as a
// command substitution whatever the quotes; a read-only grep that named
// openclaw.json was refused too. The guard now reads a line whose every
// command is cd, echo, printf, cat, head, tail, grep, wc, ls, stat, jq, pwd
// or true as text (textLineOf), with quote state tracked as the shell tracks
// it ('"'"' splices included) and nothing unquoted that can expand, and lets
// a line that only reads name an anchor file.
// Every case here also runs in real bash, zsh and dash, as a plain -c and
// inside the eval OpenClaw's exec wraps a command in (bash --noprofile
// --norc -c, zsh -f -c), with a stub openclaw on PATH that records each
// call: a command the guard lets through must never run the stub in any of
// them, and a read-only line must leave every file as it was.
const BT = "\x60";
const kPinned = "capy-25cf4e98b5b6";
const which = (name) => {
  const found = spawnSync("sh", ["-c", "command -v " + name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : "";
};
const shQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const kBash = which("bash");
const kZsh = which("zsh");
const kDash = which("dash") || which("sh");
const kRunners = [
  ["bash", kBash, (command) => ["-c", command]],
  ["zsh", kZsh, (command) => ["-c", command]],
  ["dash", kDash, (command) => ["-c", command]],
  ["openclaw-bash", kBash, (command) => ["--noprofile", "--norc", "-c", "eval " + shQuote(command)]],
  ["openclaw-zsh", kZsh, (command) => ["-f", "-c", "eval " + shQuote(command)]],
];
const kMissing = [["bash", kBash], ["zsh", kZsh], ["dash", kDash]].filter(([, file]) => !file).map(([name]) => name);

let root;
let workspace;
let stubLog;
let shellEnv;
const kConfig = JSON.stringify({ plugins: { allow: ["relay-guard"] } });
// The files a read-only line may name, recreated before every run: the
// box's openclaw.json beside a note whose text is an openclaw change.
const resetFixture = () => {
  for (const entry of fs.readdirSync(workspace)) fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, "memory"));
  fs.writeFileSync(path.join(workspace, "openclaw.json"), kConfig);
  fs.writeFileSync(path.join(workspace, "notes.txt"), "openclaw config patch\n");
};
const treeOf = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== "memory")
    .map((entry) => (entry.isDirectory() ? entry.name + "/{" + treeOf(path.join(dir, entry.name)) + "}" : entry.name + "=" + fs.readFileSync(path.join(dir, entry.name), "utf8")))
    .sort()
    .join("\n");
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-inert-")));
  workspace = path.join(root, ".openclaw", "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin);
  stubLog = path.join(root, "stub.log");
  fs.writeFileSync(path.join(bin, "openclaw"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$STUB_LOG\"\n", { mode: 0o755 });
  shellEnv = { PATH: bin + ":/usr/local/bin:/usr/bin:/bin", HOME: root, ZDOTDIR: root, STUB_LOG: stubLog, LANG: "C" };
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Which runners ran the stub, and which left a file other than a memory/
// note changed, each from a fresh fixture.
const effectsOf = (command) => {
  const ran = [];
  const changed = [];
  for (const [name, file, argv] of kRunners) {
    if (!file) continue;
    fs.rmSync(stubLog, { force: true });
    resetFixture();
    const before = treeOf(workspace);
    spawnSync(file, argv(command), { cwd: workspace, env: shellEnv, timeout: 5000, stdio: "ignore" });
    if (fs.existsSync(stubLog) && fs.readFileSync(stubLog, "utf8").length) ran.push(name);
    if (treeOf(workspace) !== before) changed.push(name);
  }
  fs.rmSync(stubLog, { force: true });
  return { ran, changed };
};
const stubRunsOf = (command) => effectsOf(command).ran;
const anchorOf = (command) => classifyAnchor({ toolName: "exec", params: { command }, rootDir: root });
const kChange = "openclaw config set plugins.allow x";

// Notes the guard now lets through. None of them runs openclaw anywhere.
// The first is the box's refused shape with a synthetic note.
const allowedNotes = () => [
  "cd ROOT/.openclaw/workspace && printf '%s\n' '- 08:10 Paired the phone: ran " + BT + "openclaw qr" + BT + " setup code, the owner'\"'\"'s request (gateway config untouched)' >> memory/2026-11-17.md && tail -c 200 memory/2026-11-17.md",
  "printf '%s\n' 'it'\"'\"'s " + BT + "openclaw config patch" + BT + " $(x)' >> memory/n.md; cat memory/n.md | grep -c x",
  "echo 'openclaw qr (pairing) config' ",
  "echo 'openclaw qr (x) config' > memory/a.md > memory/b.md",
  "echo 'openclaw qr (x) config' 2>memory/n.md",
  "cat memory/x.md >> memory/n.md <<'EOF'\nopenclaw qr (x) config\nEOF",
  "cat <<'A' <<'B' > memory/n.md\nopenclaw qr (x) config\nA\nB",
  "grep -c x memory/n.md <<'EOF' || echo '" + BT + "openclaw config patch" + BT + "' >> memory/n.md\n$(openclaw config apply)\nEOF",
  "echo 'ran openclaw qr (pairing) for the gateway config' >> memory/2026-11-17.md",
  "echo \"ran openclaw qr (pairing) for the gateway config\" >> memory/2026-11-17.md",
  "printf '\\n- 08:10 Ran openclaw qr for pairing (gateway token)\\n' >> memory/2026-11-17.md",
  "printf '%s\\n' '" + kChange + "' >> memory/n.md",
  "echo '" + kChange + "; $(openclaw config patch) " + BT + "openclaw config apply" + BT + "' > memory/n.md",
  "echo 'openclaw config set (N) plugins.entries.relay-guard.enabled false' >> memory/n.md",
  "echo \"openclaw config unset (plugins.allow|x) !x (^y) <1-2> {a,b} * ?\" > memory/n.md",
  "echo -e 'openclaw\\tconfig patch' >> memory/n.md",
  "echo 'first line\nopenclaw config patch\nthird line' >> memory/n.md",
  "echo \"x xxx OpenClaw x (xxx:<gid>:x) xx; a && b | c\" >> memory/n.md",
  "cat >> memory/2026-11-17.md <<'EOF'\n- Ran " + BT + "openclaw qr" + BT + " to pair; $(openclaw config patch)\n(openclaw plugins disable x)\nEOF",
  "cat >> memory/n.md <<\"EOF\"\n$(openclaw config apply) " + BT + "openclaw config patch" + BT + "\nEOF",
  "cat >> memory/n.md << 'EOF'\n" + kChange + "\nEOF\n",
  "cat <<'EOF' >> memory/n.md\nopenclaw config patch\nEOF",
  "cat >> memory/n.md <<EOF\n- Ran openclaw qr (pairing) for the gateway config; a | b && c\nEOF",
  "cat > memory/n.md <<'EOF'\n EOF\nopenclaw config patch\nEOF \n\tEOF\nopenclaw config apply\nEOF",
  "cat >> " + "ROOT/.openclaw/workspace/memory/n.md <<'EOF'\nopenclaw qr\nEOF",
];

// Refused neighbours that really run openclaw in at least one shell.
const runningNeighbours = () => [
  ["; after the note", "echo x >> memory/n.md; openclaw config patch"],
  ["&& after the note", "echo x >> memory/n.md && openclaw config patch"],
  ["|| after a failed note", "echo x > nosuch/n.md || openclaw config patch"],
  ["& after the note", "echo x >> memory/n.md & openclaw config patch"],
  ["a pipe into sh", "echo 'openclaw config patch' | sh"],
  ["a pipe after the note", "echo x >> memory/n.md | openclaw config patch"],
  ["a second line", "echo x >> memory/n.md\nopenclaw config patch"],
  ["eval", "eval 'openclaw config patch' >> memory/n.md"],
  ["sh -c", "sh -c 'openclaw config patch' >> memory/n.md"],
  ["bash -c", "bash -c 'openclaw config patch' >> memory/n.md"],
  ["printf %n naming an array element, whose subscript zsh expands", "printf 'x%n' 'a[$(openclaw config patch)]' >> memory/n.md"],
  ["zsh -c with the (N) glob qualifier (#423)", "zsh -c '" + kChange.replace("set", "set (N)") + "'"],
  ["xargs", "echo plugins.allow | xargs openclaw config unset"],
  ["env", "env openclaw config patch >> memory/n.md"],
  ["exec", "exec openclaw config patch >> memory/n.md"],
  ["command", "command openclaw config patch >> memory/n.md"],
  ["source of the note", "echo 'openclaw config patch' > memory/n.md; . ./memory/n.md"],
  ["the note run by bash (laundering through a file)", "echo 'openclaw config patch' > memory/n.md && bash memory/n.md"],
  ["a function named echo", "echo() { openclaw config patch; }; echo x >> memory/n.md"],
  ["$( ) in double quotes", "echo \"ran $(openclaw config patch)\" >> memory/n.md"],
  ["a backtick in double quotes", "echo \"ran " + BT + "openclaw config patch" + BT + "\" >> memory/n.md"],
  ["$( ) in the target", "echo x >> \"memory/$(openclaw config patch).md\""],
  ["$( ) unquoted", "echo $(openclaw config patch) >> memory/n.md"],
  ["$( ) in an unquoted here-document", "cat >> memory/n.md <<EOF\n$(openclaw config patch)\nEOF"],
  ["a backtick in an unquoted here-document", "cat >> memory/n.md <<EOF\n" + BT + "openclaw config patch" + BT + "\nEOF"],
  ["<<- ending at a tab-indented delimiter", "cat >> memory/n.md <<-'EOF'\n\tEOF\nopenclaw config patch\n"],
  ["a command after the here-document", "cat > memory/n.md <<'EOF'\nx\nEOF\nopenclaw config patch"],
  ["a here-document piped into sh", "cat <<'EOF' | sh\nopenclaw config patch\nEOF"],
  ["a here-document fed to sh", "sh <<'EOF' > memory/n.md\nopenclaw config patch\nEOF"],
  ["a here-string", "cat <<< \"$(openclaw config patch)\" >> memory/n.md"],
  ["process substitution", "cat > memory/n.md < <(openclaw config patch)"],
  ["zsh =( )", "cat =(openclaw config patch) > memory/n.md"],
  ["a subshell", "(openclaw config patch) >> memory/n.md"],
  ["a brace group", "{ openclaw config patch; } >> memory/n.md"],
  ["a script then sh (laundering through a file)", "echo 'openclaw config patch' > run.sh && sh run.sh"],
  ["openclaw with a filled-in part (#423)", "bash -c \"openclaw $(echo config) set plugins.allow x\""],
  ["a subshell around openclaw (#423)", "(openclaw config set plugins.allow x)"],
  ["prose then a subshell (#423)", "git commit -m \"OpenClaw (the runtime)\" ; (openclaw config patch)"],
  ["a zsh pattern group (#423)", "touch plugins.allow && zsh -c \"openclaw config unset (')'|plugins.allow)\""],
  ["a variable holding openclaw", "o=openclaw; $o config patch >> memory/n.md"],
];

// Shapes that run openclaw and that the guard let through before GST-2940
// too: an alias whose value is the openclaw command, and xargs supplying
// every word after openclaw. They are not literal notes, so this change
// leaves their verdict as it was; closing them is separate work.
const unchangedGaps = () => [
  ["an alias named echo", "alias echo='openclaw config patch'\necho x >> memory/n.md"],
  ["xargs supplying the group and verb", "echo config patch | xargs openclaw"],
];

// Refused neighbours that do not run the stub here, refused because they are
// not one of the literal shapes.
const conservativeNeighbours = () => [
  ["an escaped $ in double quotes", "echo \"\\$(openclaw config patch)\" > memory/n.md"],
  ["an unquoted openclaw argument", "echo openclaw config patch >> memory/n.md"],
  ["a target that is not a note", "echo 'openclaw config patch' > memory/n.sh"],
  ["a dot-file target", "echo 'openclaw config patch' >> .zshenv"],
  ["a clobber redirect", "echo 'openclaw qr (x) config' >| memory/n.md"],
  ["an assignment prefix", "PATH=. echo 'openclaw qr (x) config' >> memory/n.md"],
  ["a partly quoted delimiter", "cat > memory/n.md <<E'OF'\nopenclaw qr (x) config\nEOF"],
  ["an unterminated here-document", "cat > memory/n.md <<'EOF'\nopenclaw qr (x) config"],
  ["a CR before the delimiter's newline", "cat > memory/n.md <<'EOF'\nopenclaw qr (x) config\nEOF\r\n"],
  ["a backslash in an unquoted here-document", "cat > memory/n.md <<EOF\nopenclaw qr (x) config \\\nEOF"],
  ["an unbalanced quote", "echo 'openclaw qr (x) config >> memory/n.md"],
  ["a comment", "echo 'openclaw qr (x) config' >> memory/n.md # done"],
  ["a glob in the target", "echo 'openclaw qr (x) config' >> memory/*.md"],
  ["a tilde target", "echo 'openclaw qr (x) config' >> ~/n.md"],
  ["printf -v, which sets a variable", "printf -v PATH '%s' . && cat 'openclaw (x)'"],
  ["printf with a glob", "printf * 'openclaw (x)' >> memory/n.md"],
  ["a note into AlphaClaw's relay directory", "echo 'openclaw (x)' >> ROOT/relay/n.md"],
  ["a note through a cd to a relative directory", "cd memory && echo 'openclaw (x)' >> n.md"],
  ["a command outside the list", "echo 'openclaw (x)' >> memory/n.md && sort memory/n.md"],
];

// Read-only lines the guard now lets name openclaw.json. None runs openclaw
// or changes a file in any shell.
const allowedReads = () => [
  "grep -n relay-guard openclaw.json",
  "grep -rn --include=*.json allow . 2>/dev/null | head -20",
  "grep -c plugins openclaw.json notes.txt ROOT/.openclaw/workspace/openclaw.json",
  "cat openclaw.json | jq -r .plugins.allow",
  "jq '.plugins | keys' openclaw.json && wc -c openclaw.json",
  "head -c 200 openclaw.json; tail -n 5 notes.txt",
  "ls -la openclaw.json || stat openclaw.json",
  "grep -l 'openclaw config set' *.txt *.json",
  "cat openclaw.json notes.txt | grep -v '$(openclaw config patch)' >/dev/null",
  "egrep -h \"plugins|gateway\" openclaw.json",
  "fgrep -e '; openclaw config patch' notes.txt openclaw.json",
];

// Refused neighbours of a read-only line: each runs openclaw or changes a
// file in at least one shell.
const readNeighbours = () => [
  ["a redirect onto openclaw.json", "grep x openclaw.json > openclaw.json"],
  ["an append onto openclaw.json", "cat notes.txt >> openclaw.json"],
  ["a descriptor redirect onto openclaw.json", "grep -n x nosuch 2>openclaw.json"],
  ["a clobber redirect", "cat notes.txt >| openclaw.json"],
  ["a redirect with no blank before it", "cat notes.txt>openclaw.json"],
  ["tee", "cat openclaw.json | tee openclaw.json.bak"],
  ["sed -i", "sed -i s/relay-guard/x/ openclaw.json"],
  ["awk system()", "awk 'BEGIN{system(\"openclaw config patch\")}' openclaw.json"],
  ["sort -o", "sort -o openclaw.json notes.txt"],
  ["find -exec", "find . -name openclaw.json -exec openclaw config patch ';'"],
  ["find -delete", "find . -name openclaw.json -delete"],
  ["rg --pre", "rg --pre openclaw x openclaw.json", "rg"],
  ["xargs", "grep -h . notes.txt | xargs openclaw config unset"],
  ["a pipe into sh", "grep -h openclaw notes.txt openclaw.json | sh"],
  ["a pipe into bash", "cat notes.txt openclaw.json | bash"],
  ["a substitution in an argument", "grep $(openclaw config patch) openclaw.json"],
  ["a backtick in an argument", "grep " + BT + "openclaw config patch" + BT + " openclaw.json"],
  ["a substitution in double quotes", "grep \"$(openclaw config patch)\" openclaw.json"],
  ["a write joined with &&", "grep -q allow openclaw.json && cat notes.txt > openclaw.json"],
  ["a background job", "grep x openclaw.json & openclaw config patch"],
  ["a second line", "grep x openclaw.json\nopenclaw config patch"],
  ["a subshell", "(grep x openclaw.json; openclaw config patch)"],
  ["process substitution", "cat openclaw.json <(openclaw config patch)"],
  ["a here-string", "cat openclaw.json <<< \"$(openclaw config patch)\""],
  ["a here-document", "cat openclaw.json - <<EOF\n$(openclaw config patch)\nEOF"],
  ["env", "env openclaw config patch openclaw.json"],
  ["command", "command openclaw config patch openclaw.json"],
  ["eval", "eval grep x openclaw.json\\; openclaw config patch"],
  ["sh -c", "sh -c 'openclaw config patch' openclaw.json"],
  ["an assignment prefix", "PATH=. cat openclaw.json; openclaw config patch"],
  ["a function named cat", "cat() { openclaw config patch; }; cat openclaw.json"],
  ["a variable command", "c=openclaw; $c config patch openclaw.json"],
];

// Process environments (GST-2910), refused for every tier.
const environReads = () => [
  ["read", { path: "/proc/self/environ" }],
  ["read", { path: "/proc/1/task/1/environ" }],
  ["exec", { command: "cat /proc/1/environ" }],
  ["exec", { command: "tr '\\0' '\\n' < /proc/self/environ" }],
  ["exec", { command: "strings /proc/$$/environ" }],
  ["exec", { command: "cat /proc/*/environ" }],
  ["exec", { command: "cat /proc/*/env*" }],
  ["exec", { command: "cat /pro?/self/environ" }],
  ["exec", { command: "cat /proc/{1,2}/environ" }],
  ["exec", { command: "cat /proc/1/task/*/environ" }],
  ["exec", { command: "cat /proc/self/../self/environ" }],
  ["exec", { command: "cat '/pr''oc/self/environ'" }],
  ["exec", { command: "cd /proc/self && cat environ" }],
  ["exec", { command: "cd /proc && cat 1/environ" }],
  ["exec", { command: "p=/proc/self; cat $p/environ" }],
  ["exec", { command: "cat environ", workdir: "/proc/self" }],
  ["exec", { command: "cat proc/self/environ", workdir: "/" }],
  ["exec", { command: "cat pr*/self/env*", workdir: "/" }],
  ["exec", { command: "cat self/environ", workdir: "/proc/" }],
  ["exec", { command: "grep -a TOKEN /proc/thread-self/environ" }],
  ["process", { action: "write", sessionId: "s1", data: "cat /proc/1/environ\n" }],
];
const environAllowed = () => [
  ["exec", { command: "ls /proc/1/environ" }],
  ["exec", { command: "echo 'checked /proc/self/environ' >> memory/notes.md" }],
  ["exec", { command: "cat /proc/self/status" }],
  ["exec", { command: "cat proc/self/status", workdir: "/" }],
  ["exec", { command: "cat tmp/*.log", workdir: "/" }],
  ["exec", { command: "cat notes.md memory/*", workdir: "~/memory" }],
  ["exec", { command: "cat notes.md", workdir: "~" }],
  ["read", { path: "/proc/cpuinfo" }],
];

const expandRoot = (command) => command.replace(/ROOT/g, root);

describe("relay guard and openclaw in plain notes (GST-2940)", () => {
  it("has bash, zsh and dash to check against", () => {
    if (process.env.CI) expect(kMissing).toEqual([]);
    else if (kMissing.length) console.warn("relay-guard-inert-notes: missing shells " + kMissing.join(", ") + "; their rows are skipped");
  });

  it("lets through each literal note, and no shell runs openclaw for any of them", () => {
    for (const raw of allowedNotes()) {
      const command = expandRoot(raw);
      expect(anchorOf(command), command).toBeNull();
      expect(stubRunsOf(command), command).toEqual([]);
    }
  });

  it("still refuses every neighbour that runs openclaw in bash, zsh or dash", () => {
    for (const [label, command] of runningNeighbours()) {
      expect(textLineOf(command, { rootDir: root }), label).toBe(false);
      expect(anchorOf(command), label).not.toBeNull();
      expect(stubRunsOf(command).length, label + " should run the stub in some shell").toBeGreaterThan(0);
    }
  });

  it("leaves the shapes the guard already missed to their old verdict: none is a literal note", () => {
    for (const [label, command] of unchangedGaps()) {
      expect(textLineOf(command, { rootDir: root }), label).toBe(false);
      expect(stubRunsOf(command).length, label).toBeGreaterThan(0);
    }
  });

  it("still refuses the shapes it cannot prove literal, whether or not they run anything", () => {
    for (const [label, raw] of conservativeNeighbours()) {
      const command = expandRoot(raw);
      expect(textLineOf(command, { rootDir: root }), label).toBe(false);
      expect(anchorOf(command), label).not.toBeNull();
    }
  });

  // Every generated command carries openclaw config patch, which the guard
  // refused anywhere on a line before GST-2940, so each one let through here
  // is let through by the literal-note rule alone.
  it("never lets through a generated command that runs openclaw in any shell", () => {
    let seed = 2940;
    const pick = (list) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return list[seed % list.length];
    };
    const heads = ["echo", "printf", "cat", "echo -n", "printf '%s\\n'"];
    const texts = ["'openclaw config patch'", "\"openclaw config patch\"", "'openclaw (N) config patch'", "\"(openclaw config patch)\"", "openclaw config patch", "\"$(openclaw config patch)\"", "'x'\"y\"", "\"" + BT + "openclaw config patch" + BT + "\"", "'a'\\''openclaw config patch'", "\"\\\"openclaw config patch\"", ""];
    const ops = [" > memory/n.md", " >> memory/n.md", ">memory/n.md", " >> memory/n.md; openclaw config patch", " >> memory/n.md | sh", " | sh", " >> memory/n.md <<'EOF'\nopenclaw config patch\nEOF", " >> memory/n.md <<EOF\n$(openclaw config patch)\nEOF", " <<EOF >> memory/n.md\nopenclaw qr (x)\nEOF\nopenclaw config patch", " >> memory/n.md <<'EOF'\nEOF2\nEOF\n"];
    let allowed = 0;
    for (let n = 0; n < 160; n += 1) {
      const command = pick(heads) + " " + pick(texts) + pick(ops);
      if (!command.includes("openclaw config patch") || anchorOf(command) !== null) continue;
      allowed += 1;
      expect(stubRunsOf(command), command).toEqual([]);
    }
    expect(allowed).toBeGreaterThan(10);
  });
});

describe("relay guard and read-only lines that name openclaw.json (GST-2940)", () => {
  it("lets through each read-only line, and no shell runs openclaw or changes a file for any of them", () => {
    for (const raw of allowedReads()) {
      const command = expandRoot(raw);
      expect(textLineOf(command, { rootDir: root }), command).toBe("read");
      expect(anchorOf(command), command).toBeNull();
      expect(effectsOf(command), command).toEqual({ ran: [], changed: [] });
    }
  });

  it("still refuses every neighbour that writes a file or runs openclaw in bash, zsh or dash", () => {
    for (const [label, command, needs] of readNeighbours()) {
      expect(textLineOf(command, { rootDir: root }), label).not.toBe("read");
      expect(anchorOf(command), label).not.toBeNull();
      if (needs && !which(needs)) continue;
      const { ran, changed } = effectsOf(command);
      expect(ran.length + changed.length, label + " should run the stub or change a file in some shell").toBeGreaterThan(0);
    }
  });

  it("never lets through a generated read-only line that runs openclaw or changes a file", () => {
    let seed = 4;
    const pick = (list) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return list[seed % list.length];
    };
    const heads = ["grep x", "cat", "head -n1", "jq .", "wc -l", "tail", "sed -n p", "tee", "sort -o openclaw.json", "xargs openclaw"];
    const args = ["openclaw.json", "'openclaw.json'", "notes.txt openclaw.json", "\"$(openclaw config patch)\" openclaw.json", "*.json", "-", "'; openclaw config patch'"];
    const tails = ["", " 2>/dev/null", " >/dev/null 2>&1", " > openclaw.json", " >> openclaw.json", " | sh", " | grep -c x", " && cat notes.txt", " | xargs openclaw", "; openclaw config patch", " 2> openclaw.json", "\nopenclaw config patch"];
    let allowed = 0;
    for (let n = 0; n < 200; n += 1) {
      const command = pick(heads) + " " + pick(args) + pick(tails);
      if (anchorOf(command) !== null) continue;
      if (textLineOf(command, { rootDir: root }) !== "read") continue;
      allowed += 1;
      expect(effectsOf(command), command).toEqual({ ran: [], changed: [] });
    }
    expect(allowed).toBeGreaterThan(10);
  });
});

describe("relay guard and process environments (GST-2910)", () => {
  it("refuses a read, exec or typed input that reaches /proc/<pid>/environ", () => {
    for (const [toolName, params] of environReads()) {
      const hit = classifyKeyRead({ toolName, params, rootDir: root });
      expect(hit, JSON.stringify(params)).not.toBeNull();
      expect(hit.environ, JSON.stringify(params)).toBe(true);
    }
  });

  it("refuses a symlink in the workspace that lands on a process environment", () => {
    const link = path.join(workspace, "env-link");
    fs.rmSync(link, { force: true });
    fs.symlinkSync("/proc/self/environ", link);
    try {
      expect(classifyKeyRead({ toolName: "read", params: { path: "env-link" }, rootDir: root })?.environ).toBe(true);
      expect(classifyKeyRead({ toolName: "exec", params: { command: "cat env-link" }, rootDir: root })?.environ).toBe(true);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("refuses a glob in the workspace that reaches a process environment through a symlink, and lets the same glob read other files", () => {
    const link = path.join(workspace, "Lproc");
    fs.rmSync(link, { force: true });
    fs.symlinkSync("/proc/self", link);
    try {
      for (const command of ["cat Lp*/environ", "cat L?roc/env*", "cat " + workspace + "/Lpro*/environ", "cd " + workspace + " && cat L*/environ", "cat Lp*/task/*/environ"]) {
        expect(classifyKeyRead({ toolName: "exec", params: { command }, rootDir: root })?.environ, command).toBe(true);
      }
      expect(classifyKeyRead({ toolName: "exec", params: { command: "cat */environ", workdir: workspace }, rootDir: root })?.environ).toBe(true);
      for (const command of ["cat Lp*/status", "cat Lp*/cmdline", "ls Lp*/environ"]) expect(classifyKeyRead({ toolName: "exec", params: { command }, rootDir: root }), command).toBeNull();
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("refuses a relative read from a workdir of ~, which OpenClaw joins onto the workspace, and lets other files through", () => {
    const home = path.join(workspace, "~");
    const link = path.join(workspace, "Lproc");
    fs.rmSync(home, { force: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(".", home);
    fs.symlinkSync("/proc/self", link);
    try {
      for (const [command, workdir] of [["cat Lproc/environ", "~"], ["cat Lproc/environ", "~/"], ["cat environ", "~/Lproc"], ["cat Lp*/env*", "~"]]) {
        expect(classifyKeyRead({ toolName: "exec", params: { command, workdir }, rootDir: root })?.environ, command + " in " + workdir).toBe(true);
      }
      for (const [command, workdir] of [["cat Lproc/status", "~"], ["cat Lp*/status", "~"], ["cat status", "~/Lproc"]]) {
        expect(classifyKeyRead({ toolName: "exec", params: { command, workdir }, rootDir: root }), command + " in " + workdir).toBeNull();
      }
    } finally {
      fs.rmSync(home, { force: true });
      fs.rmSync(link, { force: true });
    }
  });

  it("lets through a listing, a note and other /proc files", () => {
    for (const [toolName, params] of environAllowed()) expect(classifyKeyRead({ toolName, params, rootDir: root }), JSON.stringify(params)).toBeNull();
  });
});

describe("relay guard refusals through the plugin (GST-2940, GST-2910)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });
  const pinnedRun = async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    return ctx.deliver(ctx.oauthDelegate(kPinned).agent);
  };

  it("runs the note and the grep a box agent was refused for", async () => {
    const run = await pinnedRun();
    const config = path.join(ctx.rootDir, ".openclaw", "openclaw.json");
    for (const command of ["grep -n 'gbrain' " + config + " 2>/dev/null | head -20", "echo 'Paired the phone with openclaw qr (gateway config untouched)' >> memory/2026-11-17.md", "cat >> memory/2026-11-17.md <<'EOF'\n- Ran " + BT + "openclaw qr" + BT + " (pairing)\nEOF"]) {
      expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("names a filled-in path under .openclaw and points a shell write at the file-edit tool", async () => {
    const run = await pinnedRun();
    const dir = path.join(ctx.rootDir, ".openclaw");
    const filled = await ctx.call(run, "exec", { command: "cat >> " + dir + "/workspace/memory/$(date +%F).md <<EOF\n$(date): gateway restarted\nEOF" });
    expect(filled.block).toBe(true);
    expect(filled.blockReason).toContain("a path the shell fills in under " + dir + " would change what decides relay trust");
    expect(filled.blockReason).toContain("name the file in full inside the process instead of with a shell substitution, or write it with the file-edit tool");
    expect(filled.blockReason).not.toContain("openclaw command the shell fills in");
    const change = await ctx.call(run, "exec", { command: kChange });
    expect(change.blockReason).toContain("If you were only writing a plain note, write it with the file-edit tool instead of a shell command. Otherwise say so in your answer");
    const write = await ctx.call(run, "write", { path: path.join(ctx.rootDir, "relay", "x.md"), content: "x" });
    expect(write.blockReason).toContain("would change what decides relay trust");
    expect(write.blockReason).not.toContain("file-edit tool");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("refuses a process environment read with its own reason", async () => {
    const run = await pinnedRun();
    const result = await ctx.call(run, "exec", { command: "tr '\\0' '\\n' < /proc/self/environ" });
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("a command that reaches a process's environment (/proc/<pid>/environ) is refused in every relay session");
    expect((await ctx.call(run, "read", { path: "/proc/1/environ" })).blockReason).toContain("read a process's environment (/proc/<pid>/environ) is refused in every relay session");
  });
});

// GST-3423: a glob over a big folder that cannot reach the guest notes
// broker's directory was refused once it matched more than 2,000 paths (a
// brain's people folder, reached through a symlink, counts each page twice).
// A match that is not a symlink lands where its folder lands, so only
// symlinks and folders count now; every real reach still refuses.
describe("relay guard and big globs near the guest notes broker's files (GST-3423)", () => {
  const kPages = 1200;
  const wintermuteScan = (dir) =>
    "cd " + dir + ' && grep -l -i -E "^(role|relationship|tags):.*(divorce|mediat|family law|custody|co-?parent|therap|psychiatr|physician|doctor|pediatrician|dentist|primary care)" *.md 2>/dev/null | while read f; do e=$(grep -m2 -o -i -E "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}" "$f" | tr \'\\n\' \' \'); r=$(grep -m1 -i -E "^(role|relationship):" "$f" | cut -c1-110); echo "$f | $e | $r"; done | head -60';
  let root;
  let people;
  let brainLink;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-big-glob-")));
    fs.mkdirSync(path.join(root, ".openclaw", "workspace", "memory"), { recursive: true });
    const guest = path.join(root, "guest-writes");
    fs.mkdirSync(guest);
    for (const name of ["internal-secret", "broker-client.json", "broker.db"]) fs.writeFileSync(path.join(guest, name), "x");
    people = path.join(root, "stronghold-brain", "brain", "people");
    fs.mkdirSync(people, { recursive: true });
    for (let i = 0; i < kPages; i += 1) fs.writeFileSync(path.join(people, "person-" + i + ".md"), "role: friend\n");
    brainLink = path.join(root, "brain");
    fs.symlinkSync(path.join(root, "stronghold-brain", "brain"), brainLink);
    for (let i = 0; i < 2500; i += 1) fs.writeFileSync(path.join(root, ".openclaw", "workspace", "memory", "day-" + i + ".md"), "");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const verdict = (command) => classifyKeyRead({ toolName: "exec", params: { command }, rootDir: root });

  it("lets through a scan of a 1,200-page folder reached through a symlink, and other big globs that cannot reach the broker", () => {
    for (const command of [
      wintermuteScan(path.join(brainLink, "people")),
      wintermuteScan(people),
      "grep -l -i role " + brainLink + "/people/*.md",
      "cd " + brainLink + " && grep -l -i role */*.md",
      "wc -l memory/*",
      "wc -l memory/*.md memory/day-1*.md",
    ]) {
      expect(verdict(command), command.slice(0, 120)).toBeNull();
    }
  });

  it("still refuses a big glob with a page that is a symlink into guest-writes, or a folder that is one", () => {
    const page = path.join(people, "zz-broker.md");
    fs.symlinkSync(path.join(root, "guest-writes", "broker-client.json"), page);
    try {
      expect(verdict(wintermuteScan(path.join(brainLink, "people")))?.action).toBe("a command that reaches the guest notes broker's files");
      expect(verdict("grep -l -i role " + brainLink + "/people/*.md")).toBeTruthy();
    } finally {
      fs.unlinkSync(page);
    }
    const folder = path.join(people, "gw");
    fs.symlinkSync(path.join(root, "guest-writes"), folder);
    try {
      expect(verdict("cd " + people + " && cat */internal-secret")).toBeTruthy();
      expect(verdict("cd " + brainLink + " && grep -l -i role */*/*")).toBeTruthy();
    } finally {
      fs.unlinkSync(folder);
    }
  });

  it("still refuses globs that spell the broker's folder, fan out through it, or climb into it", () => {
    for (const command of [
      "cd " + root + " && cat */broker-client.json",
      "cd " + root + " && grep -l x */*",
      "cat " + root + "/gu*/*",
      "cat " + people + "/../../../guest-writes/*",
      "cd " + people + " && cat ../../../guest-writes/*.json",
    ]) {
      expect(verdict(command), command).toBeTruthy();
    }
  });

  it("still fails closed on a glob that matches more than 2,000 symlinks, saying the glob is too big rather than naming the broker; a real reach beside it keeps the broker's reason", () => {
    const links = fs.mkdtempSync(path.join(root, ".openclaw", "workspace", "links-"));
    for (let i = 0; i < 2001; i += 1) fs.symlinkSync(path.join(people, "person-0.md"), path.join(links, "l" + i + ".md"));
    try {
      expect(verdict("wc -l " + links + "/*.md")).toEqual({ action: "a command whose glob matches too many entries to check", globCap: true });
      expect(verdict("wc -l " + links + "/*.md " + root + "/guest-writes/broker.db")).toEqual({ action: "a command that reaches the guest notes broker's files" });
      expect(verdict("wc -l " + links + "/l1*.md")).toBeNull();
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
    }
  });

  it("walks a relative glob from the command's folder, never from /", () => {
    const workspace = path.join(root, ".openclaw", "workspace");
    const stars = Array.from({ length: root.split("/").filter(Boolean).length + 1 }, () => "*").join("/");
    expect(verdict("cd " + workspace + " && grep -r hi " + stars)).toBeNull();
    expect(verdict("cd " + workspace + " && wc -l */*")).toBeNull();
    expect(verdict("cd " + root + " && grep -r hi */*")).toBeTruthy();
  });

  it("follows .. from where a symlinked match lands, as the shell does", () => {
    const sub = path.join(root, "sub");
    const link = path.join(root, ".openclaw", "workspace", "Lsub");
    fs.mkdirSync(sub);
    fs.symlinkSync(sub, link);
    try {
      expect(verdict("cd " + path.join(root, ".openclaw", "workspace") + " && cat Ls*/../gu*/*")).toBeTruthy();
      expect(verdict("cat " + path.join(root, ".openclaw", "workspace") + "/Ls*/../gu*/*")).toBeTruthy();
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });

  it("gives a relay file or a process environment its own reason beside a glob too big to check", () => {
    const links = fs.mkdtempSync(path.join(root, ".openclaw", "workspace", "links-"));
    fs.mkdirSync(path.join(root, "relay"), { recursive: true });
    fs.writeFileSync(path.join(root, "relay", "secrets.json"), "{}");
    for (let i = 0; i < 2001; i += 1) fs.symlinkSync(path.join(people, "person-0.md"), path.join(links, "l" + i + ".md"));
    try {
      expect(verdict("wc -l " + links + "/*.md " + root + "/relay/secrets.json")?.action).toMatch(/^a command that reaches the relay's /);
      expect(verdict("wc -l " + links + "/*.md /proc/self/environ")?.environ).toBe(true);
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
      fs.rmSync(path.join(root, "relay"), { recursive: true, force: true });
    }
  });

  it("refuses a glob too big to check in the relay and environment walks too, below a real reach's own reason", () => {
    const links = fs.mkdtempSync(path.join(root, ".openclaw", "workspace", "links-"));
    for (let i = 0; i < 2001; i += 1) fs.symlinkSync(path.join(people, "person-0.md"), path.join(links, "l" + i + ".md"));
    // With no AlphaClaw root there is no broker folder to walk toward, so
    // only the relay and environment walks can give up on this glob.
    const bare = (toolName, params) => classifyKeyRead({ toolName, params, rootDir: "" });
    try {
      expect(bare("exec", { command: "wc -l " + links + "/*.md" })).toEqual({ action: "a command whose glob matches too many entries to check", globCap: true });
      expect(bare("process", { action: "write", sessionId: "s1", data: "wc -l " + links + "/*.md\n" })).toEqual({ action: "input whose glob matches too many entries to check", globCap: true });
      expect(bare("exec", { command: "wc -l " + links + "/*.md /proc/self/environ" })?.environ).toBe(true);
      expect(bare("exec", { command: "wc -l " + links + "/*.md /srv/relay/bridge.db" })?.action).toBe("a command that reaches the relay's bridge.db");
      expect(bare("exec", { command: "ls " + links + "/*.md" })).toBeNull();
      expect(bare("exec", { command: "wc -l " + links + "/l1*.md" })).toBeNull();
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
    }
  });

  // The box's people folder holds 31,194 pages. Its listing is served by
  // the fs the guard is given (35,000 regular files), so the case runs in
  // milliseconds without writing them; the folders and the symlink are real.
  it("checks a 35,000-page folder behind a symlink quickly and lets it through", () => {
    const big = path.join(root, "big-brain", "people");
    fs.mkdirSync(big, { recursive: true });
    fs.symlinkSync(path.join(root, "big-brain"), path.join(root, "big"));
    const pages = Array.from({ length: 35000 }, (_, i) => ({ name: "person-" + i + ".md", isSymbolicLink: () => false, isDirectory: () => false }));
    let bigReads = 0;
    const fsModule = { ...fs, readdirSync: (dir, options) => (dir === big ? (bigReads += 1, pages) : fs.readdirSync(dir, options)) };
    const command = wintermuteScan(path.join(root, "big", "people"));
    const timed = () => {
      const readsBefore = bigReads;
      const started = process.hrtime.bigint();
      const result = classifyKeyRead({ toolName: "exec", params: { command }, rootDir: root, fsModule });
      return { result, ms: Number(process.hrtime.bigint() - started) / 1e6, reads: bigReads - readsBefore };
    };
    try {
      const runs = [timed(), timed(), timed()];
      expect(runs.map((run) => run.result)).toEqual([null, null, null]);
      expect(runs.every((run) => run.reads >= 1 && run.reads <= 4)).toBe(true);
      // gstack-timing-ok: the fastest of three runs, about 90 ms on a loaded 4-core runner; the read count above (at most once per glob word in the command) is the deterministic check
      expect(Math.min(...runs.map((run) => run.ms))).toBeLessThan(250);
      pages.push({ name: "zz-broker.md", isSymbolicLink: () => true, isDirectory: () => false });
      fs.symlinkSync(path.join(root, "guest-writes", "broker-client.json"), path.join(big, "zz-broker.md"));
      expect(timed().result).toEqual({ action: "a command that reaches the guest notes broker's files" });
    } finally {
      fs.rmSync(path.join(root, "big"));
      fs.rmSync(path.join(root, "big-brain"), { recursive: true, force: true });
    }
  });
});


// GST-3439: the key-read checks split a command into words after dropping
// every quote and backslash, so a workspace link whose name holds a space
// ("my notes", 'my notes', my\ notes) was read as two words that land
// nowhere, and a recursive grep or a tar of a link to a relay backup copy,
// the relay folder, the guest notes broker's folder or a process
// environment ran. The checks now also read each word with real quote and
// backslash state. Every row here also runs in real bash, zsh and dash (and
// inside OpenClaw's eval), with stub cat, grep, head and tar on PATH that
// record the arguments they were given: a refused row hands at least one
// argument that lands on a protected file or folder to its command in every
// shell, and an allowed neighbour hands none.
describe("relay guard and link names with a space in them (GST-3439)", () => {
  let spacedRoot;
  let spacedWorkspace;
  let argLog;
  let argEnv;
  let protectedDirs;
  const kProtectedText = "PROTECTED-GST-3439";
  beforeAll(() => {
    spacedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-spaced-")));
    spacedWorkspace = path.join(spacedRoot, ".openclaw", "workspace");
    fs.mkdirSync(path.join(spacedWorkspace, "memory"), { recursive: true });
    fs.writeFileSync(path.join(spacedWorkspace, "memory", "n.md"), "x\n");
    const backup = path.join(spacedRoot, "20261112-relay-backup");
    const relay = path.join(spacedRoot, "relay");
    const guest = path.join(spacedRoot, "guest-writes");
    for (const [dir, file] of [[backup, "secrets.json"], [relay, "secrets.json"], [guest, "broker-client.json"]]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, file), kProtectedText + "\n");
    }
    const plain = path.join(spacedRoot, "plain folder");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "a.md"), "x\n");
    fs.symlinkSync(backup, path.join(spacedWorkspace, "my notes"));
    fs.symlinkSync(relay, path.join(spacedWorkspace, "box keys"));
    fs.symlinkSync(relay, path.join(spacedWorkspace, "$keys"));
    fs.symlinkSync(backup, path.join(spacedWorkspace, "my \u00e9notes"));
    fs.symlinkSync(guest, path.join(spacedWorkspace, "broker files"));
    fs.symlinkSync("/proc/self", path.join(spacedWorkspace, "my proc"));
    fs.symlinkSync("/proc/self/environ", path.join(spacedWorkspace, "my env"));
    fs.symlinkSync(plain, path.join(spacedWorkspace, "my folder"));
    fs.symlinkSync(relay, path.join(spacedWorkspace, "k{eys"));
    fs.symlinkSync(backup, path.join(spacedWorkspace, "k}eys"));
    fs.symlinkSync(relay, path.join(spacedWorkspace, "keys"));
    protectedDirs = [backup, relay, guest];
    const bin = path.join(spacedRoot, "stub-bin");
    fs.mkdirSync(bin);
    argLog = path.join(spacedRoot, "args.log");
    const stub = "#!/bin/sh\nfor a in \"$@\"; do case $a in /*) printf '%s\\n' \"$a\" ;; *) printf '%s\\n' \"$PWD/$a\" ;; esac >> \"$ARG_LOG\"; done\n/usr/bin/head -c 200 >> \"$ARG_LOG\"\n";
    for (const name of ["cat", "grep", "head", "tar"]) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
    argEnv = { PATH: bin + ":/usr/local/bin:/usr/bin:/bin", HOME: spacedRoot, ZDOTDIR: spacedRoot, ARG_LOG: argLog, LANG: "C" };
  });
  afterAll(() => fs.rmSync(spacedRoot, { recursive: true, force: true }));

  // Each spelling of a spaced name the shells read as one word.
  const spellings = (name) => [["double quotes", '"' + name + '"'], ["single quotes", "'" + name + "'"], ["a backslash", name.replace(/ /g, "\\ ")]];
  const refusedRows = () => [
    ...spellings("my notes").flatMap(([how, word]) => [
      ["a recursive grep of a backup link in " + how, "grep -r x " + word, "relay"],
      ["a tar of a backup link in " + how, "tar czf /tmp/o.tgz " + word, "relay"],
      ["a cat of a key in a backup link in " + how, "cat " + word.replace(/(["']?)$/, "/secrets.json$1"), "relay"],
    ]),
    ...spellings("box keys").flatMap(([how, word]) => [
      ["a recursive grep of a relay link in " + how, "grep -r x " + word, "relay"],
      ["a cat of secrets.json in a relay link in " + how, "cat " + word.replace(/(["']?)$/, "/secrets.json$1"), "relay"],
    ]),
    ...spellings("broker files").flatMap(([how, word]) => [
      ["a recursive grep of a guest-writes link in " + how, "grep -r x " + word, "guest"],
      ["a cat in a guest-writes link in " + how, "cat " + word.replace(/(["']?)$/, "/broker-client.json$1"), "guest"],
    ]),
    ...spellings("my proc").map(([how, word]) => ["a cat of environ through a /proc/self link in " + how, "cat " + word.replace(/(["']?)$/, "/environ$1"), "environ"]),
    ...spellings("my env").map(([how, word]) => ["a cat of a link to /proc/self/environ in " + how, "cat " + word, "environ"]),
    ["half-quoted backup link", 'grep -r x my" notes"', "relay"],
    ["a quoted cd into a backup link, then a grep", 'cd "my notes" && grep -r x secrets.json', "relay"],
    ["a cd into a relay link with a backslash, then a cat", "cd box\\ keys && cat secrets.json", "relay"],
    ["a grep of a backup link after a substituted cd", '`cd` grep -r x "my notes"', "relay"],
    ["a grep of a backup link after $(cd)", '$(cd) grep -r x "my notes"', "relay"],
    ["a cat in a relay link after a substituted cd", '`cd` cat "box keys/secrets.json"', "relay"],
    ["a quoted redirect from a guest-writes link", 'head -c 9 < "broker files/broker-client.json"', "guest"],
    ["a backup link in double quotes then a backslash", 'grep -r x "my"\\ notes', "relay"],
    ["a relay link whose name holds a $, in single quotes", "cat '$keys/secrets.json'", "relay"],
    // $'...' is bash and zsh quoting, $"..." bash's; dash reads each as a $
    // and the quotes.
    ["a backup link in $'...'", "grep -r x $'my notes'", "relay", ["bash", "zsh"]],
    ["a backup link in $'...' with a hex escape", "tar czf /tmp/o.tgz $'my\\x20notes'", "relay", ["bash", "zsh"]],
    ["a relay link in $'...' with an octal escape", "cat $'box\\040keys/secrets.json'", "relay", ["bash", "zsh"]],
    ["a backup link in $'...' cut short by a NUL", "grep -r x $'my notes\\0junk'", "relay", ["bash", "zsh"]],
    ["a backup link in $\"...\"", 'grep -r x $"my notes"', "relay", ["bash"]],
    // \xc3\xa9 and \303\251 are the UTF-8 bytes of é, which the shells pass
    // to the command as they are.
    ["a backup link named with UTF-8 hex escapes in $'...'", "grep -r x $'my \\xc3\\xa9notes'", "relay", ["bash", "zsh"]],
    ["a backup link named with UTF-8 octal escapes in $'...'", "tar czf /tmp/o.tgz $'my \\303\\251notes'", "relay", ["bash", "zsh"]],
    // A cd that fails leaves the shell where it was, so later words still
    // count from there.
    ["a cat in a relay link after a cd that fails", 'cd nowhere; cat "box keys/secrets.json"', "relay"],
    ["a grep of a backup link after a cd that fails, then ||", "cd nowhere || grep -r x 'my notes'", "relay"],
    ["a cat in a relay link after a cd into a missing folder under an ordinary one", "cd 'my folder/none'; cat box\\ keys/secrets.json", "relay"],
    // GST-3446: an unquoted { , or } is part of the word, so a link named
    // k{eys is read as it is; a brace list bash and zsh expand (dash does
    // not) is read as each word it makes.
    ["a cat in a relay link whose name holds an unquoted {", "cat k{eys/secrets.json", "relay"],
    ["a cat in a backup link whose name holds an unquoted }", "cat k}eys/secrets.json", "relay"],
    ["a recursive grep of a relay link whose name holds an unquoted {", "grep -r x k{eys", "relay"],
    ["a cat in a relay link whose name holds a quoted {", 'cat "k{eys"/secrets.json', "relay"],
    ["a cat in a backup link whose name holds a } in single quotes", "cat 'k}eys/secrets.json'", "relay"],
    ["a cat in a relay link whose name holds a backslashed {", "cat k\\{eys/secrets.json", "relay"],
    ["a cd into a relay link whose name holds an unquoted {, then a cat", "cd k{eys && cat secrets.json", "relay"],
    ["a cat through a brace list that makes a relay link's name", "cat k{eys,x}/secrets.json", "relay", ["bash", "zsh"]],
    ["a cat through a brace list at the start of a relay link's name", "cat {k,x}eys/secrets.json", "relay", ["bash", "zsh"]],
    ["a cat through a nested brace list", "cat {k{eys,x},y}/secrets.json", "relay", ["bash", "zsh"]],
    ["a recursive grep through a brace list that makes a spaced backup link's name", "grep -r x {my,no}\\ notes", "relay", ["bash", "zsh"]],
    ["a cd and a cat inside a { ...; } group", "{ cd keys; cat secrets.json; }", "relay"],
    // zsh reads a brace list in command position as a group, not a list.
    ["a brace list in command position that makes a cat of a relay link", "{cat,keys/secrets.json}", "relay", ["bash"]],
    ["a brace list in command position that makes a cd into a relay link", "{cd,keys}; cat secrets.json", "relay", ["bash"]],
  ];
  const allowedRows = () => [
    ...spellings("my folder").flatMap(([how, word]) => [
      ["a recursive grep of an ordinary spaced folder in " + how, "grep -r x " + word],
      ["a tar of an ordinary spaced folder in " + how, "tar czf /tmp/o.tgz " + word],
    ]),
    ["a double-quoted search string", 'grep -rn "meeting notes" memory'],
    ["a single-quoted search string with a key file's name", "grep -rn 'secrets json box' memory"],
    ["a backslash-escaped search string", "grep -rn meeting\\ notes memory"],
    ["a search string the shell fills in", 'grep -rn "$USER notes" memory'],
    ["a search string in $'...'", "grep -rn $'meeting\\tnotes' memory"],
    ["a listing of a spaced backup link", 'ls -la "my notes"'],
    ["a note that names a spaced backup link", 'echo "my notes" >> memory/n.md'],
    ["a brace list of ordinary notes", "cat memory/{n,o}.md"],
    ["a brace list whose words name no link", "cat k{x,y}/secrets.json"],
    ["a brace sequence in a note", "echo {1..5} >> memory/n.md"],
    ["a cd and a cat of an ordinary note inside a { ...; } group", "{ cd memory; cat n.md; }"],
    ["a brace list in command position that makes a cat of an ordinary note", "{cat,memory/n.md}"],
  ];

  const verdict = (toolName, command) => classifyKeyRead({ toolName, params: toolName === "exec" ? { command } : { action: "write", sessionId: "s1", data: command + "\n" }, rootDir: spacedRoot });
  const landsProtected = (arg) => {
    if (arg === kProtectedText) return true;
    if (!arg.startsWith("/")) return false;
    const spelled = path.resolve(arg);
    let landed = spelled;
    try {
      landed = fs.realpathSync(spelled);
    } catch {}
    return /^\/proc\/[^/]+\/environ$/.test(landed) || protectedDirs.some((dir) => landed === dir || landed.startsWith(dir + "/"));
  };
  // Which runners hand their command an argument that lands on a protected
  // file or folder (a relative one resolved from the folder the command runs
  // in), or feed it a protected file on its input.
  const shellsReaching = (command) => {
    const reached = [];
    for (const [name, file, argv] of kRunners) {
      if (!file) continue;
      fs.rmSync(argLog, { force: true });
      spawnSync(file, argv(command), { cwd: spacedWorkspace, env: argEnv, timeout: 5000, stdio: "ignore" });
      const args = fs.existsSync(argLog) ? fs.readFileSync(argLog, "utf8").split("\n") : [];
      if (args.some(landsProtected)) reached.push(name);
    }
    return reached;
  };
  const shellNames = () => kRunners.filter(([, file]) => file).map(([name]) => name);

  it("refuses an exec or typed input that reaches a protected file through a spaced link name, for every spelling", () => {
    for (const [label, command, kind] of refusedRows()) {
      for (const toolName of ["exec", "process"]) {
        const hit = verdict(toolName, command);
        expect(hit, toolName + ": " + label).not.toBeNull();
        if (kind === "environ") expect(hit.environ, toolName + ": " + label).toBe(true);
        else if (kind === "guest") expect(hit.action, toolName + ": " + label).toContain("guest notes broker's files");
        else expect(hit.action, toolName + ": " + label).toContain("the relay's");
      }
    }
  });

  it("hands a protected path to the command in every real shell for each refused row ($'...' and $\"...\" in the shells that read them)", () => {
    for (const [label, command, , only] of refusedRows()) {
      expect(shellsReaching(command), label).toEqual(shellNames().filter((name) => !only || only.includes(name.replace(/^openclaw-/, ""))));
    }
  });

  it("lets through an ordinary spaced folder, a quoted search string, a listing and a note", () => {
    for (const [label, command] of allowedRows()) expect(verdict("exec", command), label).toBeNull();
  });

  it("hands no protected path to the command in any real shell for each allowed neighbour", () => {
    for (const [label, command] of allowedRows()) expect(shellsReaching(command), label).toEqual([]);
  });
});

// GST-3439: reading words with real quote state must not make the guard slow
// on a long command (a 10 KB $'...' word took 1.8 s in review). Each shape
// below runs through the plugin's hook for the owner's pinned thread; the
// best of five warm runs finishes under 50 ms (the best, so a parallel test
// file or a GC pause on a busy CI runner does not decide it).
describe("relay guard on long commands (GST-3439)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });
  const shapes = (size) => [
    ["$'...' full of unknown escapes", "grep -r x $'" + "\\q".repeat(size / 2) + "'"],
    ["$'...' full of UTF-8 byte escapes", "grep -r x $'my " + "\\303\\251".repeat(size / 8) + "'"],
    ["$'...' full of hex escapes", "cat $'" + "\\x41".repeat(size / 4) + "'"],
    ["double quotes full of backslashes", 'cat "' + "\\a".repeat(size / 2) + '"'],
    ["a word of escaped spaces", "cat " + "my\\ ".repeat(size / 4)],
    ["a path of many folders and ..", "cat " + "q/".repeat(size / 4) + "../a/".repeat(size / 10)],
    ["words with braces bash leaves as they are", "cat " + "k{x}/{y ".repeat(size / 8)],
  ];
  it("checks a 10 KB and a 100 KB command in the hook in under 50 ms", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    for (const size of [10000, 100000]) {
      for (const [label, command] of shapes(size)) {
        expect(command.length, label).toBeGreaterThanOrEqual(size);
        let best = Infinity;
        for (let i = 0; i < 6; i += 1) {
          const started = process.hrtime.bigint();
          const result = await ctx.call(run, "exec", { command: command + " " + i });
          const took = Number(process.hrtime.bigint() - started) / 1e6;
          expect(result, label).toEqual({});
          if (i > 0) best = Math.min(best, took);
        }
        expect(best, size + " bytes, " + label).toBeLessThan(50);
      }
    }
  });

  // GST-3446: the brace word cap is counted while the words are read, and a
  // word over the per-word cap spends the whole budget, so a long command of
  // lists that expand is refused without expanding them all.
  it("refuses a 100 KB command of expanding brace lists, under or over the per-word cap, in under 50 ms", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const shapes = [
      ["words of 256 each", "cat " + "x{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p} ".repeat(100000 / 42 + 1)],
      ["words over 256 each", "echo " + "{a,b}".repeat(9).concat(" ").repeat(100000 / 46 + 1)],
    ];
    for (const [label, command] of shapes) {
      expect(command.length, label).toBeGreaterThanOrEqual(100000);
      let best = Infinity;
      for (let i = 0; i < 6; i += 1) {
        const started = process.hrtime.bigint();
        const result = await ctx.call(run, "exec", { command: command + i });
        const took = Number(process.hrtime.bigint() - started) / 1e6;
        expect(result.blockReason, label).toContain("a command whose brace lists make more words than the guard checks is refused in every relay session");
        if (i > 0) best = Math.min(best, took);
      }
      expect(best, label).toBeLessThan(50);
    }
  });

  // A cd that fails keeps the folder the shell stood in, so each cd can add
  // folders to check; past 64 the command is refused with its own reason
  // rather than walked.
  it("refuses a command whose cd steps leave more than 64 folders to check, and runs ordinary cds and a listing", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const capped = await ctx.call(run, "exec", { command: "cd q; ".repeat(40) + "cat notes.md" });
    expect(capped.block).toBe(true);
    expect(capped.blockReason).toContain("a command whose cd steps leave more folders than the guard checks is refused in every relay session");
    expect(capped.blockReason).toContain("Use absolute paths or split the command.");
    expect(await ctx.call(run, "exec", { command: "cd q; ".repeat(40) + "ls -la" })).toEqual({});
    expect(await ctx.call(run, "exec", { command: "cd memory && cd .. && cd memory; cd /tmp; cat notes.md" })).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
  });

  // GST-3446: each word a brace list makes is checked, so a list that makes
  // more than 256 words for one word or 1,024 for a command is refused with
  // its own reason rather than walked.
  it("refuses a command whose brace lists make more words than the guard checks, and runs ordinary brace lists", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const list = "{" + Array.from({ length: 8 }, (_, i) => "p" + i).join(",") + "}";
    for (const command of ["cat {1..300}", "cat " + "{a,b}".repeat(9), "cat " + (list + "/" + list + " ").repeat(17)]) {
      const capped = await ctx.call(run, "exec", { command });
      expect(capped.block, command.slice(0, 40)).toBe(true);
      expect(capped.blockReason).toContain("a command whose brace lists make more words than the guard checks is refused in every relay session");
      expect(capped.blockReason).toContain("Write the names out, use a loop, or split the command.");
    }
    expect(await ctx.call(run, "exec", { command: "cat " + (list + "/" + list + " ").repeat(16) })).toEqual({});
    expect(await ctx.call(run, "exec", { command: "cat memory/{a,b,c}.md; echo {1..200} >/dev/null" })).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
  });
});

