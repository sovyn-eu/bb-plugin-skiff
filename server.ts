// bb-plugin-skiff: run each bb thread in a fresh skiff VM on this Mac.
//
// The plugin is a machine provider. For a thread that picks "Skiff VM", core calls
// `create`: the plugin boots a VM with `skiff new`, installs Node, gh and Claude Code,
// hands core an executor over `skiff exec` so core can enroll its own daemon in the VM,
// and keeps `skiff tunnel` open so the VM reaches the Mac's credentials through the
// skiff broker. The composition below pairs the machine with bb's project checkout, so
// core clones the repository into the VM before the agent starts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runCli } from "./server/cli";
import { createSkiffExecutor } from "./server/executor";
import { COMPOSITION_ID, PROVIDER_ID, createSkiffMachineProvider } from "./server/machine";
import { reconcile, sleep } from "./server/reconcile";
import { createRun, createSkiff } from "./server/skiff";
import { errorMessage } from "./server/text";
import { createTunnels, spawnTunnel } from "./server/tunnels";

const RECONCILE_INTERVAL_MS = 5 * 60_000;
const GRANT_LIST = z
  .string()
  .regex(/^([a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*)?$/, "space-separated grant names");

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    vcpus: {
      type: "number",
      label: "vCPUs per VM",
      experimental_schema: z.number().int().min(1).max(32),
      default: 2,
    },
    memMiB: {
      type: "number",
      label: "Memory per VM (MiB)",
      description: "Node, the bb daemon and Claude Code need 2 to 3 GiB.",
      experimental_schema: z.number().int().min(1024).max(131_072),
      default: 3072,
    },
    grants: {
      type: "string",
      label: "skiff grants",
      description:
        "Capabilities every VM gets through the skiff broker, space-separated (see `skiff cap ls`).",
      experimental_schema: GRANT_LIST,
      default: "claude github",
    },
  });
  const values = await settings.get();
  const defaults = () => ({
    vcpus: values.vcpus,
    memMiB: values.memMiB,
    grants: values.grants.split(" ").filter(Boolean),
  });

  const lifetime = new AbortController();
  const log = (message: string) => bb.log.info(message);
  const skiff = createSkiff(createRun(lifetime.signal));
  const tunnels = createTunnels({ spawn: (name) => spawnTunnel(name, log), log });

  bb.experimental_machines.register(
    createSkiffMachineProvider({
      skiff,
      tunnels,
      bootstrap: (request) => bb.experimental_machines.bootstrap(request),
      executorFor: (name) => createSkiffExecutor(name),
      defaults,
      log,
    }),
  );
  bb.experimental_environments.register({
    id: COMPOSITION_ID,
    displayName: "Skiff VM",
    description: "A fresh Linux VM on this Mac with a checkout of the project.",
    icon: "Server",
    machineProviderId: PROVIDER_ID,
    environmentProviderId: "project-checkout",
  });

  const reconcileNow = () =>
    reconcile({
      listHosts: () => bb.sdk.hosts.list({ includeCreating: true }),
      getResource: (hostId) => bb.experimental_machines.getResource(hostId),
      skiff,
      tunnels,
      log,
    });

  bb.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await reconcileNow();
        } catch (error) {
          bb.log.warn(`reconcile failed: ${errorMessage(error)}`);
        }
        await sleep(RECONCILE_INTERVAL_MS, signal);
      }
    },
  });

  bb.cli.register({
    name: "skiff",
    summary: "Inspect the skiff VMs this plugin runs threads in",
    commands: [
      { name: "vms", summary: "List VMs owned by bb", usage: "bb skiff vms [--json]" },
      {
        name: "reconcile",
        summary: "Reopen broker tunnels and collect forgotten VMs now",
        usage: "bb skiff reconcile [--json]",
      },
    ],
    run: (argv) => runCli(argv, { skiff, reconcile: reconcileNow }),
  });

  bb.onDispose(() => {
    tunnels.stopAll();
    lifetime.abort();
  });
}
