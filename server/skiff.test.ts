import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKIFF_CWD, createRun, createSkiff, skiffBinary, skiffEnvironment, type Run } from "./skiff";

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

  it("creates an owned VM with grants", async () => {
    const { run, calls } = recorder({ new: JSON.stringify(vm) });
    const created = await createSkiff(run).create({
      name: vm.name,
      vcpus: 2,
      memMiB: 3072,
      grants: ["claude", "github"],
    });
    expect(created.name).toBe(vm.name);
    expect(calls[0]?.args).toEqual([
      "new", vm.name, "--owner", "bb", "--vcpus", "2", "--mem", "3072",
      "--grant", "claude", "--grant", "github", "--json",
    ]);
  });

  it("refuses grants that are not plain capability names", async () => {
    const { run, calls } = recorder({ new: JSON.stringify(vm) });
    await expect(
      createSkiff(run).create({ name: vm.name, vcpus: 2, memMiB: 2048, grants: ["github:acme/shop"] }),
    ).rejects.toThrow(/Invalid grant/);
    expect(calls).toEqual([]);
  });

  it("runs commands with exact argv and stdin", async () => {
    const { run, calls } = recorder({ exec: "ready\n" });
    const output = await createSkiff(run).exec(vm.name, ["sh", "-se"], { stdin: "echo hi", timeoutMs: 1000 });
    expect(output).toBe("ready\n");
    expect(calls[0]).toEqual({ args: ["exec", vm.name, "--", "sh", "-se"], stdin: "echo hi", timeoutMs: 1000 });
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
