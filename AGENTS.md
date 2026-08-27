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

## Change workflow

- Treat `NOTES.md` and imported architecture reports as proposals, not runtime
  contracts.
- Begin with one typed SiteAgent-to-runtime job and one bounded
  read/edit/check/preview loop. Do not scaffold future services before that
  slice has a real caller and verification evidence.
- When an implementation replaces a temporary or legacy path, remove the old
  path or document its authority, owner, and measurable removal trigger.

## Development and runtime environments

- The developer host is Windows with PowerShell 7 by default. Label Git Bash
  commands explicitly; Git Bash is optional compatibility, not Linux proof.
- Sprites run Linux/Bash. Runtime code must use case-sensitive paths, no Windows
  drive letters or `.cmd` assumptions, UTF-8 without BOM, and LF endings.
- Use CRLF only for Windows-only `.ps1`, `.cmd`, and `.bat` entrypoints.
- Codex/Cursor roles are development helpers only. Deployed product agents use
  server-side OpenAI/Anthropic provider adapters and runtime-managed secrets.
