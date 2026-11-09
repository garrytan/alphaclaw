import { describe, expect, it } from "vitest";
import {
  buildGroupsHeadline,
  buildPolicyBody,
  confirmCopyForMode,
  describeGroupGuard,
  describeProblem,
  describeRules,
  describeRulesUnreadable,
  describeSender,
  nextBlockedList,
  parsePersonInput,
  removeTrusted,
  sectionIdForGroup,
  setTrustedScope,
  sortGroupsIntoSections,
  upsertTrusted,
} from "../../lib/public/js/components/groups-tab/model.js";

// GST-1975 PR 2: the Groups page's pure model. Every id is fake.
const group = (fields) => ({ groupId: "-1001111111111", title: null, mode: "approved", trusted: [], revision: "0123456789abcdef", ...fields });

describe("groups-tab model: sections", () => {
  it("sorts groups into Waiting, Custom, Approved, Trusted people, Silent and Blocked, dropping empty sections", () => {
    const sections = sortGroupsIntoSections([
      group({ groupId: "-1001111111115", mode: "blocked", title: "Spam lobby" }),
      group({ groupId: "-1001111111112", mode: "approved", title: "b group" }),
      group({ groupId: "-1001111111113", mode: "approved", title: "A group" }),
      group({ groupId: "-1001111111114", mode: "trusted" }),
      group({ groupId: "-1001111111116", mode: "custom" }),
      group({ groupId: "-1001111111117", mode: "waiting", seen: { lastJoinAt: "2026-11-01T00:00:00Z" } }),
      group({ groupId: "-1001111111118", mode: "waiting", seen: { lastJoinAt: "2026-11-08T00:00:00Z" } }),
    ]);
    expect(sections.map((section) => section.id)).toEqual(["waiting", "custom", "approved", "trusted", "blocked"]);
    expect(sections[0].groups.map((entry) => entry.groupId)).toEqual(["-1001111111118", "-1001111111117"]);
    expect(sections[2].groups.map((entry) => entry.title)).toEqual(["A group", "b group"]);
  });

  it("reads an unknown mode from a newer server as Custom and skips rows without an id", () => {
    expect(sectionIdForGroup(group({ mode: "quarantined" }))).toBe("custom");
    expect(sectionIdForGroup({})).toBe("custom");
    expect(sortGroupsIntoSections([{ mode: "approved" }, null])).toEqual([]);
    expect(sortGroupsIntoSections(undefined)).toEqual([]);
  });

  it("leads with what needs the owner", () => {
    expect(buildGroupsHeadline({ data: { configured: true, groups: [group({ mode: "waiting" })] } })).toBe("1 group waits for you to pick a rule.");
    expect(buildGroupsHeadline({ data: { configured: true, groups: [group({ mode: "custom" }), group({ mode: "custom" })] } })).toBe("2 groups have rules set outside AlphaClaw.");
    expect(buildGroupsHeadline({ data: { configured: true, groups: [group({})] } })).toBe("Every Telegram group your agent is in has a rule.");
    expect(buildGroupsHeadline({ data: { configured: false, groups: [] } })).toBe("Telegram is not set up on this box.");
    expect(buildGroupsHeadline({ data: null, problem: { code: "rules_unreadable" } })).toMatch(/cannot read its Telegram group rules file/);
    expect(buildGroupsHeadline({ data: null, problem: { code: "internal_error" } })).toBe("The Telegram groups could not be loaded.");
  });
});

