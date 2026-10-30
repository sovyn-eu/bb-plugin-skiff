import { describe, expect, it } from "vitest";
import { VM_NAME, requireVmName, vmNameForKey } from "./names";

describe("VM names", () => {
  it("derives a stable skiff-compatible name from a launch key", () => {
    const name = vmNameForKey("machine-launch-01HZX");
    expect(name).toBe(vmNameForKey("machine-launch-01HZX"));
    expect(name).toMatch(VM_NAME);
    expect(name.startsWith("bb-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it("gives different keys different names", () => {
    expect(vmNameForKey("a")).not.toBe(vmNameForKey("b"));
  });

  it("refuses an empty key", () => {
    expect(() => vmNameForKey("  ")).toThrow(/must not be empty/);
  });

  it("refuses names that could be mistaken for flags or paths", () => {
    expect(() => requireVmName("--all")).toThrow(/Invalid VM name/);
    expect(() => requireVmName("../x")).toThrow(/Invalid VM name/);
    expect(requireVmName("bb-abc123")).toBe("bb-abc123");
  });
});
