# Sajtagent Sprites instructions

- This is the separate privileged runtime for the SiteAgent product.
- Keep the public web product, Supabase UI, and Vercel publication controls in
  `sajtagent-site`; do not duplicate them here.
- Expose a narrow signed controller API. OpenClaw must not be reachable directly
  from the browser.
- Bind jobs and tools to server-owned project, job, workspace revision, scope,
  budget, expiry, and idempotency values.
- The model may select only from already authorized tools; it never grants
  itself permission.
- Run customer code in an isolated, secret-free worker rather than the
  credential-bearing controller.
- Start with one bounded read/edit/check/preview loop. Add services and agents
  only for demonstrated requirements.
- Never commit `.env.local`, tokens, customer data, or generated workspaces.
- Verify exact Git state and report local, committed, pushed, and deployed state
  separately.
- `main` is the standard branch. If the user says `master`, ask whether they
  really mean `master` before acting.
- End every final response with this repository's live branch and absolute
  worktree path. If several repositories were touched, report each one.
- Never remove dirty, locked, unpushed, active-PR, or unique worktrees.
