import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

async function load() {
  const host = createFakePluginHost({
    pluginId: "skiff",
    sdk: { hosts: { list: async () => [] } },
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

describe("plugin factory", () => {
  it("registers the machine provider, the composition and the CLI", async () => {
    const { harness } = await load();
    const { machineProviders, environmentCompositions, cli, services } = harness.registrations;
    expect([...machineProviders.keys()]).toEqual(["skiff-vm"]);
    expect([...environmentCompositions.keys()]).toEqual(["skiff-vm-checkout"]);
    expect(cli?.name).toBe("skiff");
    expect(services.map((service) => service.name)).toEqual(["reconcile"]);
  });

  it("answers the CLI usage without touching skiff", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bb skiff vms");
  });

  it("rejects grants that are not plain capability names", async () => {
    const { harness } = await load();
    await expect(harness.behavior.setSettings({ grants: "github;rm -rf" })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ grants: "claude github" })).resolves.not.toThrow();
  });
});
