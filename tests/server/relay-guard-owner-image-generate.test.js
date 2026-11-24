const path = require("path");
const { decideRelayToolCall, kOwnerThreadMediaTools } = require("../../lib/plugin/relay-guard/policy");
const { classifyAnchor, classifyKeyRead } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-3677: the owner's own Capy thread over relay (an attested owner thread
// or a pinned binding) makes images with OpenClaw's image_generate tool, the
// way the owner does. Every other delegate and every peer stays refused, and
// no operator entry opens it to them. Its output always lands in OpenClaw's
// media store under a sanitized name, so it cannot write into the trust
// anchor; its reference images are read from disk, so one that reaches the
// relay's files or a process's environment is refused like a read.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const delegate = { tier: "delegate" };
const kGenerate = { prompt: "a lighthouse at dusk, flat colors", size: "1536x1024", filename: "hero.png" };
const kCalls = [kGenerate, { action: "list" }, { action: "status" }, { prompt: "same style", image: "https://example.com/ref.png" }];

describe("relay guard: image_generate for the owner's own thread (GST-3677)", () => {
  it("names the tool exactly", () => {
    expect(kOwnerThreadMediaTools).toEqual(["image_generate"]);
  });

  it("allows it for an owner-thread delegate", () => {
    for (const params of kCalls) expect(decideRelayToolCall({ toolName: "image_generate", params, trust: delegate, ownerThread: true }), JSON.stringify(params)).toEqual({ allow: true });
  });

  it("refuses it for a delegate that is not the owner's thread and for a peer, whatever the operator's tool list says", () => {
    for (const delegateTools of [[], ["image_generate"]]) {
      expect(decideRelayToolCall({ toolName: "image_generate", params: kGenerate, trust: delegate, delegateTools, ownerThread: false }).allow).toBe(false);
      expect(decideRelayToolCall({ toolName: "image_generate", params: kGenerate, trust: { tier: "peer" }, delegateTools, ownerThread: true }).allow).toBe(false);
    }
  });

  it("refuses another media tool and a look-alike name, even for the owner's thread", () => {
    for (const toolName of ["video_generate", "music_generate", "image_generate_v2", "image_generatex", "image-generate"]) {
      expect(decideRelayToolCall({ toolName, params: kGenerate, trust: delegate, ownerThread: true }).allow, toolName).toBe(false);
    }
  });

  it("reads reference images like a read, and never treats the output filename as a path", () => {
    const rootDir = "/srv/alphaclaw";
    const secrets = path.join(rootDir, "relay", "secrets.json");
    for (const params of [
      { prompt: "x", image: secrets },
      { prompt: "x", image: "@" + secrets },
      { prompt: "x", image: "MEDIA:" + secrets },
      { prompt: "x", images: ["https://example.com/a.png", "file://" + secrets] },
      { prompt: "x", image: "/proc/self/environ" },
      { prompt: "x", images: secrets },
      { prompt: "x", images: [...Array(20).fill("https://example.com/a.png"), "@https://example.com/a.png", secrets] },
    ]) expect(classifyKeyRead({ toolName: "image_generate", params, rootDir, agentId: "main" }), JSON.stringify(params)).toMatchObject({ action: expect.stringContaining("image_generate") });
    for (const params of [
      kGenerate,
      { prompt: "x", image: path.join(rootDir, ".openclaw", "workspace", "ref.png") },
      { prompt: "x", images: ["https://example.com/relay/secrets.json", "data:image/png;base64,AAAA", "media://inbound/a.png"] },
      { prompt: "x", filename: "../../relay/secrets.json" },
      { prompt: "x", images: [...Array.from({ length: 16 }, (_, index) => "https://example.com/" + index + ".png"), secrets] },
    ]) {
      expect(classifyKeyRead({ toolName: "image_generate", params, rootDir, agentId: "main" }), JSON.stringify(params)).toBeNull();
      expect(classifyAnchor({ toolName: "image_generate", params, rootDir, agentId: "main" }), JSON.stringify(params)).toBeNull();
    }
  });

  describe("through the plugin entry", () => {
    let ctx;
    afterEach(() => {
      ctx?.cleanup();
      ctx = null;
    });

    it("admits the pinned owner thread's image calls with no confirmation", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
      for (const params of kCalls) expect(await ctx.call(run, "image_generate", params), JSON.stringify(params)).toEqual({});
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("admits the attested owner thread's image calls with no confirmation", async () => {
      ctx = setup();
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      for (const params of kCalls) expect(await ctx.call(run, "image_generate", params), JSON.stringify(params)).toEqual({});
      expect(ctx.confirmationCount()).toBe(0);
      ctx.confirmations.tick();
      expect(ctx.notices).toEqual([]);
    });

    it("refuses a delegate on a binding that is not pinned, with no confirmation row", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
      const result = await ctx.call(run, "image_generate", kGenerate);
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("image_generate is not available to a delegate relay session");
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("refuses a peer", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { grant: false, threadId: "jam_B" }).agent);
      const result = await ctx.call(run, "image_generate", kGenerate);
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("image_generate is not available in a relay session");
    });

    it("refuses the owner's thread a reference image in the relay's files", async () => {
      ctx = setup();
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      const result = await ctx.call(run, "image_generate", { prompt: "x", image: path.join(ctx.rootDir, "relay", "secrets.json") });
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("is refused in every relay session");
      expect(ctx.confirmationCount()).toBe(0);
    });

    // OpenClaw 2026.11.4 defers image_generate behind tool_search and reaches
    // it through dispatch_action (tool_call on 2026.10.9). The dispatcher is a
    // catalog wrapper, and OpenClaw runs the tool it reaches through this hook
    // again under its own name with the same session, so the wrapped call gets
    // the direct call's decision.
    it("gives image_generate through the dispatcher the direct call's decision", async () => {
      ctx = setup();
      const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
      const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
      const peer = await ctx.deliver("lupe");
      for (const wrapper of ["dispatch_action", "tool_call"]) {
        expect(await ctx.call(owner, wrapper, { id: "image_generate", args: kGenerate }), wrapper).toEqual({});
        expect(await ctx.call(owner, "image_generate", kGenerate), wrapper).toEqual({});

        expect(await ctx.call(unattested, wrapper, { id: "image_generate", args: kGenerate }), wrapper).toEqual({});
        const refused = await ctx.call(unattested, "image_generate", kGenerate);
        expect(refused.block, wrapper).toBe(true);
        expect(refused.blockReason, wrapper).toContain("image_generate is not available to a delegate relay session");

        const peerWrapper = await ctx.call(peer, wrapper, { id: "image_generate", args: kGenerate });
        expect(peerWrapper.block, wrapper).toBe(true);
        expect((await ctx.call(peer, "image_generate", kGenerate)).block, wrapper).toBe(true);
      }
      expect(ctx.confirmationCount()).toBe(0);
    });
  });
});
