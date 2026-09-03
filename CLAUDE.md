# AlphaClaw

Project conventions live in AGENTS.md — read it first.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Testing

Run `npm test` (Vitest). UI bundle: `npm run build:ui` after any lib/public/js change.

## Merge unification safety

Parallel agent branches on the same subsystem have repeatedly destroyed each
other's freshly-merged work in this repo: #13 rewrote day-old #8, #14 dropped
#6's team-session model, and #29/#32 fixed the same bug twice, then #32 grafted
its migration engine over main's already-landed #29 fix. `main` also moves fast
enough that a branch's version number is stale by the time it's ready. Follow
these rules on every branch:

- **Before starting, check in-flight PRs for overlap with your target files:**
  `gh pr list --state open --json number,headRefName,files --jq '.[] | "#\(.number) \(.headRefName) \(.files[].path)"' | grep <path-prefix>`
  If an open PR touches your subsystem, sequence behind it or take it over — do
  not fork a rival branch against the same file cluster.
- **Never run two concurrent branches against the same subsystem.** One
  subsystem, one in-flight branch at a time.
- **On any conflict or semantic overlap with freshly-merged `main`:** stop,
  `git merge origin/main` FIRST, then list every file where both sides changed
  behavior and reconcile each one explicitly. `main`'s merged semantics win by
  default — never silently keep "mine". Re-run `npm test` (and `npm run
  test:container` when the change touches the gateway/upgrade/boot spine; record
  "container tier not runnable here" if Docker is unavailable), then describe
  the reconciliation file-by-file in the PR body.
- **Version numbers are claimed at merge time, not branch time.** After merging
  `main`, renumber `package.json`/`package-lock.json`/`CHANGELOG.md` to the next
  free version and stack your CHANGELOG entry above the ones that landed while
  you were out. `VERSION` is not a tracked file — `package.json` is the source
  of truth.
- **Deleting or rewriting code merged within the last 7 days requires a
  "Supersedes recent work" section in the PR body:** name the prior PR, each
  file removed or rewritten, and why replacement beats extension.
