# bb-plugin-skiff

bb plugin that runs each thread in a fresh [skiff](https://github.com/sovyn-eu/skiff) VM on
your Mac. The agent, its shell, `npm install`, git and the bb daemon all run inside the VM. The
Mac keeps the bb server and the credentials, which reach the VM only through the skiff broker.

Modelled after paseo-skiff, a skiff integration for Paseo, with bb's own machine
provider API in place of Paseo's manual host registration. The design is in
[docs/design.md](docs/design.md).

## How it works

The plugin registers a **machine provider** (`skiff-vm`) and an **environment composition**
(`skiff-vm-checkout`) that pairs it with bb's project checkout. Picking **Skiff VM** for a thread:

1. The plugin writes its skiff profile (`server/profile.ts`), trusts that file alone with
   `skiff profile trust <file>`, records the VM name with bb, then
   `skiff new bb-<key> --owner bb --profile <file> [--profile <project>/.skiff]` boots a plain Ubuntu 24.04 VM in a
   couple of seconds and applies the profile: its setup installs Node, the GitHub CLI and
   Claude Code (pinned in `server/software.ts`, archives checked against the publishers'
   SHA-256 sums), its grants (`claude github` by default) are granted, and `IS_SANDBOX=1`
   goes into `/etc/environment` so Claude Code accepts its bypass modes as root. The VM name
   derives from bb's launch key, so a retried launch finds the VM of the earlier attempt and
   brings it up to date with `skiff apply bb-<key> --setup` and the same profiles.
2. skiff merges, in this order: your machine default `~/.skiff/profile.toml`, the plugin's
   profile and the project's `.skiff`. Skills, packages, agent tools, Claude Code plugins, MCP
   servers and settings declared in either file reach the VM; setups run in that order, so a
   project's setup can use Node and gh. The `.skiff` is the one in the project folder on this
   Mac (the folder from "Add project"); the plugin finds it through the thread the VM is
   launched for. A `.skiff` in the bb server's working directory is never read.
3. bb's own bootstrap enrolls the bb daemon in the VM over the `skiff exec` transport and
   waits until it connects to the server.
4. `skiff tunnel bb-<key>` stays open for the VM's life so the broker is reachable inside it.
5. core clones the project into the VM and starts the agent. When the thread is archived, core
   asks the plugin to remove the machine: the tunnel closes and `skiff rm` deletes the VM.

Suspend and resume map to `skiff stop` and `skiff start`. Every five minutes, and on
`bb skiff reconcile`, the plugin reopens missing tunnels and runs `skiff gc --owner bb` with every
VM bb still tracks on the keep list, so a VM lost between `skiff new` and the checkpoint is
collected. VMs you create by hand have no owner and are never touched.

## Requirements

- bb 0.48 or newer with a **server access** the VM can reach. A skiff VM cannot reach the Mac
  directly (its firewall rejects private networks), so use bb Connect, or a direct server URL
  that is reachable from the internet.
- skiff 0.6.0 or newer (profiles, repeatable `--profile`, `allow_grants`), prepared once:
  `go install github.com/sovyn-eu/skiff/cmd/skiff@latest && skiff prepare`
  (Apple Silicon, macOS 26, Apple's `container` CLI). With an older skiff, Skiff VM reports
  setup required.
- Tokens for the broker, once: `skiff secret set claude-token` and `skiff secret set github-token`.
  Every VM gets the `github` grant, so the token alone decides which repositories a VM can
  reach: use a fine-grained token limited to the repositories agents should work on.
- `bb settings general machineGitCredentialsEnabled false`, so bb does not forward the server's own
  gh login into VMs; the broker already serves git and gh. While the setting is on, Skiff VM reports
  setup required and refuses to boot a VM, so no real token reaches the guest.

Set `SKIFF_BIN` in the bb server's environment if `skiff` is not in `~/go/bin`,
`/opt/homebrew/bin` or `/usr/local/bin`.

## Install

```sh
bb plugin install git:https://github.com/sovyn-eu/bb-plugin-skiff.git@^0.1.0
```

Then pick **Skiff VM** in the composer's environment picker, or from a shell. The project needs a
Git remote the VM can clone, since the checkout happens inside the VM:

```sh
bb thread spawn --project <id> --new-machine skiff-vm --environment-provider project-checkout --prompt "..."
bb thread spawn ... --machine-inputs '{"vcpus":4,"memMiB":4096}'
```

Settings (Settings → Installed plugins → Skiff VM): vCPUs and memory per VM and the grants every
VM gets. Changes apply to the next launch.

Everything else a VM gets (packages, tools, skills, Claude Code plugins and settings, MCP
servers, a setup script) goes into `~/.skiff/profile.toml` on this Mac; `skiff profile init
--global` writes a commented skeleton. skiff merges, a later file winning: that file, the
plugin's profile (Node, gh, Claude Code, the size and grants from the settings), the project's
`.skiff`. So a project can ask for more memory than the settings give, and only
`--machine-inputs` of a single launch beats all of them. Grants are joined across the files.

Cap them in `~/.skiff/profile.toml`:

```toml
allow_grants = ["claude", "github"]   # include every grant of the Skiff VM settings
```

skiff then refuses any profile file that asks for more, the plugin's included, whoever trusted
it. That matters because bb's plugin settings are not as well guarded as that file: see
[docs/design.md](docs/design.md#who-can-change-what-a-vm-gets).
`skiff profile show --vm bb-<key>` prints what a VM was built from.

### A project's `.skiff`

A `.skiff` in the project folder can grant capabilities and runs its setup as root in the VM,
so skiff uses it only after you trusted it as it is now; the plugin never does that for you.
Until then a launch fails and names the file. Read it and trust it on the Mac:

```sh
skiff profile show --render --profile ~/dev/shop/.skiff
skiff profile trust ~/dev/shop/.skiff
```

After every change to the file, trust it again. An agent that edits `.skiff` therefore cannot
widen the next VM: its change reaches a VM only once it is in the folder on the Mac and you
trusted it. The file is read from the Mac's checkout, not from the branch the thread works on.

## Development

```sh
npm install
npm run typecheck
npm test          # unit tests, no VM needed; the provision script runs against stub tools
bb plugin build
```

Layout: `server.ts` wires settings, the machine provider, the composition, the reconcile service
and the `bb skiff` CLI. `server/skiff.ts` wraps the skiff CLI, `server/executor.ts` is the
`MachineExecutor` over `skiff exec`, `server/machine.ts` the provider, `server/profile.ts` the
skiff profile, `server/provision.ts` and `server/install.ts` its setup script, `server/tunnels.ts` the tunnel supervisor and
`server/reconcile.ts` the periodic sweep. `skills/skiff/SKILL.md` tells agents what `bb skiff` does.

## License

Apache-2.0. Copyright 2026 IT-Labs GmbH.
