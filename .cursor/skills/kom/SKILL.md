---
name: kom
description: Contacts an existing Sajtagent development agent to coordinate task scope, files, decisions, or handoff. Use only when explicitly invoked with /kom.
disable-model-invocation: true
---

# Kontakta en annan agent

1. Read `.cursor/rules/04-agent-coordination.mdc` and inspect available active
   agents or tasks.
2. Parse the text after `/kom` as the intended recipient or task plus the
   message. Do not silently choose between ambiguous recipients.
3. Use the available direct agent/task messaging channel. Send at most four
   short fields: task, files/area, what and why, next conflicting action.
4. Do not spawn a new agent merely to complete this command.
5. If no live direct channel exists, create a secret-free fallback note at
   `.agents/coordination/<agent-id>.md`, state that it is not live delivery,
   and pause any overlapping edit.
6. Report one of: `sent`, `waiting for recipient`, or `no safe recipient`.
