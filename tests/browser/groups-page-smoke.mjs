// Real Chromium run of the Groups page (GroupsTab, its dialogs and the API
// client) against the real Telegram group rules routes on a fake box
// (tests/browser/groups-page-fixture.mjs).
// Run: node tests/browser/groups-page-smoke.mjs [screenshot-dir]
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { createGroupsFixture, kGroups } from "./groups-page-fixture.mjs";

const fixture = await createGroupsFixture();
const shots = process.argv[2] || null;
const checks = [];
const mark = (name) => {
  checks.push(name);
  console.log("PASS: " + name);
};
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim(), args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = async (name) => shots && page.screenshot({ path: path.join(shots, name + ".png"), fullPage: true });
  const row = (name) => page.locator("li.groups-row", { hasText: name });
  const dialog = () => page.getByRole("dialog");
  const state = () => fixture.readState();

  await page.goto(fixture.url);
  await page.getByText("2 groups wait for you to pick a rule.", { exact: true }).waitFor();
  const titles = await page.locator(".briefing-section-title").allInnerTexts();
  assert.deepEqual(titles, ["Waiting for you (2)", "Custom (1)", "Approved (2)", "Trusted people (1)", "Silent (2)", "Blocked (2)", "Blocked people"]);
  await row("Core team").getByText("Anonymous admins are not heard").waitFor();
  await row("Old marketplace").getByText("Bad Gateway", { exact: false }).waitFor();
  await shot("groups-full");
  mark("sections in order, warnings and a failed leave shown");

  await row("Weekend plans").getByRole("button", { name: "Approved", exact: true }).click();
  await dialog().getByText("No entry in openclaw.json", { exact: false }).waitFor();
  await dialog().getByRole("button", { name: "Approve group" }).click();
  await page.locator(".briefing-section", { hasText: "Approved (3)" }).waitFor();
  assert.equal(state().groups[kGroups.weekend].mode, "approved");
  const puts = fixture.requests.filter((req) => req.method === "PUT" && req.path.endsWith(kGroups.weekend + "/policy"));
  assert.equal(puts[0].body.dryRun, true, "the preview is a dry run");
  assert.match(puts[1].ifMatch || "", /^"[0-9a-f]{16}"$/, "the save carries If-Match");
  mark("a waiting group is approved through a dry-run preview and an If-Match save");

  const falcon = row("Project Falcon");
  await falcon.getByRole("textbox", { name: /Telegram user id to trust/ }).fill("100000001");
  await falcon.getByRole("button", { name: "Add person" }).click();
  await falcon.getByText("That is an owner", { exact: false }).waitFor();
  await falcon.getByRole("textbox", { name: /Telegram user id to trust/ }).fill("100000006");
  await falcon.getByRole("textbox", { name: "Name" }).fill("Riley");
  await falcon.getByRole("button", { name: "Add person" }).click();
  await falcon.getByText("Riley", { exact: true }).waitFor();
  assert.deepEqual(state().groups[kGroups.falcon].trusted, [{ id: "100000006", scope: "actions", label: "Riley" }]);
  mark("trusted people are added with a scope; an owner id is refused in the form");

  await row("Forum with topics").getByRole("button", { name: "Approved", exact: true }).click();
  await dialog().getByText("A forum topic in this group overrides who may talk there").waitFor();
  await dialog().getByRole("button", { name: "Preview with the topic overrides removed" }).click();
  await dialog().getByText("this mode applies to every topic", { exact: false }).waitFor();
  await dialog().getByRole("button", { name: "Approve group" }).click();
  await dialog().waitFor({ state: "detached" });
  const forum = fixture.readConfig().channels.telegram.groups[kGroups.forum];
  assert.equal(forum.groupPolicy, "open");
  assert.equal(forum.topics["7"].allowFrom, undefined, "topic overrides removed");
  mark("a topic override is explained and removed only after a second preview");

  await row("Imported group").getByRole("button", { name: "Silent", exact: true }).click();
  await dialog().getByText("backed up", { exact: false }).waitFor();
  await dialog().getByRole("button", { name: "Replace rules" }).click();
  await dialog().waitFor({ state: "detached" });
  assert.equal(state().groups[kGroups.imported].mode, "silent");
  mark("a Custom group is converted only after confirming its rules are replaced");

  await row("Old marketplace").getByRole("button", { name: "Try leaving again" }).click();
  await row("Old marketplace").getByText("Part of the change was saved", { exact: false }).waitFor();
  mark("a failed leave renders its problem body with the partial side effect");

  await page.getByRole("textbox", { name: "Telegram user id to block" }).fill("100000010");
  await page.getByRole("textbox", { name: "Name of the person to block" }).fill("Casey");
  await page.getByRole("button", { name: "Block person" }).click();
  await dialog().getByText("Block Casey?").waitFor();
  await dialog().getByRole("button", { name: "Block person" }).click();
  await page.getByRole("button", { name: "Unblock Casey" }).waitFor();
  await page.getByRole("button", { name: "Unblock Pat" }).click();
  await page.getByRole("button", { name: "Unblock Pat" }).waitFor({ state: "detached" });
  assert.deepEqual(state().blockedSenders.map((person) => person.id), ["100000007", "100000010"]);
  mark("blocking asks first; unblocking is one click");

  const family = row("Family chat");
  await family.getByRole("button", { name: "Test this group" }).click();
  await family.getByRole("button", { name: "Run test" }).click();
  await family.locator(".groups-verdict", { hasText: "Alex" }).getByText("Replies").waitFor();
  await family.locator(".groups-verdict", { hasText: "Spam bot" }).locator(".groups-verdict-reason", { hasText: "On your block list." }).waitFor();
  mark("Test this group shows each sender's verdict");

  await fetch(fixture.url + "/__fixture/guard-off");
  await page.reload();
  await page.getByText("Blocks are not enforced").waitFor();
  await row("Family chat").getByRole("button", { name: "Test this group" }).click();
  await row("Family chat").getByRole("button", { name: "Run test" }).click();
  await row("Family chat").locator(".groups-verdict", { hasText: "Spam bot" }).getByText("the group guard is not running", { exact: false }).first().waitFor();
  await shot("groups-guard-off");
  mark("an unenforced group guard shows a banner and the test says the block does not apply");

  await fetch(fixture.url + "/__fixture/unreadable");
  await page.reload();
  await page.getByText("Fix AlphaClaw's group rules file to use this page").waitFor();
  assert.equal(await page.locator("li.groups-row").count(), 0, "no group is editable while the rules file is unreadable");
  await shot("groups-rules-unreadable");
  mark("rules_unreadable renders its own card and hides every control");

  await fetch(fixture.url + "/__fixture/unconfigured");
  await page.reload();
  await page.getByText("Telegram is not set up", { exact: true }).waitFor();
  mark("an unconfigured box points at Channels");

  await fetch(fixture.url + "/__fixture/full");
  for (const [width, theme] of [[390, "dark"], [1100, "light"]]) {
    await page.setViewportSize({ width, height: 1400 });
    await page.goto(fixture.url + (theme === "light" ? "/?theme=light" : "/"));
    await page.getByText("2 groups wait for you to pick a rule.").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow at " + width + "px");
    await shot("groups-" + width + "-" + theme);
  }
  mark("no horizontal overflow at 390 px; light theme renders");
  assert.deepEqual(errors, []);
  console.log("PASS: " + checks.length + " checks");
} finally {
  await browser?.close();
  await fixture.close();
}
