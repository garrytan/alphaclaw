const { classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2473: a pinned binding (Garry's own thread) was refused for prose.
// The guard counted every ( as a part the shell fills in, so "OpenClaw (the
// runtime)" in a commit message, or a Python tuple in a here-document next
// to the words config, gateway or plugin, looked like an openclaw command it
// could not read. A ( that starts a word and holds no pattern character now
// only separates words; everything else is read as before.
const kPinned = "capy-25cf4e98b5b6";
const kDir = "/data/ops/live-recall/b4";

const boxBody = [
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

const builder = [
  "import json, os",
  "from pathlib import Path",
  "# Questions about OpenClaw (the runtime) and the gateway; never touches config.",
  "QUESTIONS = [",
  '    {"slug": "claw-maintenance", "q": "How does OpenClaw (the runtime) restart the gateway, and drain the running turn?"},',
  '    {"slug": "gateway-config", "q": "Which config does the gateway read at boot?", "gold": "OpenClaw reads its config (and the files it includes) once at boot."},',
  "]",
  "out = Path('" + kDir + "/questions-b4.jsonl')",
  "out.write_text('\\n'.join(json.dumps(q) for q in QUESTIONS))",
  "os.chmod(out, 0o600)",
  'print(f"wrote {len(QUESTIONS)} questions")',
].join("\n");

// The two refused wm-guards commits, letters masked by the box operator,
// every symbol kept.
const commitBody = "x xxxxxxx-xxxx xxxx OpenClaw x xxxxxxxx xxxxx-xxxxx xxxxxxx xx xxx xxx xxxxx xxxx xx xxxxxx xx xxxxx xx xxx xxxxx's xxxxxxx xxx. xxxxxxxx xxxxx xxx xxxxxx xxxx xxxx xxx xxx's xxxx xxxxxxx xxxxxxx xxx xxxxxxx xxxxxx. xxx xxx xxxxx-xxxxxxx xxxxx xxxxx xx xxxx xxx xxxxxxx xxx (…:xxxxxxxx:xxxxx:<gid>:xxxxx:<n>) xx xxxxxxxxxxxxxxxx, xxxxxxx xxx guards' xxxxxxx xxxxxx xxxxxxx, xxx xxxx x xxxxxxxxxxxxxxx xxx xxxx xxx xxxx. xx xxxxxx xxxxx xx xxxxxxxx xxxxxx (xxxxxxxx, xxxxxxxxxxxxxxx, xxxxxxxxxxxxxxxxx, xxxx, xxxxxxxx xx x :xxxxx: xxxxxx), xxx xxxxx xxxx, xxx-xxxxxxx xxxxxxx xxx xxx xxxxxxx xxxxx. xxxxxxxxxxxxxxxxx=xxxxx-xxxxxxx xxxxx xx xxx.\n\nxxxxx-xxxx xx xxxxxx xxxxxx xxx xxx-xxxx xxxxxxxxxxxx xxx xx xxxxx xxx-xxxx xxxx. xxxx xxx xxxxxx xx xxx xxxxxxxxxxxxxx xxx xxxxx xxx xxxxxx, xx xxxxxxx xxxxxx x xxxxx xxxxxx xxxxx-xxxx.\n\nxxxxx: wm-guards-xxxxx-xxxxxxx.xxxx.mjs (xx xxx); wm-guards-xxxx's xxxxx xxxx xxx xxxxxxxx xxxxx-xxxxxxx.";
const commitSubject = "wm-guards: xxxx x xxxxx xxxxx's xxxxxxx-xxxx xxxxx xx xxxx xxxxx, xxx xxxx xxxxx-xxxx's xxx-xxxx xxxxx xxx (xxx-xxxx)";

const allowed = [
  "cd " + kDir + " && cat > build.py <<'EOF'\n" + boxBody + "\nEOF\numask 077; python3 build.py",
  "cd " + kDir + " && cat > build.py <<'EOF'\n" + boxBody + "\nEOF\numask 077; python3 build.py; chmod 600 questions-b4.jsonl build.py; sha256sum questions-b4.jsonl | cut -c1-16",
  "python3 - <<'PY'\n" + builder + "\nPY",
  "cat > " + kDir + "/build_questions.py <<'PY'\n" + builder + "\nPY\npython3 " + kDir + "/build_questions.py",
  "cat > /data/tmp/xxxxxxx/xxxx.xxx <<'EOF'\nx xxxxxxx-xxxx xxxx OpenClaw x xxxxxxxx xxxxx-xxxxx xxxxxxx xx xxx xxx xxxxx xxxx xx xxxxxx xx xxxxx xx xxx xxxxx's xxxxxxx xxx. xxxxxxxx xxxxx xxx xxxxxx xxxx xxxx xxx xxx's xxxx xxxxxxx xxxxxxx xxx xxxxxxx xxxxxx. xxx xxx xxxxx-xxxxxxx xxxxx xxxxx xx xxxx xxx xxxxxxx xxx (…:xxxxxxxx:xxxxx:<gid>:xxxxx:<n>) xx xxxxxxxxxxxxxxxx, xxxxxxx xxx guards' xxxxxxx xxxxxx xxxxxxx, xxx xxxx x xxxxxxxxxxxxxxx xxx xxxx xxx xxxx. xx xxxxxx xxxxx xx xxxxxxxx xxxxxx (xxxxxxxx, xxxxxxxxxxxxxxx, xxxxxxxxxxxxxxxxx, xxxx, xxxxxxxx xx x :xxxxx: xxxxxx), xxx xxxxx xxxx, xxx-xxxxxxx xxxxxxx xxx xxx xxxxxxx xxxxx. xxxxxxxxxxxxxxxxx=xxxxx-xxxxxxx xxxxx xx xxx.\n\nxxxxx-xxxx xx xxxxxx xxxxxx xxx xxx-xxxx xxxxxxxxxxxx xxx xx xxxxx xxx-xxxx xxxx. xxxx xxx xxxxxx xx xxx xxxxxxxxxxxxxx xxx xxxxx xxx xxxxxx, xx xxxxxxx xxxxxx x xxxxx xxxxxx xxxxx-xxxx.\n\nxxxxx: wm-guards-xxxxx-xxxxxxx.xxxx.mjs (xx xxx); wm-guards-xxxx's xxxxx xxxx xxx xxxxxxxx xxxxx-xxxxxxx.\nEOF\nx=\"$(cat /data/tmp/xxxxxxx/xxxx.xxx)\"; x=wintermute/workspace; cd /data/gbrain && XXXXXXXXXXX=/xxxx/.xxx PATH=/xxxx/.xxx/bin:$PATH timeout 120 bun run src/cli.ts git commit-push --path /data/stronghold-wm --json -m \"wm-guards: xxxx x xxxxx xxxxx's xxxxxxx-xxxx xxxxx xx xxxx xxxxx, xxx xxxx xxxxx-xxxx's xxx-xxxx xxxxx xxx (xxx-xxxx)\" -m \"$x\" -- $x/plugins/wm-guards/xxxxx.mjs $x/plugins/wm-guards/xxxxx-xxxx.mjs $x/plugins/wm-guards/xxxxx-xxxxxxx.mjs $x/scripts/tests/wm-guards-xxxx.xxxx.mjs $x/scripts/tests/wm-guards-xxxxx-xxxxxxx.xxxx.mjs 2>&1 | tail -5",
  "cd /data/gbrain && XXXXXXXXXXX=/xxxx/.xxx PATH=/xxxx/.xxx/bin:/usr/local/bin:/usr/bin:/bin timeout 120 bun run src/cli.ts git commit-push --path /data/stronghold-wm --json -m \"wm-guards: xxxx x xxxxx xxxxx's xxxxxxx-xxxx xxxxx xx xxxx xxxxx, xxx xxxx xxxxx-xxxx's xxx-xxxx xxxxx xxx (xxx-xxxx)\" -m \"x xxxxxxx-xxxx xxxx OpenClaw x xxxxxxxx xxxxx-xxxxx xxxxxxx xx xxx xxx xxxxx xxxx xx xxxxxx xx xxxxx xx xxx xxxxx's xxxxxxx xxx. xxxxxxxx xxxxx xxx xxxxxx xxxx xxxx xxx xxx's xxxx xxxxxxx xxxxxxx xxx xxxxxxx xxxxxx. xxx xxx xxxxx-xxxxxxx xxxxx xxxxx xx xxxx xxx xxxxxxx xxx (…:xxxxxxxx:xxxxx:<gid>:xxxxx:<n>) xx xxxxxxxxxxxxxxxx, xxxxxxx xxx guards' xxxxxxx xxxxxx xxxxxxx, xxx xxxx x xxxxxxxxxxxxxxx xxx xxxx xxx xxxx. xx xxxxxx xxxxx xx xxxxxxxx xxxxxx (xxxxxxxx, xxxxxxxxxxxxxxx, xxxxxxxxxxxxxxxxx, xxxx, xxxxxxxx xx x :xxxxx: xxxxxx), xxx xxxxx xxxx, xxx-xxxxxxx xxxxxxx xxx xxx xxxxxxx xxxxx. xxxxxxxxxxxxxxxxx=xxxxx-xxxxxxx xxxxx xx xxx.\n\nxxxxx-xxxx xx xxxxxx xxxxxx xxx xxx-xxxx xxxxxxxxxxxx xxx xx xxxxx xxx-xxxx xxxx. xxxx xxx xxxxxx xx xxx xxxxxxxxxxxxxx xxx xxxxx xxx xxxxxx, xx xxxxxxx xxxxxx x xxxxx xxxxxx xxxxx-xxxx.\n\nxxxxx: wm-guards-xxxxx-xxxxxxx.xxxx.mjs (xx xxx); wm-guards-xxxx's xxxxx xxxx xxx xxxxxxxx xxxxx-xxxxxxx.\" -- wintermute/workspace/plugins/wm-guards/xxxxx.mjs wintermute/workspace/plugins/wm-guards/xxxxx-xxxx.mjs wintermute/workspace/plugins/wm-guards/xxxxx-xxxxxxx.mjs wintermute/workspace/scripts/tests/wm-guards-xxxx.xxxx.mjs wintermute/workspace/scripts/tests/wm-guards-xxxxx-xxxxxxx.xxxx.mjs 2>&1 | tail -5",
  "git commit -m " + JSON.stringify(commitSubject) + " -m " + JSON.stringify(commitBody),
];

const refused = [
  "zsh -c 'openclaw config set (x|plugins.allow) v'",
  "zsh -c 'setopt extendedglob\nopenclaw config unset (^x)'",
  "(openclaw config set plugins.allow x)",
  "bash -c \"(openclaw gateway call config.apply)\"",
  "(x|y) config set plugins.allow v",
  "openclaw config set (plugins.allo?) v",
  "openclaw config unset (plugins.{allow,x})",
  "openclaw config set (plugins.allow<1-2>) v",
  "openclaw config unset (plugins.allow)",
  "openclaw config set ($k) v",
  "openclaw (gateway) call config.apply",
  "openclaw config (set) plugins.allow x",
  "python3 - <<'PY'\nimport os\nos.system(\"openclaw config unset >/dev/null plugins.allow\")\nPY",
  "python3 - <<'PY'\nimport os\nos.system(\"open\"\"claw config patch\")\nPY",
  "cat > /tmp/fix.sh <<'EOF'\nxargs openclaw config unset < /tmp/keys.txt\nEOF",
  "cat > /tmp/r.sh <<'EOF'\ntrue;openclaw config patch\nEOF",
  "cat > /tmp/n.txt <<'EOF'\no=openclaw; $o config set plugins.entries.relay-guard.enabled false\nEOF",
  "cat > /tmp/r.sh <<'EOF'\ndiff <(openclaw config patch) b\nEOF",
  "cat > /tmp/x.sh <<'EOF'\nopenclaw config \\\nset plugins.entries.relay-guard.enabled false\nEOF\ncat > /tmp/b.py <<'PY'\nimport subprocess\nsubprocess.run(['bash','/tmp/x.sh'])\nPY\npython3 /tmp/b.py",
  "bash -c \"openclaw $(echo config) set plugins.allow x\"",
  "openclaw config set (plugins.allow|x) v",
  "(openclaw plugins disable relay-guard)",
  "openclaw config unset (')'|plugins.allow)",
  "openclaw config unset (\\)|plugins.allow)",
  "touch plugins.allow && zsh -c 'openclaw config unset (\\)|plugins.allow)'",
  "zsh -c \"openclaw config unset (')'|plugins.allow)\"",
  "zsh -c \"openclaw config unset (\\\")\\\"|plugins.allow)\"",
  "zsh -c 'openclaw config unset (plugins).allow'",
  "zsh -c 'openclaw config unset (plugins)\".allow\"'",
  "zsh -c 'openclaw config unset (plugins.allo)?'",
  "zsh -c 'openclaw config unset (plugins)(.allow|x)'",
  "zsh -c 'openclaw config unset (x)(|plugins.allow)'",
  "(x|y) config set plugins.allow v",
  "git commit -m \"OpenClaw (the runtime)\" && (openclaw config patch)",
];

const expectRefusedOutright = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/is refused in every relay session|would change what decides relay trust on this box/);
};

describe("relay anchor and parentheses in prose (GST-2473)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });
  const pinnedRun = async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    return ctx.deliver(ctx.oauthDelegate(kPinned).agent);
  };

  it("runs the commands refused on the box: the b4 question builders and the wm-guards commit whose message says OpenClaw (…)", async () => {
    const run = await pinnedRun();
    for (const command of allowed) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).toBeNull();
      expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still refuses an openclaw change behind a subshell, a pattern group, a substitution or a variable", async () => {
    const run = await pinnedRun();
    for (const command of refused) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).not.toBeNull();
      expectRefusedOutright(await ctx.call(run, "exec", { command }), command);
    }
  });
});