describe("groups-tab model: requests", () => {
  it("sends trusted people only for the modes that hear people, and convert only for Custom groups", () => {
    const trusted = [{ id: "100000002", scope: "actions", label: "Alex" }, { id: 100000003, scope: "other" }];
    expect(buildPolicyBody({ group: group({ trusted, title: "Family chat" }), mode: "approved" })).toEqual({
      mode: "approved",
      title: "Family chat",
      trusted: [{ id: "100000002", scope: "actions", label: "Alex" }, { id: "100000003", scope: "conversation" }],
    });
    expect(buildPolicyBody({ group: group({ trusted }), mode: "silent" })).toEqual({ mode: "silent" });
    expect(buildPolicyBody({ group: group({ mode: "custom" }), mode: "blocked", dryRun: true })).toEqual({ mode: "blocked", convert: true, dryRun: true });
    expect(buildPolicyBody({ group: group({}), mode: "trusted", trusted: [], normalizeTopics: true })).toEqual({ mode: "trusted", trusted: [], normalizeTopics: true });
  });

  it("checks a typed person: numeric id, never an owner, label trimmed and capped", () => {
    expect(parsePersonInput({ id: " " }).error).toMatch(/numeric Telegram user id/);
    expect(parsePersonInput({ id: "@someone" }).error).toMatch(/digits only/);
    expect(parsePersonInput({ id: "100000001", owners: ["100000001"] }).error).toMatch(/owner/);
    expect(parsePersonInput({ id: "100000002", label: "  Alex\n" })).toEqual({ person: { id: "100000002", label: "Alex" } });
    expect(parsePersonInput({ id: "100000002", label: "x".repeat(200) }).person.label).toHaveLength(120);
  });

  it("edits the trusted list and the whole block list", () => {
    const list = [{ id: "100000003", scope: "conversation" }];
    expect(upsertTrusted(list, { id: "100000002", scope: "actions" }).map((person) => person.id)).toEqual(["100000002", "100000003"]);
    expect(upsertTrusted(list, { id: "100000003", label: "Sam" })).toEqual([{ id: "100000003", scope: "conversation", label: "Sam" }]);
    expect(setTrustedScope(list, "100000003", "actions")).toEqual([{ id: "100000003", scope: "actions" }]);
    expect(removeTrusted(list, "100000003")).toEqual([]);
    const blocked = [{ id: "100000007", label: "Spam bot", blockedAt: "2026-11-01T00:00:00Z" }, { id: 100000008 }];
    expect(nextBlockedList(blocked, { removeId: "100000008" })).toEqual([{ id: "100000007", label: "Spam bot" }]);
    expect(nextBlockedList(blocked, { add: { id: "100000010", label: "Casey" } })).toEqual([
      { id: "100000007", label: "Spam bot" },
      { id: "100000008" },
      { id: "100000010", label: "Casey" },
    ]);
  });

  it("warns before replacing Custom rules and before leaving a group", () => {
    const convert = confirmCopyForMode({ group: group({ mode: "custom", title: "Imported" }), mode: "approved" });
    expect(convert).toMatchObject({ converting: true, confirmLabel: "Replace rules", tone: "warning" });
    expect(convert.message).toMatch(/backed up/);
    expect(confirmCopyForMode({ group: group({ mode: "waiting" }), mode: "blocked" })).toMatchObject({ confirmLabel: "Block and leave", tone: "danger" });
  });
});

describe("groups-tab model: problems", () => {
  it("renders a problem body's title, detail, fix, retry and side effects", () => {
    const view = describeProblem({ problem: { code: "validator_unavailable", title: "OpenClaw's config check could not run", detail: "spawn openclaw ENOENT", fix: "Check openclaw.", retry: "after 10 seconds", sideEffects: "none", status: 503 } });
    expect(view).toMatchObject({ code: "validator_unavailable", detail: "spawn openclaw ENOENT", fix: "Check openclaw.", retry: "Try again after 10 seconds.", sideEffects: "Nothing was changed.", partial: false, tone: "bad" });
  });

  it("explains a partial save, and a failed leave in its own words", () => {
    expect(describeProblem({ code: "leave_failed", title: "t", sideEffects: "partial", retry: "safe to retry" })).toMatchObject({
      partial: true,
      tone: "warn",
      retry: "Safe to try again.",
      sideEffects: expect.stringMatching(/blocked and silent, but your agent is still a member/),
    });
    expect(describeProblem({ code: "config_busy", title: "t", sideEffects: "partial" }, { action: "blocked" }).sideEffects).toMatch(/block is recorded/);
    expect(describeProblem({ code: "config_busy", title: "t", sideEffects: "partial" }).sideEffects).toMatch(/Reload the page/);
  });

  it("replaces API-step fixes with the page's own and drops their API retry", () => {
    const view = describeProblem({ code: "topic_override", title: "t", fix: "Send normalizeTopics", retry: "with normalizeTopics set" });
    expect(view.fix).toMatch(/Preview the change again/);
    expect(view.retry).toBe("");
    expect(describeProblem({ code: "revision_mismatch", title: "t", retry: "after reading the revision" }).retry).toBe("");
  });

  it("falls back to a plain error and never repeats the title as detail", () => {
    expect(describeProblem(new Error("Failed to fetch"))).toMatchObject({ title: "Failed to fetch", detail: "", code: null, sideEffects: "" });
    expect(describeProblem({ title: "Same", detail: "Same" }).detail).toBe("");
  });

  it("says how to fix or move aside an unreadable rules file, and what moving it costs", () => {
    const view = describeRulesUnreadable({ detail: "Cannot read /root/.alphaclaw/telegram/group-rules.json: Unexpected token" });
    expect(view.detail).toMatch(/group-rules.json/);
    expect(view.steps.join(" ")).toMatch(/JSON object/);
    expect(view.steps.join(" ")).toMatch(/move it aside[\s\S]*blocked people are heard again/);
  });

  it("shows the group guard banner only when the guard is reported not enforced", () => {
    expect(describeGroupGuard(undefined)).toBeNull();
    expect(describeGroupGuard({ enforced: true, reason: null })).toBeNull();
    expect(describeGroupGuard({ enforced: false, reason: "disabled" }).reason).toMatch(/switched off/);
    expect(describeGroupGuard({ enforced: false, reason: "missing" }).reason).toMatch(/Restart the gateway/);
    expect(describeGroupGuard({ enforced: false, reason: "something-new" }).reason).toMatch(/does not report/);
  });
});

