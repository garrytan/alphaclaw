import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness with dep tracking (sidebar-git-panel.test.js pattern).
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.pendingEffects = [];
  };
  const depsChanged = (previousDeps, nextDeps) =>
    !previousDeps ||
    !nextDeps ||
    previousDeps.length !== nextDeps.length ||
    nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  harness.flushEffects = () => {
    const pending = harness.pendingEffects.splice(0);
    for (const { slot, effect } of pending) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect() || null;
    }
    return pending.length;
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = {
        value: typeof initialValue === "function" ? initialValue() : initialValue,
      };
    }
    const slot = harness.slots[index];
    const setState = (next) => {
      slot.value = typeof next === "function" ? next(slot.value) : next;
    };
    return [slot.value, setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ref: { current: initialValue } };
    }
    return harness.slots[index].ref;
  };
  const useMemo = (factory, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { computed: false };
    const slot = harness.slots[index];
    if (!slot.computed || depsChanged(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
      slot.computed = true;
    }
    return slot.value;
  };
  const useCallback = (fn) => fn;
  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ran: false, cleanup: null };
    }
    const slot = harness.slots[index];
    const changed = !slot.ran || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.ran = true;
    if (changed) harness.pendingEffects.push({ slot, effect });
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.fromEntries(Object.keys(actual).map((key) => [key, vi.fn()]));
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import {
  copyTeamInviteLink,
  createTeamInvite,
  fetchDevicePairings,
  fetchTeam,
  fetchTeamPresence,
  revokeTeamInvite,
} from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useTeamTab } from "../../lib/public/js/components/team-tab/use-team-tab.js";
import {
  InvitesCard,
  PresenceCard,
} from "../../lib/public/js/components/team-tab/index.js";
import { formatLocaleDate } from "../../lib/public/js/lib/format.js";

const harness = preactHooks.__harness;

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  return out;
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) {
    collectText(node.props.children, out);
  }
  return out;
};

const nodeText = (node) => collectText(node).join(" ").replace(/\s+/g, " ");

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const makeTeam = (overrides = {}) => ({
  enabled: true,
  me: { role: "member" },
  members: [],
  invites: [],
  presence: [{ email: "sam@acme.dev", displayName: "Sam", lastSeenAt: null }],
  ...overrides,
});

