import { describe, expect, it } from "vitest";
import { fakeReport, fakeSkiff, fakeTunnels, noopExecutor } from "./fakes";
import { PROVIDER_ID, createSkiffMachineProvider, machineInputsSchema } from "./machine";
import { vmNameForKey } from "./names";

const KEY = "launch-key-1";
const NAME = vmNameForKey(KEY);
const DEFAULTS = { vcpus: 2, memMiB: 3072, grants: ["claude", "github"] };
const PROFILE = "/tmp/bb-plugin-skiff/vm-0123.toml";
const REPO_PROFILE = "/Users/me/dev/shop/.skiff";

function harness(
  options: {
    skiff?: ReturnType<typeof fakeSkiff>;
    bootstrapFails?: boolean;
    gitCredentialsForwarded?: () => Promise<boolean>;
    repoProfile?: (key: string) => Promise<string | null>;
  } = {},
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
    profileFile: async () => PROFILE,
    repoProfile: options.repoProfile ?? (async () => null),
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

  it("checkpoints, boots a VM from the profile, enrolls bb and opens the broker tunnel", async () => {
    const h = harness();
    const order: string[] = [];
    const { context, checkpoints, lines } = createContext({ inputs: { vcpus: 4 } });
    const result = await h.provider.create({
      ...context,
      async checkpoint(resource) {
        order.push(`checkpoint after ${h.skiff.calls.length} skiff calls`);
        await context.checkpoint(resource);
      },
    });
    expect(result).toEqual({ status: "created", name: `skiff ${NAME}`, resource: { vm: NAME } });
    expect(h.skiff.calls).toEqual([
      ["trust", PROFILE],
      ["find", NAME],
      ["new", NAME, "4", "-", PROFILE],
    ]);
    // Before `skiff new`: its setup may outlast the five minutes after which gc collects untracked VMs.
    expect(order).toEqual(["checkpoint after 0 skiff calls"]);
    expect(checkpoints).toEqual([{ vm: NAME }]);
    expect(h.bootstraps).toEqual([KEY]);
    expect(h.tunnels.events).toEqual([`ensure ${NAME}`]);
    expect(lines).toContain(`step: Booting skiff VM ${NAME} and installing Node, GitHub CLI and Claude Code`);
    expect(lines).toContain("step: Enrolling the bb daemon");
  });

  it("reuses the VM of an earlier attempt instead of creating a second one", async () => {
    const skiff = fakeSkiff([{ name: NAME, state: "stopped", ip: "", owner: "bb", slot: "" }]);
    const h = harness({ skiff });
    const result = await h.provider.create(createContext().context);
    expect(result.status).toBe("created");
    expect(h.skiff.calls).toEqual([
      ["trust", PROFILE],
      ["find", NAME],
      ["start", NAME],
      ["apply", NAME, PROFILE],
    ]);
  });

  it("adds the project's .skiff after the plugin's profile and leaves its trust to the user", async () => {
    const keys: string[] = [];
    const h = harness({
      repoProfile: async (key) => {
        keys.push(key);
        return REPO_PROFILE;
      },
    });
    const { context, lines } = createContext();
    expect((await h.provider.create(context)).status).toBe("created");
    expect(keys).toEqual([KEY]);
    expect(h.skiff.calls).toEqual([
      ["trust", PROFILE],
      ["find", NAME],
      ["new", NAME, "-", "-", PROFILE, REPO_PROFILE],
    ]);
    expect(lines).toContain(`log: using the project's profile ${REPO_PROFILE}`);
  });

  it("reports an untrusted .skiff with skiff's explanation and does not enroll", async () => {
    const h = harness({ repoProfile: async () => REPO_PROFILE });
    h.skiff.failures.set("new", new Error(`skiff new failed: profile is not trusted: ${REPO_PROFILE} (it grants azure-devops); run 'skiff profile trust'`));
    const result = await h.provider.create(createContext().context);
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining(`trust it on the Mac: skiff profile show --render --profile ${REPO_PROFILE} && skiff profile trust ${REPO_PROFILE}`),
    });
    expect(h.bootstraps).toEqual([]);
  });

  it("says how to fix grants of the settings that allow_grants refuses", async () => {
    const h = harness();
    h.skiff.failures.set(
      "new",
      new Error(`skiff new failed: profile ${PROFILE} asks for grants github, which ~/.skiff/profile.toml does not allow (allow_grants = claude)`),
    );
    const result = await h.provider.create(createContext().context);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("add them to allow_grants in ~/.skiff/profile.toml") });
  });

  it("fails rather than boot without the project's profile when the lookup fails", async () => {
    const h = harness({
      repoProfile: async () => {
        throw new Error("bb server unavailable");
      },
    });
    const result = await h.provider.create(createContext().context);
    expect(result).toEqual({ status: "failed", message: "bb server unavailable" });
    expect(h.skiff.calls.filter((call) => call[0] === "new")).toEqual([]);
  });

  it("brings a running VM of an earlier attempt up to the profile again", async () => {
    const skiff = fakeSkiff([{ name: NAME, state: "running", ip: "", owner: "bb", slot: "" }]);
    const h = harness({ skiff });
    expect((await h.provider.create(createContext().context)).status).toBe("created");
    expect(h.skiff.calls.map((call) => call[0])).toEqual(["trust", "find", "apply"]);
  });

  it("reports a failed setup and leaves the VM for reconcileCleanup", async () => {
    const h = harness();
    h.skiff.failures.set("new", new Error("skiff new failed: setup of bb-x failed: exit status 1"));
    const result = await h.provider.create(createContext().context);
    expect(result).toEqual({ status: "failed", message: "skiff new failed: setup of bb-x failed: exit status 1" });
    expect(h.bootstraps).toEqual([]);
    expect(h.tunnels.events).toEqual([]);
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
    h.skiff.failures.set("new", new Error("interrupted"));
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

  it("asks for a newer skiff when it cannot read the plugin's profile", async () => {
    const h = harness();
    h.skiff.failures.set("check", new Error("skiff 0.6.0 or newer is needed, this is skiff v0.5.0"));
    expect(await h.provider.availability?.()).toMatchObject({
      status: "setup-required",
      message: expect.stringContaining("skiff 0.6.0 or newer"),
    });
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