describe("groups-tab model: test verdicts", () => {
  it("separates OpenClaw's modelled layers from plugins it cannot model", () => {
    const view = describeSender(
      {
        id: "100000002",
        label: "Alex",
        roles: ["trusted_actions", "tools_by_sender"],
        reply: "when_mentioned",
        actions: "all",
        reason: null,
        layers: [
          { layer: "openclaw.group", source: "resolveChannelGroupPolicy", allowed: true },
          { layer: "telegram.ingress", source: "telegram group access", allowed: true },
          { layer: "alphaclaw.group-guard", source: "group-rules.json", allowed: true },
          { layer: "openclaw.tools", source: "resolveChannelGroupToolsPolicy", allowed: true, actions: "all" },
          { layer: "box.plugins", source: "not modelled", plugins: ["my-guard"] },
        ],
      },
      { notModelled: ["my-guard", "other-plugin"] },
    );
    expect(view).toMatchObject({ name: "Alex", id: "100000002", actions: "every tool", reason: "", guardSkipped: false });
    expect(view.roles).toEqual(["Trusted with actions", "Has a per-person tool rule"]);
    expect(view.reply).toMatchObject({ word: "Replies", detail: "when mentioned" });
    expect(view.modelled.map((layer) => layer.label)).toEqual(["OpenClaw group policy", "Telegram channel access", "AlphaClaw group guard", "OpenClaw tool policy"]);
    expect(view.modelled[3].detail).toBe("Allows every tool.");
    expect(view.notModelled).toEqual(["my-guard", "other-plugin"]);
  });

  it("names the layer that stopped a sender", () => {
    const view = describeSender({
      id: "100000007",
      label: "Spam bot",
      roles: ["blocked"],
      reply: "never",
      actions: "none",
      reason: "blocked_sender",
      layers: [{ layer: "openclaw.group", allowed: true }, { layer: "telegram.ingress", allowed: true }, { layer: "alphaclaw.group-guard", source: "group-rules.json", allowed: false, reason: "blocked_sender" }],
    });
    expect(view).toMatchObject({ reason: "On your block list.", actions: "", reply: { word: "Ignored", tone: "neutral" } });
    expect(view.modelled[2]).toMatchObject({ verdict: "stops here", detail: "On your block list." });
  });

  it("flags a block the guard does not enforce, and survives a missing or unknown shape", () => {
    const view = describeSender({
      id: "100000007",
      roles: ["blocked"],
      reply: "always",
      actions: "none",
      reason: null,
      layers: [{ layer: "alphaclaw.group-guard", allowed: true, enforced: false, reason: "guard_not_enforced", wouldDrop: "blocked_sender" }, { layer: "future.layer", allowed: true }],
    });
    expect(view).toMatchObject({ guardSkipped: true, name: "", reply: { tone: "warn" } });
    expect(view.reason).toMatch(/group guard is not running/);
    expect(view.modelled.map((layer) => [layer.label, layer.verdict])).toEqual([["AlphaClaw group guard", "not enforced"], ["future.layer", "passes"]]);
    const group = describeSender({
      id: "100000009",
      reply: "always",
      layers: [{ layer: "alphaclaw.group-guard", allowed: true, enforced: false, reason: "guard_not_enforced", wouldDrop: "blocked_group" }],
    });
    expect(group.reason).toMatch(/group is blocked, but the group guard is not running/);
    expect(group.modelled[0].detail).toBe(group.reason);
    expect(describeSender({ id: null, roles: ["anyone_else"], label: "Anyone else", reply: "never" })).toMatchObject({ name: "Anyone else", roles: [], modelled: [] });
  });
});

describe("groups-tab model: rules", () => {
  it("reads owned keys as lines, naming tools by sender", () => {
    expect(
      describeRules({ enabled: true, groupPolicy: "open", toolsBySender: { "id:100000001": {}, "id:100000003": { deny: ["*"] }, "*": { deny: ["exec"] } } }),
    ).toEqual([
      { key: "enabled", value: "true" },
      { key: "groupPolicy", value: "open (every member is heard)" },
      { key: "toolsBySender 100000001", value: "every tool" },
      { key: "toolsBySender 100000003", value: "no tools" },
      { key: "toolsBySender everyone else", value: '{"deny":["exec"]}' },
    ]);
    expect(describeRules({ enabled: false, allowFrom: [] })).toEqual([
      { key: "enabled", value: "false (nobody is heard)" },
      { key: "allowFrom", value: "nobody" },
    ]);
    expect(describeRules(null)).toEqual([]);
  });
});
