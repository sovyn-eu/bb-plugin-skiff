import { describe, expect, it } from "vitest";
import { USAGE, runCli } from "./cli";
import { fakeSkiff } from "./fakes";

const deps = () => {
  const skiff = fakeSkiff([
    { name: "bb-one", state: "running", ip: "192.168.64.5", owner: "bb", slot: "" },
    { name: "mine", state: "running", ip: "192.168.64.6", owner: "", slot: "" },
  ]);
  return { skiff: skiff.skiff, reconcile: async () => ({ tracked: ["bb-one"], tunnels: ["bb-one"] }) };
};

describe("bb skiff CLI", () => {
  it("prints usage without a command and for unknown commands", async () => {
    expect(await runCli([], deps())).toEqual({ exitCode: 0, stdout: USAGE });
    expect(await runCli(["nope"], deps())).toEqual({ exitCode: 1, stderr: USAGE });
  });

  it("lists only VMs owned by bb", async () => {
    const result = await runCli(["vms", "--json"], deps());
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual([
      { name: "bb-one", state: "running", ip: "192.168.64.5", owner: "bb", slot: "" },
    ]);
    expect((await runCli(["vms"], deps())).stdout).toContain("bb-one");
  });

  it("runs reconcile on request", async () => {
    const result = await runCli(["reconcile"], deps());
    expect(result).toEqual({ exitCode: 0, stdout: "tracked: bb-one\ntunnels: bb-one" });
  });

  it("turns errors into exit code 1", async () => {
    const d = deps();
    const result = await runCli(["reconcile"], { ...d, reconcile: async () => { throw new Error("boom"); } });
    expect(result).toEqual({ exitCode: 1, stderr: "boom" });
  });
});
