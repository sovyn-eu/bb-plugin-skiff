import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { VM_OWNER } from "./names";
import type { ReconcileResult } from "./reconcile";
import type { Skiff, Vm } from "./skiff";
import { errorMessage } from "./text";

export const USAGE = [
  "Usage:",
  "  bb skiff vms [--json]        VMs this plugin owns, as skiff sees them",
  "  bb skiff reconcile [--json]  Reopen broker tunnels and collect forgotten VMs now",
].join("\n");

export interface CliDeps {
  skiff: Skiff;
  reconcile(): Promise<ReconcileResult>;
}

function formatVm(vm: Vm): string {
  return `${vm.name.padEnd(16)} ${vm.state.padEnd(9)} ${vm.ip}`;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<PluginCliResult> {
  const json = argv.includes("--json");
  const [command] = argv.filter((arg) => arg !== "--json");
  const reply = (value: unknown, text: string): PluginCliResult => ({
    exitCode: 0,
    stdout: json ? JSON.stringify(value) : text,
  });
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
        return { exitCode: 0, stdout: USAGE };
      case "vms": {
        const vms = (await deps.skiff.list()).filter((vm) => vm.owner === VM_OWNER);
        return reply(vms, vms.length === 0 ? "No VMs owned by bb." : vms.map(formatVm).join("\n"));
      }
      case "reconcile": {
        const result = await deps.reconcile();
        return reply(
          result,
          `tracked: ${result.tracked.join(", ") || "none"}\ntunnels: ${result.tunnels.join(", ") || "none"}`,
        );
      }
      default:
        return { exitCode: 1, stderr: USAGE };
    }
  } catch (error) {
    return { exitCode: 1, stderr: errorMessage(error) };
  }
}
