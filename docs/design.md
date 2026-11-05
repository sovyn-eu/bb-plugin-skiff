# bb-plugin-skiff: design notes

Status: first cut, 2026-10-30. Verified against bb 0.48 (plugin SDK 0.6.104), skiff main
after v0.1.0 and paseo-skiff as of 2026-10-27.

## Goal

Run every bb thread that asks for it in a fresh skiff VM on the Mac, the way paseo-skiff does
for Paseo: agent, shell, package installs, git and the daemon live in the VM; the Mac keeps the
server, the UI and the credentials.

## Why bb fits better than Paseo

paseo-skiff needed three workarounds because Paseo offers plugins no way to register a host:
a fixed pool of three slots, a one-time manual host registration per slot, and a daemon
identity seeded into every recreated VM so the app accepts it.

bb has the "daemon per machine" model built in:

| bb API | Role here |
| --- | --- |
| `bb.experimental_machines.register` | the skiff machine provider (`ephemeral: true`) |
| `bb.experimental_machines.bootstrap({ executor })` | installs and enrolls bb's daemon in the VM over `skiff exec` |
| `bb.experimental_environments.register({ machineProviderId, environmentProviderId })` | the picker entry "Skiff VM" that pairs the machine with `project-checkout` |
| `bb.experimental_machines.getResource(hostId)` | lets the reconcile sweep map hosts back to VM names |

The bundled Modal Sandbox plugin uses the same shape. So: no slot pool, no manual host step,
no identity seeding. One VM per launch, named `bb-<sha256(key)[:12]>`, so a retried create and
`reconcileCleanup` find it without a journal of our own.

## Direction of the connection

Paseo desktop opens `ssh -W` *into* the VM. The bb daemon in the VM connects *out* to the bb
server. That matches skiff's guest firewall, which rejects VM-to-Mac traffic: the VM only needs
the server URL from bb's server access provider. bb Connect works out of the box because the
VM has internet; a loopback-only server does not. A local alternative would be a second
`ssh -R` tunnel to the server port, in the style of the broker, plus a direct server URL. Not
built yet.

## Credentials

