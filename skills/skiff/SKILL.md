---
name: skiff
description: Inspect the skiff VMs the Skiff VM plugin runs bb threads in with `bb skiff`. Use when a thread on a Skiff VM cannot reach GitHub or Claude through the broker, when VMs seem left behind, or when the user asks which VMs bb owns.
---

# Skiff VMs

The Skiff VM plugin runs a thread's machine as a fresh Linux VM on this Mac. bb creates and
removes the VM with the thread; this skill only covers looking at them.

## Commands

| Command | Effect |
| --- | --- |
| `bb skiff vms` | VMs owned by bb, with state and IP, as `skiff ls` reports them. |
| `bb skiff reconcile` | Reopen the broker tunnel of every live VM and remove owned VMs bb no longer tracks. |

Add `--json` when the output drives code.

## When an agent in a VM cannot reach GitHub or Claude

The VM reaches the Mac's credentials only through the skiff broker, which needs a running
`skiff tunnel` on the Mac. Run `bb skiff reconcile`; it restarts missing tunnels. If the
problem stays, the Mac is missing a token: `skiff secret set claude-token` or
`skiff secret set github-token`, run by the user on the Mac.

## When NODE_OPTIONS is missing in the agent's shell

bb starts Claude Code through the Claude Agent SDK, which removes `NODE_OPTIONS` from the
environment it passes on. A value set only under `[guest.env]` therefore reaches
`/etc/environment` and the bb daemon, but not the commands the agent runs. The project's
`.skiff` (or `~/.skiff/profile.toml`) must also set it for Claude Code:

```toml
[claude.settings.env]
NODE_OPTIONS = "--max-old-space-size=3072"
```

skiff writes this to `/etc/claude-code/managed-settings.d/50-skiff.json` in the VM. The
change reaches the next VM once the user re-trusts the file on the Mac
(`skiff profile trust <project>/.skiff`). `DEBUG` is dropped the same way; other
`[guest.env]` values reach the agent's shell.

## What not to do

Never run `skiff rm` or `skiff gc` yourself on a VM a thread is using; remove the thread's
machine through bb instead. VMs without the owner label `bb` belong to the user.
