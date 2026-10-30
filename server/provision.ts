import { installClaude, installGh, installNode } from "./install";
import { VM_SOFTWARE, VM_SOFTWARE_VERSION } from "./software";

/** Single-quotes a script for `sh -c`. */
function quote(script: string): string {
  return `'${script.replaceAll("'", `'\\''`)}'`;
}

/**
 * Where the script works. Exported so tests can point it at a temporary directory; the
 * guest has no Node on PATH until the script installs it, so PATH is set explicitly.
 */
export const SCRIPT_ENVIRONMENT = String.raw`export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
state_dir=/root/.bb-skiff
environment_file=/etc/environment`;

/** Prints the first release number in a command's output, or nothing when the command is missing. */
export const installed = String.raw`installed() { "$@" 2>/dev/null </dev/null | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true; }`;

/** True when $1 is empty (not installed) or an older release than $2. Never true for newer. */
export const behind = String.raw`behind() { [ -z "$1" ] || { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }; }`;

/**
 * The bb daemon runs as root: the VM is the sandbox. IS_SANDBOX lets Claude Code use its
 * bypass-permissions modes, which it refuses for root otherwise. The line joins the broker
 * settings skiff writes to the same file for the VM's grants.
 */
export const SANDBOX_MARKER = "IS_SANDBOX=1";

/**
 * Brings a VM to VM_SOFTWARE before bb enrolls it. Runs inside the VM via
 * `skiff exec NAME -- sh -se`, so nothing travels in argv.
 *
 * The same script provisions a fresh VM and a VM of an earlier, interrupted attempt: each
 * step is skipped when already done and nothing is ever downgraded. Output goes to
 * $state_dir/setup.log; the last lines are printed when the script fails, and the installed
 * versions as JSON when it succeeds.
 */
export function buildProvisionScript(): string {
  return `set -eu
umask 022
${SCRIPT_ENVIRONMENT}
install -d -m 0700 "$state_dir"
log="$state_dir/setup.log"
exec 3>&1
exec >>"$log" 2>&1
trap 'code=$?; if [ "$code" -ne 0 ]; then tail -n 40 "$log" >&3; fi' EXIT
echo "== bb-skiff provision ${VM_SOFTWARE_VERSION}"
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
if ! grep -qx '${SANDBOX_MARKER}' "$environment_file" 2>/dev/null; then
  echo '${SANDBOX_MARKER}' >> "$environment_file"
fi
printf '{"node":"%s","gh":"%s","claude":"%s"}\\n' \\
  "$(installed node --version)" "$(installed gh --version)" "$(installed claude --version)" >&3
`;
}
