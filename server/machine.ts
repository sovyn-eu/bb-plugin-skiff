import type {
  MachineBootstrapApi,
  MachineExecutor,
  PluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { vmNameForKey } from "./names";
import { buildProvisionScript } from "./provision";
import type { Skiff } from "./skiff";
import { cleanText, errorMessage } from "./text";
import type { Tunnels } from "./tunnels";

export const PROVIDER_ID = "skiff-vm";
export const COMPOSITION_ID = "skiff-vm-checkout";

const MINUTE = 60_000;
/** Downloads Node, gh and Claude Code on a fresh guest; generous for a slow connection. */
const PROVISION_TIMEOUT_MS = 20 * MINUTE;

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

export interface MachineProviderDeps {
  skiff: Skiff;
  tunnels: Tunnels;
  bootstrap: MachineBootstrapApi["bootstrap"];
  executorFor(name: string): MachineExecutor;
  defaults(): VmDefaults;
  log(message: string): void;
}

export function createSkiffMachineProvider(
  deps: MachineProviderDeps,
): PluginMachineProviderDeclaration<typeof machineInputsSchema> {
  const { skiff, tunnels, log } = deps;

  async function ensureVm(name: string, inputs: MachineInputs, report: { step(text: string): void }) {
    const existing = await skiff.find(name);
    if (existing === null) {
      const defaults = deps.defaults();
      report.step(`Booting skiff VM ${name}`);
      await skiff.create({
        name,
        vcpus: inputs.vcpus ?? defaults.vcpus,
        memMiB: inputs.memMiB ?? defaults.memMiB,
        grants: defaults.grants,
      });
      return;
    }
    if (existing.state === "stopped") {
      report.step(`Starting skiff VM ${name} from an earlier attempt`);
      await skiff.start(name);
      return;
    }
    report.step(`Reusing skiff VM ${name} from an earlier attempt`);
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
        return { status: "available" };
      } catch (error) {
        return {
          status: "setup-required",
          message: `skiff is not ready: ${cleanText(errorMessage(error), 300)}. Install skiff and run \`skiff prepare\`.`,
        };
      }
    },

    async create({ inputs, key, checkpoint, report, signal }) {
      const name = vmNameForKey(key);
      try {
        await ensureVm(name, inputs, report);
        signal.throwIfAborted();
        await checkpoint({ vm: name } satisfies MachineResource);

        report.step("Installing Node, GitHub CLI and Claude Code");
        const versions = await skiff.exec(name, ["sh", "-se"], {
          stdin: buildProvisionScript(),
          timeoutMs: PROVISION_TIMEOUT_MS,
          signal,
        });
        report.log(`installed: ${cleanText(versions.trim(), 300)}`);
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