skiff's broker serves `claude` and `github` through placeholder tokens; the real tokens stay in
the Keychain, and `skiff tunnel` must run on the Mac for the broker to answer. The plugin keeps
one tunnel per live VM (ported from paseo-skiff's supervisor) and reopens them on every sweep.

bb also forwards the server's gh login to non-primary hosts by default. That would place a real
token in the VM next to the broker's placeholders. bb offers no per-machine switch, only the global
`machineGitCredentialsEnabled` setting, so the provider reads it through `bb.sdk.system.config()`:
while it is on, `availability()` reports setup required and `create()` fails before `skiff new`.
If the setting cannot be read, `create()` fails too. The broker alone serves git and gh.

## Provisioning

skiff has no golden images. Boot is two seconds; installing Node, gh and Claude Code plus bb's
own daemon takes minutes per VM, as it does in paseo-skiff. The installers are the same pinned,
checksummed scripts.

Since skiff 0.4.0 they travel as a skiff profile (`server/profile.ts`): `grants`, the
installers as `[guest] setup` and `IS_SANDBOX=1` under `[guest.env]`, so Claude Code accepts its
bypass-permissions modes as root. The plugin writes the file under a content-derived name in a
private temporary directory and trusts it with `skiff profile trust <file>`: it wrote the file
itself, and the name keeps skiff's trust record valid until the content changes. It does not
pass `--trust` to `new`, which would trust every file given, the project's `.skiff` included. Before, the plugin piped its own script into `skiff exec sh -se` after `skiff new
--grant`. The profile route has three advantages:

- skiff runs the setup over plain ssh while it holds the VM's broker claim and agent lock, so
  no credential is reachable while code downloaded from the internet runs as root.
- The machine default `~/.skiff/profile.toml` is merged in, so the user's skills, packages,
  agent plugins and MCP servers reach bb's VMs without plugin settings for each of them.
- `skiff profile show --vm <name>` says what a VM was built from.

Three consequences shaped the code:

- The setup now runs inside `skiff new`, which may take longer than the five minutes after which
  the reconcile sweep's `skiff gc --older-than 5m` collects VMs bb does not track. `create`
  therefore checkpoints the VM name before `skiff new`; `remove` already copes with a VM that
  never came to be.
- A grant given as `--grant` to `skiff new` is applied only after the setup, so it would be lost
  when the setup fails. The grants live in the profile instead, and `skiff apply --setup` with
  the same file brings a VM of an interrupted attempt up to date. The setup skips what is
  already installed and never downgrades.
- The plugin calls `skiff new` without `--json`; nothing used its result, and skiff 0.4.0
  mixed the setup's output into the JSON (fixed in 0.5.0).

## Size in the profile

Size moved from flags into the plugin's profile, so a `.skiff` merged after it can raise it;
only a launch's own `--machine-inputs` stay flags, which beat every file.

## Who can change what a VM gets

A short-lived version had a multi-line setting with a bb-only skiff profile. It was dropped
after reading bb's server (bb 0.48): requests made with a machine credential
(`x-bb-gate-auth: machine`) are refused for host management, machine environment variables,
enroll keys, CLI commands, app and server updates, but not for `PUT /api/v1/plugins/:id/settings`,
plugin enable and disable, or the general settings. A skiff VM behind bb Connect holds such a
credential in its daemon's configuration, and the agent runs as root. Whether the Connect gate
filters these paths was not tested. If it does not, an agent could change this plugin's settings,
and the plugin trusts the profile it writes from them.

So the settings hold only what `allow_grants` can cap, the size and the grants, and everything
else lives in `~/.skiff/profile.toml`, which nothing inside a VM can write. skiff 0.6.0 checks
`allow_grants` for every `--profile` file before trust, so grants added to the settings behind
the user's back are refused unless the user allowed them. The plugin requires 0.6.0 and points
to `allow_grants` in the grants setting. The real fix is in bb: refuse machine credentials on
those routes as it does for host management.

## A project's .skiff

skiff 0.5.0 takes `--profile` more than once and checks trust per file, so a VM gets the
machine default, the plugin's profile and the project's `.skiff`, merged in that order.

A machine provider is not told the project, but bb uses the thread id as the launch key of a
thread's machine (`hosts.launch_key` joins `threads.id` in bb's server). The plugin resolves
`threads.get(key)` → `projects.get(projectId).sources` → the first folder, default first, whose
`.skiff` exists on this Mac. A key that is no thread (`404 thread_not_found`, as for
`bb machine create`) means no `.skiff`; any other lookup failure fails the launch, since a VM
silently built without the project's profile would look fine and lack what it needs. That the
key is the thread id is bb's implementation, not a documented contract: if it changes, the
lookup finds no thread and the VM is built as before.

The plugin never trusts a `.skiff`. skiff refuses an untrusted one before booting, with what it
would do, and the plugin adds the `skiff profile trust <path>` to run. Because the path is the
folder on the Mac, the trust the user records there is exactly the trust skiff checks; an agent
that changes `.skiff` in the VM cannot widen the next VM.

A warm pool or a skiff guest image with the software baked in is the obvious next step.

## First live run (2026-10-30)

`bb machine create --provider skiff-vm` on an M-series Mac with bb Connect as server access:

| step | time |
| --- | --- |
| `skiff new` to running VM | 4 s |
| provision (Node, gh, Claude Code) plus bb bootstrap | 49 s |
| machine `active`, daemon `connected` | 53 s total |

bb's bootstrap found Node in `/usr/local/bin` and enrolled its daemon without changes.
`bb machine provider-cli status` reported Claude Code 2.1.301 at `/root/.local/bin/claude`.
The skiff audit log showed `tunnel=open` and Claude Code's first `HEAD /claude/api/hello`
answered through the broker. `bb machine remove` deleted the VM and the tunnel; `skiff gc`
had nothing left to collect. A thread spawn through `skiff-vm-checkout` followed: the project
cloned into the VM and the agent ran its turns there.

## Open items

1. Idle suspension: bb offers coordinated suspension; the plugin implements suspend and resume
   but no idle timer yet.
2. A frontend control for the `vcpus`/`memMiB` inputs; today they come from settings or
   `--machine-inputs`.
