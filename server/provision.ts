import { installClaude, installGh, installNode } from "./install";
import { VM_SOFTWARE, VM_SOFTWARE_VERSION } from "./software";

/** Single-quotes a script for `sh -c`. */
function quote(script: string): string {
  return `'${script.replaceAll("'", `'\\''`)}'`;
}

/**
 * The guest has no Node on PATH until the script installs it, so PATH is set explicitly.
 * Exported so tests can point it at stub tools.
 */
export const SCRIPT_ENVIRONMENT = String.raw`export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`;

/** Prints the first release number in a command's output, or nothing when the command is missing. */
export const installed = String.raw`installed() { "$@" 2>/dev/null </dev/null | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true; }`;

/** True when $1 is empty (not installed) or an older release than $2. Never true for newer. */
export const behind = String.raw`behind() { [ -z "$1" ] || { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }; }`;

/**
 * Brings a VM to VM_SOFTWARE before bb enrolls it. It is the `[guest] setup` of the plugin's
 * skiff profile (see ./profile.ts): skiff runs it as root over ssh, after the packages, tools
 * and setup of the machine default ~/.skiff/profile.toml and before any grant.
 *
 * `skiff new` runs it on a fresh VM and `skiff apply --setup` on a VM of an earlier,
 * interrupted attempt: each step is skipped when already done and nothing is ever downgraded,
 * so a newer Claude Code from the machine default's `tools = ["claude"]` stays.
 */
export function buildSetupScript(): string {
  return `set -eu
umask 022
${SCRIPT_ENVIRONMENT}
echo "== bb-skiff setup ${VM_SOFTWARE_VERSION}"
export DEBIAN_FRONTEND=noninteractive
${installed}
${behind}
if behind "$(installed node --version)" ${VM_SOFTWARE.node}; then
  sh -c ${quote(installNode)} </dev/null
fi
if behind "$(installed gh --version)" ${VM_SOFTWARE.gh}; then
  sh -c ${quote(installGh)} </dev/null
fi
if behind "$(installed claude --version)" ${VM_SOFTWARE.claude}; then
  sh -c ${quote(installClaude)} </dev/null
fi
printf 'bb-skiff installed node %s, gh %s, claude %s\\n' \\
  "$(installed node --version)" "$(installed gh --version)" "$(installed claude --version)"
`;
}
