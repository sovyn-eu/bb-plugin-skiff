Run every thread in its own Linux VM on your Mac. Nothing the agent installs or runs
touches macOS, and the VM disappears with the thread.

## What you get

- A **Skiff VM** entry in the environment picker: a fresh Ubuntu VM with a checkout of the
  project, booted by skiff in seconds and enrolled as a bb machine.
- Credentials that stay on the Mac. Claude Code and git in the VM talk to the skiff broker,
  which swaps placeholder tokens for the real ones from the macOS Keychain.
- Suspend and resume through bb, and a `bb skiff` command to inspect the VMs.

## How it works

The plugin is a bb machine provider on top of the skiff CLI: `skiff new` boots the VM, a
provision script installs Node, the GitHub CLI and Claude Code, bb enrolls its daemon over
`skiff exec`, and `skiff tunnel` keeps the broker reachable. Archiving the thread removes the VM.

## Requirements

Apple Silicon, macOS 26, skiff prepared once, and a bb server access the VM can reach, such as
bb Connect.