describe("frontend/team-tab presence refresh failures", () => {
  let intervalCallbacks;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    intervalCallbacks = [];
    vi.stubGlobal("setInterval", (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    });
    vi.stubGlobal("clearInterval", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderHook = () => {
    harness.beginRender();
    return useTeamTab();
  };

  it("stores the caught message string (never a boolean) and clears it on recovery", async () => {
    fetchTeam.mockResolvedValue(makeTeam());

    let hook = renderHook();
    expect(hook.presenceUnavailable).toBe(null);
    harness.flushEffects();
    await flushAsync();

    hook = renderHook();
    harness.flushEffects(); // registers the presence poll interval
    await flushAsync();
    expect(intervalCallbacks.length).toBeGreaterThan(0);

    fetchTeamPresence.mockRejectedValueOnce(new Error("presence socket down"));
    await intervalCallbacks.at(-1)();
    hook = renderHook();
    expect(hook.presenceUnavailable).toBe("presence socket down");

    fetchTeamPresence.mockResolvedValueOnce({ presence: [] });
    await intervalCallbacks.at(-1)();
    hook = renderHook();
    expect(hook.presenceUnavailable).toBe(null);
  });

  it("falls back to 'unknown error' when the rejection carries no message", async () => {
    fetchTeam.mockResolvedValue(makeTeam());

    renderHook();
    harness.flushEffects();
    await flushAsync();
    renderHook();
    harness.flushEffects();
    await flushAsync();

    fetchTeamPresence.mockRejectedValueOnce(undefined);
    await intervalCallbacks.at(-1)();
    const hook = renderHook();
    expect(hook.presenceUnavailable).toBe("unknown error");
  });

  it("a failed device-queue poll is devicesError, never an empty queue; it clears on recovery (F170)", async () => {
    fetchTeam.mockResolvedValue(makeTeam({ me: { role: "admin" } }));
    fetchDevicePairings.mockRejectedValueOnce(new Error("pairings offline"));

    renderHook();
    harness.flushEffects();
    await flushAsync();
    renderHook();
    // Registers the presence poll AND the device poll; the device poll runs
    // immediately (immediate: true) — and fails.
    harness.flushEffects();
    await flushAsync();
    let hook = renderHook();
    expect(hook.devicesError).toBe("pairings offline");
    expect(hook.devicePending).toEqual([]);
    expect(intervalCallbacks.length).toBe(2);

    fetchDevicePairings.mockResolvedValueOnce({ pending: [{ id: "req-1" }] });
    await intervalCallbacks.at(-1)(); // the device poll registered last
    hook = renderHook();
    expect(hook.devicesError).toBe(null);
    expect(hook.devicePending).toEqual([{ id: "req-1" }]);
  });
});

describe("frontend/team-tab PresenceCard failure model", () => {
  const presence = [
    { email: "sam@acme.dev", displayName: "Sam", lastSeenAt: null },
  ];

  it("renders two lines — a static headline plus the message on its own muted line — above the last known roster", () => {
    const tree = PresenceCard({
      presence,
      presenceUnavailable: "socket closed",
    });
    const paragraphs = collectNodes(tree).filter((node) => node.type === "p");

    const headline = paragraphs.find((node) =>
      nodeText(node).includes("Presence refresh failed"),
    );
    expect(headline).toBeTruthy();
    expect(nodeText(headline)).toContain(
      "Presence refresh failed — showing last known presence. Retrying automatically.",
    );
    // The raw error never rides mid-sentence in the headline.
    expect(nodeText(headline)).not.toContain("socket closed");

    const detail = paragraphs.find((node) =>
      nodeText(node).includes("socket closed"),
    );
    expect(detail).toBeTruthy();
    expect(String(detail.props.class)).toContain("text-xs");
    expect(String(detail.props.class)).toContain("text-fg-muted");

    // "Showing last known presence" stays true: the roster remains rendered.
    expect(nodeText(tree)).toContain("Sam");
  });

  it("renders no failure lines while presence is healthy", () => {
    const tree = PresenceCard({ presence, presenceUnavailable: null });
    expect(nodeText(tree)).not.toContain("Presence refresh failed");
    expect(nodeText(tree)).toContain("Sam");
  });
});

describe("frontend/team-tab invite links (GST-1787)", () => {
  const kExpiresAt = Date.UTC(2026, 10, 14, 12);
  const kInvite = { id: "inv-1", email: null, role: "member", expiresAt: kExpiresAt };
  const kLink = {
    ok: true,
    invite: kInvite,
    url: "https://claw.example.com/login.html?invite=fresh-link",
  };

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderCard = (props) => {
    harness.beginRender();
    return InvitesCard({ invites: [kInvite], ...props });
  };
  const copyButtonOf = (tree) =>
    collectNodes(tree).find((node) => node.props?.idleLabel === "Copy new link");

  it("shows a Copy new link button on each pending invite that asks for that invite's link", () => {
    const onCopyInviteLink = vi.fn();
    const button = copyButtonOf(renderCard({ onCopyInviteLink }));
    expect(button).toBeTruthy();
    expect(button.props.loading).toBe(false);
    button.props.onClick();
    expect(onCopyInviteLink).toHaveBeenCalledWith("inv-1");
    expect(copyButtonOf(renderCard({ linkingInviteId: "inv-1" })).props.loading).toBe(true);
  });

  it("shows the new link once with the invite's own expiry", () => {
    const text = nodeText(renderCard({ freshInvite: kLink }));
    expect(text).toContain(kLink.url);
    expect(text).toContain("shown only once");
    expect(text).toContain(formatLocaleDate(kExpiresAt, { valueIsEpochMs: true }));
    expect(text).not.toContain("7 days");
  });

  it("onCopyInviteLink fetches a new link, copies it and keeps it on screen", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    copyTeamInviteLink.mockResolvedValue(kLink);

    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    const hook = useTeamTab();

    expect(copyTeamInviteLink).toHaveBeenCalledWith("inv-1");
    expect(writeText).toHaveBeenCalledWith(kLink.url);
    expect(hook.freshInvite).toEqual(kLink);
    expect(hook.linkingInviteId).toBe(null);
    expect(showToast).toHaveBeenCalledWith(
      "New invite link copied. The old link no longer works.",
      "success",
    );
  });

  const revokeButtonOf = (tree) =>
    collectNodes(tree).find((node) => node.props?.idleLabel === "Revoke");

  it("disables Revoke on an invite while its Copy new link request is in flight", () => {
    expect(revokeButtonOf(renderCard({})).props.disabled).toBeFalsy();
    expect(revokeButtonOf(renderCard({ linkingInviteId: "inv-1" })).props.disabled).toBe(true);
  });

  it("drops a Copy new link response that lands after the invite was revoked", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    fetchTeam.mockResolvedValue(makeTeam({ me: { role: "admin" } }));
    fetchTeamPresence.mockResolvedValue({ presence: [] });
    fetchDevicePairings.mockResolvedValue({ pending: [] });
    revokeTeamInvite.mockResolvedValue({ ok: true });
    let resolveCopy;
    copyTeamInviteLink.mockReturnValue(new Promise((resolve) => { resolveCopy = resolve; }));

    harness.beginRender();
    const copying = useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    await useTeamTab().onRevokeInvite("inv-1");
    resolveCopy(kLink);
    await copying;
    harness.beginRender();
    const hook = useTeamTab();

    expect(hook.freshInvite).toBe(null);
    expect(writeText).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith(
      "New invite link copied. The old link no longer works.",
      "success",
    );
  });

  const kInvite2 = { id: "inv-2", email: "sam@acme.dev", role: "admin", expiresAt: kExpiresAt };

  it("allows one Copy new link at a time: every other Copy and every Revoke wait while one is in flight", () => {
    harness.beginRender();
    const tree = InvitesCard({ invites: [kInvite, kInvite2], linkingInviteId: "inv-1" });
    const copies = collectNodes(tree).filter((node) => node.props?.idleLabel === "Copy new link");
    const revokes = collectNodes(tree).filter((node) => node.props?.idleLabel === "Revoke");
    expect(copies[0].props.loading).toBe(true);
    expect(copies[1].props.disabled).toBe(true);
    expect(revokes.every((node) => node.props.disabled === true)).toBe(true);
  });

  it("ignores a second Copy new link while one is in flight", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    let resolveCopy;
    copyTeamInviteLink.mockReturnValueOnce(new Promise((resolve) => { resolveCopy = resolve; }));

    harness.beginRender();
    const first = useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-2");
    resolveCopy(kLink);
    await first;

    expect(copyTeamInviteLink).toHaveBeenCalledTimes(1);
    expect(copyTeamInviteLink).toHaveBeenCalledWith("inv-1");
  });

  it("ignores a Copy new link reply that a newer invite action superseded", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    fetchTeam.mockResolvedValue(makeTeam({ me: { role: "admin" } }));
    const kCreated = { ok: true, invite: kInvite2, token: "t", url: "https://claw.example.com/login.html?invite=created" };
    createTeamInvite.mockResolvedValue(kCreated);
    let resolveCopy;
    copyTeamInviteLink.mockReturnValueOnce(new Promise((resolve) => { resolveCopy = resolve; }));

    harness.beginRender();
    const copying = useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    await useTeamTab().onCreateInvite({ email: "sam@acme.dev", role: "admin" });
    resolveCopy(kLink);
    await copying;
    harness.beginRender();

    expect(useTeamTab().freshInvite).toEqual(kCreated);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears the shown link for that invite when Copy new link fails", async () => {
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    copyTeamInviteLink.mockResolvedValueOnce(kLink);

    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    expect(useTeamTab().freshInvite).toEqual(kLink);

    copyTeamInviteLink.mockRejectedValueOnce(new Error("network error"));
    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    expect(useTeamTab().freshInvite).toBe(null);
  });

  it("names the invite and its role above the link it shows", () => {
    const named = nodeText(renderCard({ freshInvite: { ...kLink, invite: kInvite2 } }));
    expect(named).toContain("sam@acme.dev");
    expect(named).toContain("(admin)");
    const open = nodeText(renderCard({ freshInvite: kLink }));
    expect(open).toContain("anyone with the link");
    expect(open).toContain("(member)");
  });

  it("onCopyInviteLink shows the server's refusal and no link", async () => {
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    copyTeamInviteLink.mockRejectedValue(
      new Error("That invite was used, revoked or has expired. Create a new invite."),
    );

    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    expect(useTeamTab().freshInvite).toBe(null);
    expect(showToast).toHaveBeenCalledWith(
      "That invite was used, revoked or has expired. Create a new invite.",
      "error",
    );
  });
  it("clears a link already shown for an invite when a newer action drops that invite's Copy new link reply (round 4)", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    const kRotated = { ...kLink, url: "https://claw.example.com/login.html?invite=rotated-link" };
    copyTeamInviteLink.mockResolvedValueOnce(kLink);
    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    expect(useTeamTab().freshInvite).toEqual(kLink);

    let resolveCopy;
    copyTeamInviteLink.mockReturnValueOnce(new Promise((resolve) => { resolveCopy = resolve; }));
    createTeamInvite.mockRejectedValueOnce(new Error("create failed"));
    harness.beginRender();
    const copying = useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    await useTeamTab().onCreateInvite({ email: "", role: "member" });
    resolveCopy(kRotated);
    await copying;
    harness.beginRender();

    expect(useTeamTab().freshInvite).toBe(null);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalledWith(kRotated.url);
  });

  it("clears a link already shown for an invite when a revoke in flight drops its Copy new link reply and then fails (round 4)", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());
    const kRotated = { ...kLink, url: "https://claw.example.com/login.html?invite=rotated-link" };
    copyTeamInviteLink.mockResolvedValueOnce(kLink);
    harness.beginRender();
    await useTeamTab().onCopyInviteLink("inv-1");
    harness.beginRender();
    expect(useTeamTab().freshInvite).toEqual(kLink);

    let rejectRevoke;
    revokeTeamInvite.mockReturnValueOnce(new Promise((_, reject) => { rejectRevoke = reject; }));
    let resolveCopy;
    copyTeamInviteLink.mockReturnValueOnce(new Promise((resolve) => { resolveCopy = resolve; }));
    harness.beginRender();
    const revoking = useTeamTab().onRevokeInvite("inv-1");
    harness.beginRender();
    const copying = useTeamTab().onCopyInviteLink("inv-1");
    resolveCopy(kRotated);
    await copying;
    rejectRevoke(new Error("revoke failed"));
    await revoking;
    harness.beginRender();

    expect(useTeamTab().freshInvite).toBe(null);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalledWith(kRotated.url);
  });

  it("disables Create invite while a Copy new link request is in flight (round 4)", () => {
    const createButtonOf = (tree) =>
      collectNodes(tree).find((node) => node.props?.idleLabel === "Create invite");
    expect(createButtonOf(renderCard({})).props.disabled).toBeFalsy();
    expect(createButtonOf(renderCard({ linkingInviteId: "inv-1" })).props.disabled).toBe(true);
  });
});

