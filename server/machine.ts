import type {
  MachineBootstrapApi,
  MachineExecutor,
  PluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { vmNameForKey } from "./names";
import type { Skiff } from "./skiff";
import { cleanText, errorMessage } from "./text";
import type { Tunnels } from "./tunnels";

export const PROVIDER_ID = "skiff-vm";
export const COMPOSITION_ID = "skiff-vm-checkout";

const SKIFF_INSTALL_DOCS = "https://github.com/sovyn-eu/skiff#install";
const SKIFF_UPDATE = "brew upgrade sovyn-eu/tap/skiff";

/**
 * bb forwards the server's gh login into every machine unless this setting is off. In a skiff VM
 * that would put a real token next to the broker's placeholders, so the provider refuses to run.
 */
const GIT_CREDENTIALS_MESSAGE =
  "bb forwards its own GitHub login into machines, which would put a real token inside the VM. " +
  "The skiff broker already serves git and gh: run `bb settings general machineGitCredentialsEnabled false`.";

/** Optional per-launch overrides; `{}` is valid, so no frontend control is needed. */
export const machineInputsSchema = z.object({
  vcpus: z.number().int().min(1).max(32).optional(),
  memMiB: z.number().int().min(1024).max(131_072).optional(),
});
export type MachineInputs = z.infer<typeof machineInputsSchema>;

/** What core persists for a host. Readable by every plugin, so never a credential. */
export const resourceSchema = z.object({ vm: z.string() });
export type MachineResource = z.infer<typeof resourceSchema>;

export interface VmDefaults {
  vcpus: number;
  memMiB: number;
  grants: readonly string[];
}

type Report = { step(text: string): void; log(text: string): void };

export interface MachineProviderDeps {
  skiff: Skiff;
  tunnels: Tunnels;
  bootstrap: MachineBootstrapApi["bootstrap"];
  executorFor(name: string): MachineExecutor;
  defaults(): VmDefaults;
  /** Writes the skiff profile for the current settings and returns its absolute path. */
  profileFile(): Promise<string>;
  /** The project's .skiff on this Mac for a launch key, or null (see ./repo-profile.ts). */
  repoProfile(key: string): Promise<string | null>;
  /** Whether bb's `machineGitCredentialsEnabled` setting is on. */
  gitCredentialsForwarded(): Promise<boolean>;
  log(message: string): void;
}

export function createSkiffMachineProvider(
  deps: MachineProviderDeps,
): PluginMachineProviderDeclaration<typeof machineInputsSchema> {
  const { skiff, tunnels, log } = deps;

  /**
   * The profiles a VM is built from, in merge order after the machine default: the plugin's,
   * whose setup installs Node, gh and Claude Code, then the project's .skiff. The plugin trusts
   * only its own file; skiff refuses a .skiff the user has not trusted. `allow_grants` in
   * ~/.skiff/profile.toml caps the grants of both, the plugin's included: settings that were
   * changed behind the user's back cannot grant more than that.
   */
  async function profilesFor(key: string, report: Report): Promise<{ profiles: string[]; repo: string | null; own: string }> {
    const own = await deps.profileFile();
    const repo = await deps.repoProfile(key);
    await skiff.trustProfile(own);
    if (repo === null) return { profiles: [own], repo, own };
    report.log(`using the project's profile ${repo}`);
    return { profiles: [own, repo], repo, own };
  }

  /**
   * skiff's refusals suggest --grant, --trust and --no-profile, which bb users cannot pass;
   * name the fix that applies in bb.
   */
  function explainRefusal(message: string, own: string, repo: string | null): string {
    if (message.includes(own) && /does not allow/.test(message)) {
      return `${message}\nThe Skiff VM settings grant these: add them to allow_grants in ~/.skiff/profile.toml, or remove them from the settings.`;
    }
    if (repo === null || !/not trusted/.test(message)) return message;
    return `${message}\nRead it, then trust it on the Mac: skiff profile show --render --profile ${repo} && skiff profile trust ${repo}`;
  }

  /**
   * Boots the VM from the profiles, or brings the VM of an earlier attempt up to them again:
   * that attempt may have stopped mid-setup.
   */
  async function ensureVm(name: string, key: string, inputs: MachineInputs, report: Report, signal: AbortSignal) {
    const { profiles, repo, own } = await profilesFor(key, report);
    try {
      await bootOrApply(name, profiles, inputs, report, signal);
    } catch (error) {
      throw new Error(explainRefusal(errorMessage(error), own, repo), { cause: error });
    }
  }

  async function bootOrApply(
    name: string,
    profiles: readonly string[],
    inputs: MachineInputs,
    report: Report,
    signal: AbortSignal,
  ) {
    const existing = await skiff.find(name);
    if (existing === null) {
      report.step(`Booting skiff VM ${name} and installing Node, GitHub CLI and Claude Code`);
      // The settings' size is in the plugin's profile, where a project's .skiff can raise it.
      await skiff.create({ name, vcpus: inputs.vcpus, memMiB: inputs.memMiB, profiles }, { signal });
      return;
    }
    if (existing.state === "stopped") {
      report.step(`Starting skiff VM ${name} from an earlier attempt`);
      await skiff.start(name);
    } else {
      report.step(`Reusing skiff VM ${name} from an earlier attempt`);
    }
    report.step(`Applying the profile to ${name}`);
    await skiff.apply(name, profiles, { signal });
  }

  async function removeVm(name: string): Promise<void> {
    tunnels.stop(name);
    if ((await skiff.find(name)) === null) return;
    await skiff.remove(name);
  }

  return {
    id: PROVIDER_ID,
    displayName: "Skiff VM",
    description: "A fresh Linux VM on this Mac, booted by skiff in seconds and removed with the thread.",
    icon: "Server",
    ephemeral: true,
    inputs: machineInputsSchema,

    async availability() {
      try {
        await skiff.list();
      } catch (error) {
        return {
          status: "setup-required",
          message: `skiff is not ready: ${cleanText(errorMessage(error), 300)}. Install skiff (${SKIFF_INSTALL_DOCS}) and run \`skiff prepare\`.`,
        };
      }
      try {
        await skiff.checkProfile([await deps.profileFile()]);
      } catch (error) {
        return {
          status: "setup-required",
          message:
            `skiff cannot read the VM profile: ${cleanText(errorMessage(error), 300)}. ` +
            `It needs skiff 0.6.0 or newer (\`${SKIFF_UPDATE}\`, or see ${SKIFF_INSTALL_DOCS}) and a valid ~/.skiff/profile.toml (\`skiff profile lint\`).`,
        };
      }
      try {
        if (await deps.gitCredentialsForwarded()) {
          return { status: "setup-required", message: GIT_CREDENTIALS_MESSAGE };
        }
      } catch (error) {
        return { status: "unavailable", message: `Cannot read bb's settings: ${cleanText(errorMessage(error), 300)}` };
      }
      return { status: "available" };
    },

    async create({ inputs, key, checkpoint, report, signal }) {
      const name = vmNameForKey(key);
      try {
        if (await deps.gitCredentialsForwarded()) {
          return { status: "failed", message: GIT_CREDENTIALS_MESSAGE };
        }
        // Before the VM exists: the setup inside `skiff new` can take longer than the five
        // minutes after which the reconcile sweep's `skiff gc` collects VMs bb does not track.
        // remove() copes with a checkpointed VM that never came to be.
        await checkpoint({ vm: name } satisfies MachineResource);
        await ensureVm(name, key, inputs, report, signal);
        signal.throwIfAborted();

        report.step("Enrolling the bb daemon");
        const { hostId } = await deps.bootstrap({ key, executor: deps.executorFor(name), report, signal });
        tunnels.ensure(name);
        log(`VM ${name} enrolled as ${hostId}`);
        return { status: "created", name: `skiff ${name}`, resource: { vm: name } };
      } catch (error) {
        signal.throwIfAborted();
        log(`create ${name} failed: ${errorMessage(error)}`);
        return { status: "failed", message: cleanText(errorMessage(error), 2000) };
      }
    },

    async reconcileCleanup({ key }) {
      const name = vmNameForKey(key);
      try {
        await removeVm(name);
        return { status: "removed" };
      } catch (error) {
        return { status: "failed", message: cleanText(errorMessage(error), 2000) };
      }
    },

    async remove({ resource }) {
      const { vm } = resourceSchema.parse(resource);
      try {
        await removeVm(vm);
        return { status: "removed" };
      } catch (error) {
        return { status: "failed", message: cleanText(errorMessage(error), 2000) };
      }
    },

    async suspend({ resource }) {
      const { vm } = resourceSchema.parse(resource);
      tunnels.stop(vm);
      const existing = await skiff.find(vm);
      if (existing === null) throw new Error(`skiff VM ${vm} no longer exists`);
      if (existing.state !== "stopped") await skiff.stop(vm);
      return { resource: { vm } };
    },

    async resume({ resource }) {
      const { vm } = resourceSchema.parse(resource);
      const existing = await skiff.find(vm);
      if (existing === null) throw new Error(`skiff VM ${vm} no longer exists`);
      if (existing.state !== "running") await skiff.start(vm);
      tunnels.ensure(vm);
      return { resource: { vm } };
    },
  };
}
