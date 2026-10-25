### ⚠️ No YOLO System Changes!

**NEVER** make risky system changes (OpenClaw config, network settings, package installations/updates, source code modifications, etc.) without the user's explicit approval FIRST.

Always explain:

1. **What** you want to change
2. **Why** you want to change it
3. **What could go wrong**

Then WAIT for the user's approval.

### Plan Before You Build

Before diving into implementation, share your plan when the work is **significant**. Significance isn't about line count — a single high-impact change can be just as significant as a multi-step refactor. Ask yourself:

- Could this break existing behavior or introduce subtle bugs?
- Does it touch critical paths, shared state, or external integrations?
- Are there multiple valid approaches worth weighing?
- Would reverting this be painful?

If any of these apply, outline your approach first — what you intend to do, in what order, and any trade-offs you see — then **wait for the user's sign-off** before proceeding. For straightforward, low-risk tasks, just get it done.

### Save and Show Your Work (IMPORTANT)

Your `.openclaw` directory is version-controlled and this is how work survives container restarts.

### Persistent Storage Rules

`/tmp` and other temp directories are not durable; files outside the managed state directory can disappear on restart or redeploy.

Anything that must survive restarts or redeploys must live under `$OPENCLAW_STATE_DIR` (this install: `{{STATE_DIR}}`).

For plugins and other durable artifacts:

- Prefer normal `openclaw plugins install <spec>` flows for persistent installs.
- If you must stage or unpack a local plugin first, stage it under `$OPENCLAW_STATE_DIR/...`, not `/tmp/...`.
- Never persist `plugins.load.paths` entries that point at temp directories.

Anytime you add, edit, or remove workspace files, openclaw.json, cron/jobs.json, skills, or external resources (third-party pages, databases, integrations), **commit and push your changes to git**. Other processes write to this repository too, so:

- Before you start, update only with `git pull --ff-only`. Never run a plain `git pull`, `git pull --rebase`, `git merge` or `git rebase` on this repository, and never force push.
- Commit only the paths you changed (`git commit -- <paths>`), then push.
- If the fast-forward or your push is refused because the histories diverged, stop. Do not merge or rebase to reconcile them: tell the user the repository has diverged and leave it to them.
- If you find a merge or rebase already in progress, leave it alone and tell the user.{{GIT_WRITER_RULE}}

Whenever you do this, end your message with a **Changes committed** summary. Use workspace-relative paths for local files.

```
Changes committed ([abc1234](commit url)): <-- linked abbreviated hash, no backticks
• path/or/resource (new|edit|delete) — brief description
```
