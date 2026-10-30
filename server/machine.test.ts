import { describe, expect, it } from "vitest";
import { fakeReport, fakeSkiff, fakeTunnels, noopExecutor } from "./fakes";
import { PROVIDER_ID, createSkiffMachineProvider, machineInputsSchema } from "./machine";
import { vmNameForKey } from "./names";

const KEY = "launch-key-1";
const NAME = vmNameForKey(KEY);
const DEFAULTS = { vcpus: 2, memMiB: 3072, grants: ["claude", "github"] };

function harness(
  options: { skiff?: ReturnType<typeof fakeSkiff>; bootstrapFails?: boolean; gitCredentialsForwarded?: () => Promise<boolean> } = {},
) {
  const skiff = options.skiff ?? fakeSkiff();
  const tunnels = fakeTunnels();
  const bootstraps: string[] = [];
  const logs: string[] = [];
  const provider = createSkiffMachineProvider({
    skiff: skiff.skiff,
    tunnels: tunnels.tunnels,
    async bootstrap({ key }) {
      bootstraps.push(key);
      if (options.bootstrapFails) throw new Error("enrollment timed out");
      return { hostId: "host_abc" };
    },
    executorFor: () => noopExecutor,
    defaults: () => DEFAULTS,
    gitCredentialsForwarded: options.gitCredentialsForwarded ?? (async () => false),
    log: (message) => logs.push(message),
  });
  return { provider, skiff, tunnels, bootstraps, logs };
}

function createContext(overrides: { inputs?: { vcpus?: number; memMiB?: number }; signal?: AbortSignal } = {}) {
  const checkpoints: unknown[] = [];
  const { report, lines } = fakeReport();
  return {
    checkpoints,
    lines,
    context: {
      inputs: overrides.inputs ?? {},
      key: KEY,
      attempt: 1,
      async checkpoint(resource: unknown) {
        checkpoints.push(resource);
      },
      report,
      signal: overrides.signal ?? new AbortController().signal,
    },
  };
}

