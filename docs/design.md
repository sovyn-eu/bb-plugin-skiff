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

## Open items

1. First live run: `skiff prepare` on this Mac fails inside the agent sandbox (hypervisor check),
   so the e2e path is unverified. Run `bb plugin install .` and spawn a thread with
   `--environment-provider skiff-vm-checkout` from a normal shell.
2. Confirm that bb's bootstrap installer finds Node at `/usr/local/bin` and that its daemon runs
   as a detached process (the guest has systemd, so a user unit is likely).
3. Decide on git credentials (broker vs. bb forwarding) and document the outcome.
4. Idle suspension: bb offers coordinated suspension; the plugin implements suspend and resume
   but no idle timer yet.
5. A frontend control for the `vcpus`/`memMiB` inputs; today they come from settings or
   `--machine-inputs`.
