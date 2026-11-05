import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKIFF_CWD,
  createRun,
  createSkiff,
  skiffBinary,
  skiffEnvironment,
  supportedSkiffVersion,
  type Run,
} from "./skiff";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A stand-in skiff that prints its working directory. */
function pwdSkiff(): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-skiff-run-"));
  folders.push(folder);
  const binary = join(folder, "skiff");
  writeFileSync(binary, "#!/bin/sh\npwd\n");
  chmodSync(binary, 0o755);
  return binary;
}

const vm = {
  name: "bb-0123456789ab",
  index: 2,
  ip: "192.168.64.3",
  state: "running",
  vcpus: 2,
  mem_mib: 3072,
  forwards: [],
  grants: ["claude", "github"],
  owner: "bb",
  slot: "",
  created_at: "2026-10-30T09:00:00Z",
};

function recorder(responses: Record<string, string>) {
  const calls: { args: string[]; stdin?: string; timeoutMs?: number }[] = [];
  const run: Run = async (args, options) => {
    calls.push({ args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }), ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    const key = args[0] ?? "";
    if (!(key in responses)) throw new Error(`unexpected command ${key}`);
    return responses[key] ?? "";
  };
  return { calls, run };
}

describe("skiff CLI wrapper", () => {
  it("lists VMs from JSON and finds one by name", async () => {
    const { run, calls } = recorder({ ls: JSON.stringify([vm]) });
    const skiff = createSkiff(run);
    expect(await skiff.list()).toEqual([
      { name: vm.name, state: "running", ip: "192.168.64.3", owner: "bb", slot: "" },
    ]);
    expect(await skiff.find(vm.name)).toMatchObject({ name: vm.name });
    expect(await skiff.find("bb-missing")).toBeNull();
    expect(calls[0]?.args).toEqual(["ls", "--json"]);
  });

  it("creates an owned VM from its profiles, in order, without trusting any of them", async () => {
    const { run, calls } = recorder({ new: "bb-0123456789ab is running\n" });
    await createSkiff(run).create({
      name: vm.name,
      vcpus: 2,
      memMiB: 3072,
      profiles: ["/tmp/bb/vm-abc.toml", "/Users/me/dev/shop/.skiff"],
    });
    expect(calls[0]?.args).toEqual([
      "new", vm.name, "--owner", "bb", "--vcpus", "2", "--mem", "3072",
      "--profile", "/tmp/bb/vm-abc.toml", "--profile", "/Users/me/dev/shop/.skiff",
    ]);
    expect(calls[0]?.timeoutMs).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("leaves the size to the profiles unless the launch sets it", async () => {
    const { run, calls } = recorder({ new: "" });
    await createSkiff(run).create({ name: vm.name, memMiB: 8192, profiles: ["/tmp/bb/vm-abc.toml"] });
    expect(calls[0]?.args).toEqual(["new", vm.name, "--owner", "bb", "--mem", "8192", "--profile", "/tmp/bb/vm-abc.toml"]);
  });

  it("applies the profiles with their setup to a VM of an earlier attempt", async () => {
    const { run, calls } = recorder({ apply: "" });
    await createSkiff(run).apply(vm.name, ["/tmp/bb/vm-abc.toml"]);
    expect(calls[0]?.args).toEqual(["apply", vm.name, "--setup", "--profile", "/tmp/bb/vm-abc.toml"]);
    expect(calls[0]?.timeoutMs).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("trusts one profile file by itself", async () => {
    const { run, calls } = recorder({ profile: "" });
    await createSkiff(run).trustProfile("/tmp/bb/vm-abc.toml");
    expect(calls[0]?.args).toEqual(["profile", "trust", "/tmp/bb/vm-abc.toml"]);
  });

  it("checks the version, then the profile merged with the machine default", async () => {
    const { run, calls } = recorder({ "--version": "skiff version v0.6.0\n", profile: "# sources: /tmp/bb/vm-abc.toml\n" });
    await createSkiff(run).checkProfile(["/tmp/bb/vm-abc.toml"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["profile", "show", "--profile", "/tmp/bb/vm-abc.toml"],
    ]);
  });

  it("asks for skiff 0.6.0 when it is older or has no --version", async () => {
    const old = recorder({ "--version": "skiff version v0.5.1\n" });
    await expect(createSkiff(old.run).checkProfile(["/tmp/bb/vm-abc.toml"])).rejects.toThrow(
      "skiff 0.6.0 or newer is needed, this is skiff version v0.5.1",
    );
    const ancient = recorder({});
    await expect(createSkiff(ancient.run).checkProfile(["/tmp/bb/vm-abc.toml"])).rejects.toThrow(/older than 0\.5\.1/);
  });

  it("compares versions numerically and lets development builds pass", () => {
    expect(supportedSkiffVersion("skiff version v0.6.0")).toBe(true);
    expect(supportedSkiffVersion("skiff version v0.10.0")).toBe(true);
    expect(supportedSkiffVersion("skiff version v1.0.0")).toBe(true);
    expect(supportedSkiffVersion("skiff version v0.6.1-0.20261105120000-abcdef123456+dirty")).toBe(true);
    expect(supportedSkiffVersion("skiff version v0.5.9")).toBe(false);
    expect(supportedSkiffVersion("skiff version dev")).toBe(true);
    expect(supportedSkiffVersion("garbage")).toBe(false);
  });

  it("refuses relative or missing profile paths, which skiff would resolve against its own working directory", async () => {
    const { run, calls } = recorder({ new: "" });
    const skiff = createSkiff(run);
    await expect(skiff.create({ name: vm.name, vcpus: 2, memMiB: 2048, profiles: ["vm.toml"] })).rejects.toThrow(/absolute/);
    await expect(skiff.create({ name: vm.name, vcpus: 2, memMiB: 2048, profiles: [] })).rejects.toThrow(/at least one/);
    expect(calls).toEqual([]);
  });

  it("starts, stops, removes and collects owned VMs", async () => {
    const { run, calls } = recorder({ start: "", stop: "", rm: "", gc: "{}" });
    const skiff = createSkiff(run);
    await skiff.start(vm.name);
    await skiff.stop(vm.name);
    await skiff.remove(vm.name);
    await skiff.gc([vm.name, "bb-other"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["start", vm.name],
      ["stop", vm.name],
      ["rm", vm.name],
      ["gc", "--owner", "bb", "--older-than", "5m", "--keep", vm.name, "--keep", "bb-other", "--json"],
    ]);
  });

  it("rejects malformed CLI output", async () => {
    const { run } = recorder({ ls: "not json" });
    await expect(createSkiff(run).list()).rejects.toThrow(/skiff ls returned/);
  });

  it("refuses names that are not VM names before running anything", async () => {
    const { run, calls } = recorder({});
    await expect(createSkiff(run).remove("--all")).rejects.toThrow(/Invalid VM name/);
    expect(calls).toEqual([]);
  });

  it("runs skiff from a fixed directory so ./.skiff never resolves to ~/.skiff", async () => {
    const run = createRun(new AbortController().signal, { ...process.env, SKIFF_BIN: pwdSkiff() });
    expect((await run(["new"])).trim()).toBe(SKIFF_CWD);
  });

  it("finds skiff next to Go, Homebrew and /usr/local binaries, or where SKIFF_BIN points", () => {
    const env = skiffEnvironment({ PATH: "/usr/bin" });
    expect(env.PATH?.split(":")).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]));
    expect(env.PATH?.split(":")[0]).toMatch(/\/go\/bin$/);
    expect(skiffBinary({})).toBe("skiff");
    expect(skiffBinary({ SKIFF_BIN: " /tmp/skiff " })).toBe("/tmp/skiff");
  });
});
