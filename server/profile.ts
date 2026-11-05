import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSetupScript } from "./provision";

/** skiff's capability names; a scoped grant such as `github:acme/shop` is not a setting. */
const GRANT = /^[a-z][a-z0-9-]*$/;
const HASH_LENGTH = 16;

/**
 * IS_SANDBOX lets Claude Code use its bypass-permissions modes, which it refuses for root
 * otherwise; the bb daemon runs as root because the VM is the sandbox. skiff writes it to
 * /etc/environment next to the broker settings of the VM's grants.
 */
export const SANDBOX_ENV = { name: "IS_SANDBOX", value: "1" } as const;

/** A TOML multi-line literal string: taken verbatim, so the script needs no escaping. */
function literal(text: string): string {
  if (text.includes("'''")) throw new Error("The setup script must not contain ''' (it ends the TOML string)");
  // skiff renders the setup as a Go template; the plugin's script uses none of its fields.
  if (text.includes("{{")) throw new Error("The setup script must not contain {{ (skiff reads it as a template)");
  return `'''\n${text}'''`;
}

/** The plugin settings that go into the profile. */
export interface ProfileSettings {
  vcpus: number;
  memMiB: number;
  grants: readonly string[];
}

function requireCount(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${what}: ${value}`);
  return value;
}

/**
 * The skiff profile every VM this plugin boots gets (skiff 0.6.0 or newer). skiff merges the
 * machine default ~/.skiff/profile.toml, this file and the project's .skiff in that order, a
 * later value winning. So the size set here beats the machine default, and a project's .skiff
 * can ask for more; only a launch's own `--machine-inputs`, passed as flags, beats all three.
 * Grants are joined across the files: a .skiff can add capabilities, never drop these.
 */
export function buildProfile(settings: ProfileSettings, setup: string = buildSetupScript()): string {
  const { grants } = settings;
  for (const grant of grants) {
    if (!GRANT.test(grant)) throw new Error(`Invalid grant: ${grant}`);
  }
  const vcpus = requireCount(settings.vcpus, "vcpus");
  const mem = requireCount(settings.memMiB, "memory");
  return `# Written by bb-plugin-skiff for every VM it boots; regenerated, do not edit.
# skiff merges ~/.skiff/profile.toml into it. See \`skiff profile show --vm <name>\`.
grants = [${grants.map((grant) => `"${grant}"`).join(", ")}]

[machine]
vcpus = ${vcpus}
mem = ${mem}

[guest]
setup = ${literal(setup)}

[guest.env]
${SANDBOX_ENV.name} = "${SANDBOX_ENV.value}"
`;
}

/**
 * Writes the profile into `dir` and returns its absolute path. The name derives from the
 * content, so concurrent launches never see a half-written file and skiff's trust record
 * (path and content) stays valid until the profile changes.
 */
export function writeProfile(dir: string, settings: ProfileSettings): Promise<string> {
  return writeContentAddressed(dir, "vm", buildProfile(settings));
}

async function writeContentAddressed(dir: string, prefix: string, text: string): Promise<string> {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
  const path = join(dir, `${prefix}-${hash}.toml`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const partial = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(partial, text, { mode: 0o600 });
  await rename(partial, path);
  return path;
}
