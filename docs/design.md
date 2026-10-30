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

bb also forwards the server's gh login to non-primary hosts by default. That would place a token
in the VM; `bb settings general machineGitCredentialsEnabled false` turns it off, and the broker
already covers git and gh. Whether `GH_TOKEN` from bb and the broker's `/etc/gitconfig` rewrite
interfere is unverified until the first live run.

## Provisioning

skiff has no golden images. Boot is two seconds; installing Node, gh and Claude Code plus bb's
own daemon takes minutes per VM, as it does in paseo-skiff. The installers are the same pinned,
checksummed scripts. `IS_SANDBOX=1` goes into `/etc/environment` so Claude Code accepts its
bypass-permissions modes as root. A warm pool or a skiff guest image with the software baked in
is the obvious next step once the flow works end to end.

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
had nothing left to collect. A thread spawn through the composition is not yet exercised.

## Open items

1. Spawn a thread through `skiff-vm-checkout` and watch the project clone and the first agent
   turn inside the VM.
2. Decide on git credentials: `bb machine env list` shows the built-in GH_TOKEN row as
   "logged in", so bb forwards the server's gh token into VMs alongside the broker's
   `/etc/gitconfig` rewrite. Turn one of them off and document the outcome.
3. Idle suspension: bb offers coordinated suspension; the plugin implements suspend and resume
   but no idle timer yet.
4. A frontend control for the `vcpus`/`memMiB` inputs; today they come from settings or
   `--machine-inputs`.
