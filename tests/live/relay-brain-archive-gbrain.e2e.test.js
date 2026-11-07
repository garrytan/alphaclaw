// LIVE TIER — the relay brain archive against a REAL gbrain CLI (the version
// the box runs, named by OPENCLAW_LIVE_GBRAIN_BIN) and a scratch brain with a
// non-federated "relay" source (gbrain-scratch.js). Pins what the hermetic
// tests only fake: put's argv and receipt, --expected-revision,
// revision_required and revision_conflict, a write left pending (exit 10,
// read back with write-request, committed by the next write), the
// commit-push of an untracked page in a checkout with no remote, and that an
// unscoped read never sees a relay page. The engine and session are fakes.
const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");

const kGbrain = process.env.OPENCLAW_LIVE_GBRAIN_BIN || "";
const describeLive = liveHelpers.kLiveEnabled && kGbrain && process.platform === "linux" ? describe : describe.skip;
const kT0 = Date.parse("2026-11-07T00:00:00Z");

describeLive("LIVE relay brain archive against a real gbrain", () => {
  const { createScratchBrain } = require("./gbrain-scratch");
  const { createRelayBrainArchive } = require("../../lib/server/relay/brain-archive");
  const { redactSecretText } = require("../../lib/server/utils/redact");
  let brain;
  let clock = kT0;
  const messages = [];
  let conversationId = "dm_live1";
  let slug = "relay/wintermute/capy-live/dm_live1";
  const makeArchive = ({ archiveDb, bin = kGbrain }) =>
    createRelayBrainArchive({
      config: { brainMode: "auto", brainBin: bin },
      paths: { dir: path.dirname(archiveDb), archiveDb },
      engine: {
        conversations: async () => [
          { id: conversationId, participants: ["wintermute", "capy-live"], message_count: messages.length, last_message: { id: messages[messages.length - 1].id, created_at: messages[messages.length - 1].createdAt } },
        ],
      },
      getAuth: () => ({ workspaceKey: "k", agentName: "wintermute" }),
      conversations: { transcript: async () => ({ messages: [...messages], nextBefore: null }) },
      requestGateway: async () => ({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Checking the disk." }, { type: "toolCall", id: "c1", name: "exec", arguments: { command: "df -h ARGUMENT-MARKER" } }], timestamp: kT0 - 50_000 },
          { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "TOOL-RESULT-MARKER" }], timestamp: kT0 - 49_000 },
        ],
      }),
      maskText: (text) => redactSecretText(String(text)),
      env: brain.env,
      now: () => clock,
      sleep: async () => {},
      logger: { log: (line) => console.log("[live] " + line), warn: (line) => console.log("[live] " + line) },
    });
  const settle = async (archive) => {
    clock += 3 * 60 * 1000;
    await archive._internal.tick();
    clock += 3 * 60 * 1000;
    await archive._internal.tick();
  };
  const state = (archive) => archive._internal.store().getConversation(conversationId);
  const page = () => brain.json(["get", "--source", "relay", "--json", "--", slug]);

  beforeAll(() => {
    brain = createScratchBrain(kGbrain);
    messages.push({ id: "1", from: "capy-live", text: "How full is the disk? canary-relay-7731", createdAt: new Date(kT0 - 60_000).toISOString() });
  }, 300_000);

  it("creates the page in the relay source, commits it, never shows it unscoped, and replaces it with the revision gbrain returned", async () => {
    const archive = makeArchive({ archiveDb: path.join(brain.home, "a1", "archive.db") });
    await settle(archive);
    const status = archive.getStatus();
    console.log("[live] archive status: " + JSON.stringify(status));
    expect(status).toMatchObject({ phase: "ready", code: null, parked: [] });
    expect(status.counts).toMatchObject({ pages: 1, commitsQueued: 0 });
    const first = page();
    expect(first).toMatchObject({ type: "relay-conversation", source_id: "relay", frontmatter: expect.objectContaining({ trust: "external", facts_backstop: false, conversation_id: "dm_live1" }) });
    expect(brain.trackedFiles("relay")).toEqual([slug + ".md"]);
    expect(brain.commitSubjects()[0]).toBe("relay archive: 1 page");
    const text = fs.readFileSync(path.join(brain.checkout, slug + ".md"), "utf8");
    expect(text).toContain("used tool \x60exec\x60");
    expect(text).not.toMatch(/ARGUMENT-MARKER|TOOL-RESULT-MARKER/);
    const unscoped = brain.run(["get", "--json", "--", slug]);
    expect(unscoped.status).toBe(1);
    expect(liveHelpers.parseSingleJsonDocument(unscoped.stdout, { label: "gbrain get (unscoped)" }).code).toBe("page_not_found");
    expect(brain.json(["search", "canary-relay-7731", "--json"])).toEqual([]);

    messages.push({ id: "2", from: "wintermute", text: "41% used.", createdAt: new Date(kT0 - 30_000).toISOString() });
    await settle(archive);
    const second = page();
    expect(second.revision).not.toBe(first.revision);
    expect(brain.commitSubjects().slice(0, 2)).toEqual(["relay archive: 1 page", "relay archive: 1 page"]);
    expect(state(archive)).toMatchObject({ state: "idle", code: null });
    archive.stop();
  }, 300_000);

  it("a lost archive.db meets revision_required: the page is kept as found and new messages continue on the next part; an edit made elsewhere parks as revision_conflict until Retry", async () => {
    const archive = makeArchive({ archiveDb: path.join(brain.home, "a2", "archive.db") });
    const before = fs.readFileSync(path.join(brain.checkout, slug + ".md"), "utf8");
    messages.push({ id: "3", from: "capy-live", text: "Thanks.", createdAt: new Date(kT0 - 10_000).toISOString() });
    await settle(archive);
    expect(state(archive)).toMatchObject({ state: "idle", code: null });
    expect(fs.readFileSync(path.join(brain.checkout, slug + ".md"), "utf8")).toBe(before);
    const nextSlug = slug + "-part-2";
    const next = fs.readFileSync(path.join(brain.checkout, nextSlug + ".md"), "utf8");
    expect(next).toContain("Thanks.");
    expect(next).not.toContain("41% used.");
    expect(next).not.toContain("Checking the disk.");

    const edited = brain.json(["get", "--source", "relay", "--json", "--", nextSlug]);
    const crypto = require("crypto");
    brain.json(["put", nextSlug, "--source", "relay", "--expected-revision", edited.revision, "--request-id", crypto.randomUUID(), "--json"], {
      input: "---\ntype: relay-conversation\ntitle: edited elsewhere\nconversation_id: dm_live1\n---\nedited\n",
    });
    messages.push({ id: "4", from: "wintermute", text: "Anytime.", createdAt: new Date(kT0 - 5_000).toISOString() });
    await settle(archive);
    expect(state(archive)).toMatchObject({ state: "parked", code: "revision_conflict" });
    archive.retry();
    await archive._internal.tick();
    expect(state(archive)).toMatchObject({ state: "idle", code: null });
    expect(fs.readFileSync(path.join(brain.checkout, nextSlug + ".md"), "utf8")).toContain("Anytime.");
    expect(fs.readFileSync(path.join(brain.checkout, slug + ".md"), "utf8")).toBe(before);
    archive.stop();
  }, 300_000);

  it("exit 10: a write gbrain left queued is read back with write-request, never resubmitted, and lands once gbrain commits it", async () => {
    const wrapper = path.join(brain.home, "gbrain-wait0");
    fs.writeFileSync(wrapper, "#!/bin/sh\nif [ \"$1\" = put ]; then cmd=\"$1\"; shift; exec \"" + kGbrain + "\" \"$cmd\" --wait-ms 0 \"$@\"; fi\nexec \"" + kGbrain + "\" \"$@\"\n", { mode: 0o755 });
    const archive = makeArchive({ archiveDb: path.join(brain.home, "a3", "archive.db"), bin: wrapper });
    conversationId = "dm_live2";
    slug = "relay/wintermute/capy-live/dm_live2";
    messages.splice(0, messages.length, { id: "9", from: "capy-live", text: "A new conversation.", createdAt: new Date(kT0).toISOString() });
    await archive._internal.tick();
    clock += 3 * 60 * 1000;
    const before = archive._internal.store().listParts(conversationId);
    expect(before).toEqual([]);
    await archive._internal.tick();
    const stored = state(archive);
    console.log("[live] pending write: " + JSON.stringify({ state: stored.state, code: stored.code }));
    expect(stored).toMatchObject({ state: "backoff", code: "write_pending" });
    const [part] = archive._internal.store().listParts(conversationId);
    expect(part.requestPending).toBe(true);
    // Another writer's committed put drains gbrain's queue on a CLI-only brain.
    brain.json(["put", "relay/live/other/nudge", "--source", "relay", "--request-id", require("crypto").randomUUID(), "--json"], { input: "---\ntype: note\ntitle: nudge\n---\nnudge\n" });
    clock = stored.nextAttemptAt;
    await archive._internal.tick();
    expect(state(archive)).toMatchObject({ state: "idle", code: null });
    expect(brain.trackedFiles("relay/wintermute/capy-live")).toContain(slug + ".md");
    archive.stop();
  }, 300_000);
});