describe("skiff machine provider", () => {
  it("accepts empty inputs and refuses out-of-range ones", () => {
    expect(machineInputsSchema.parse({})).toEqual({});
    expect(machineInputsSchema.safeParse({ memMiB: 512 }).success).toBe(false);
  });

  it("boots a VM, checkpoints it, provisions it, enrolls bb and opens the broker tunnel", async () => {
    const h = harness();
    const { context, checkpoints, lines } = createContext({ inputs: { vcpus: 4 } });
    const result = await h.provider.create(context);
    expect(result).toEqual({ status: "created", name: `skiff ${NAME}`, resource: { vm: NAME } });
    expect(h.skiff.calls).toEqual([
      ["find", NAME],
      ["new", NAME, "4", "3072", "claude", "github"],
      ["exec", NAME, "sh", "-se", "set -eu\numask 022\nex"],
    ]);
    expect(checkpoints).toEqual([{ vm: NAME }]);
    expect(h.bootstraps).toEqual([KEY]);
    expect(h.tunnels.events).toEqual([`ensure ${NAME}`]);
    expect(lines).toContain(`step: Booting skiff VM ${NAME}`);
    expect(lines).toContain("step: Enrolling the bb daemon");
  });

  it("reuses the VM of an earlier attempt instead of creating a second one", async () => {
    const skiff = fakeSkiff([{ name: NAME, state: "stopped", ip: "", owner: "bb", slot: "" }]);
    const h = harness({ skiff });
    const result = await h.provider.create(createContext().context);
    expect(result.status).toBe("created");
    expect(h.skiff.calls.map((call) => call[0])).toEqual(["find", "start", "exec"]);
  });

  it("reports a failed bootstrap instead of throwing and leaves the VM for reconcileCleanup", async () => {
    const h = harness({ bootstrapFails: true });
    const result = await h.provider.create(createContext().context);
    expect(result).toEqual({ status: "failed", message: "enrollment timed out" });
    expect(h.tunnels.events).toEqual([]);
    expect(h.skiff.vms.has(NAME)).toBe(true);
  });

  it("propagates cancellation so core treats it as cancelled, not failed", async () => {
    const controller = new AbortController();
    const h = harness();
    h.skiff.failures.set("exec", new Error("interrupted"));
    const { context } = createContext({ signal: controller.signal });
    controller.abort(new Error("cancelled by user"));
    await expect(h.provider.create(context)).rejects.toThrow(/cancelled by user/);
  });

  it("removes the VM and its tunnel, and tolerates a VM that is already gone", async () => {
    const h = harness();
    await h.provider.create(createContext().context);
    const removeContext = { hostId: "host_abc", resource: { vm: NAME }, report: fakeReport().report, signal: new AbortController().signal };
    expect(await h.provider.remove(removeContext)).toEqual({ status: "removed" });
    expect(h.tunnels.events.at(-1)).toBe(`stop ${NAME}`);
    expect(h.skiff.vms.has(NAME)).toBe(false);
    expect(await h.provider.remove(removeContext)).toEqual({ status: "removed" });
    expect(h.skiff.calls.filter((call) => call[0] === "rm")).toHaveLength(1);
  });

  it("cleans up by key when no checkpoint was recorded", async () => {
    const skiff = fakeSkiff([{ name: NAME, state: "running", ip: "", owner: "bb", slot: "" }]);
    const h = harness({ skiff });
    const result = await h.provider.reconcileCleanup({ key: KEY, report: fakeReport().report, signal: new AbortController().signal });
    expect(result).toEqual({ status: "removed" });
    expect(h.skiff.vms.size).toBe(0);
  });

  it("reports removal failures", async () => {
    const skiff = fakeSkiff([{ name: NAME, state: "running", ip: "", owner: "bb", slot: "" }]);
    skiff.failures.set("rm", new Error("container busy"));
    const h = harness({ skiff });
    const result = await h.provider.remove({ hostId: "h", resource: { vm: NAME }, report: fakeReport().report, signal: new AbortController().signal });
    expect(result).toEqual({ status: "failed", message: "container busy" });
  });

  it("suspends by stopping the VM and resumes by starting it, with the tunnel following", async () => {
    const h = harness();
    await h.provider.create(createContext().context);
    const lifecycle = { hostId: "host_abc", resource: { vm: NAME }, checkpoint: async () => {}, report: fakeReport().report, signal: new AbortController().signal };
    expect(await h.provider.suspend?.(lifecycle)).toEqual({ resource: { vm: NAME } });
    expect(h.skiff.vms.get(NAME)?.state).toBe("stopped");
    expect(h.tunnels.tunnels.active()).toEqual([]);
    expect(await h.provider.suspend?.(lifecycle)).toEqual({ resource: { vm: NAME } });
    expect(h.skiff.calls.filter((call) => call[0] === "stop")).toHaveLength(1);
    expect(await h.provider.resume?.(lifecycle)).toEqual({ resource: { vm: NAME } });
    expect(h.skiff.vms.get(NAME)?.state).toBe("running");
    expect(h.tunnels.tunnels.active()).toEqual([NAME]);
  });

  it("refuses to resume a VM skiff no longer has", async () => {
    const h = harness();
    const lifecycle = { hostId: "h", resource: { vm: NAME }, checkpoint: async () => {}, report: fakeReport().report, signal: new AbortController().signal };
    await expect(h.provider.resume?.(lifecycle)).rejects.toThrow(/no longer exists/);
  });

  it("is available when skiff answers and asks for setup when it does not", async () => {
    const h = harness();
    expect(await h.provider.availability?.()).toEqual({ status: "available" });
    h.skiff.failures.set("ls", new Error("skiff ls failed: host is not ready"));
    expect(await h.provider.availability?.()).toMatchObject({ status: "setup-required", message: expect.stringContaining("skiff prepare") });
    expect(h.provider.id).toBe(PROVIDER_ID);
    expect(h.provider.ephemeral).toBe(true);
  });

  it("asks for setup while bb forwards its own GitHub credentials into machines", async () => {
    const h = harness({ gitCredentialsForwarded: async () => true });
    expect(await h.provider.availability?.()).toMatchObject({
      status: "setup-required",
      message: expect.stringContaining("bb settings general machineGitCredentialsEnabled false"),
    });
  });

  it("refuses to boot a VM while bb forwards its own GitHub credentials into machines", async () => {
    const h = harness({ gitCredentialsForwarded: async () => true });
    const result = await h.provider.create(createContext().context);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("machineGitCredentialsEnabled") });
    expect(h.skiff.calls).toEqual([]);
    expect(h.bootstraps).toEqual([]);
  });

  it("refuses to boot a VM when the credential setting cannot be read", async () => {
    const h = harness({
      gitCredentialsForwarded: async () => {
        throw new Error("config unavailable");
      },
    });
    const result = await h.provider.create(createContext().context);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("config unavailable") });
    expect(h.skiff.calls).toEqual([]);
    expect(await h.provider.availability?.()).toMatchObject({ status: "unavailable", message: expect.stringContaining("config unavailable") });
  });
});
