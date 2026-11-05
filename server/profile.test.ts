import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_ENV, buildProfile, writeProfile } from "./profile";
import { buildSetupScript } from "./provision";

const SIZE = { vcpus: 2, memMiB: 3072 };
const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "bb-skiff-profile-"));
  folders.push(path);
  return path;
}

describe("VM profile", () => {
  it("grants the configured capabilities, runs the setup script and marks the VM as a sandbox", () => {
    const profile = buildProfile({ ...SIZE, grants: ["claude", "github"] });
    expect(profile).toContain('grants = ["claude", "github"]\n');
    expect(profile).toContain(`[guest]\nsetup = '''\n${buildSetupScript()}'''\n`);
    expect(profile).toContain(`[guest.env]\n${SANDBOX_ENV.name} = "${SANDBOX_ENV.value}"\n`);
  });

  it("sizes the VM in [machine], so a project's .skiff merged after it can ask for more", () => {
    expect(buildProfile({ vcpus: 4, memMiB: 8192, grants: [] })).toContain("[machine]\nvcpus = 4\nmem = 8192\n");
  });

  it("refuses a size that is not a positive whole number", () => {
    expect(() => buildProfile({ vcpus: 0, memMiB: 3072, grants: [] })).toThrow(/vcpus/);
    expect(() => buildProfile({ vcpus: 2, memMiB: 1.5, grants: [] })).toThrow(/memory/);
  });

  it("writes an empty grant list as an empty array", () => {
    expect(buildProfile({ ...SIZE, grants: [] })).toContain("grants = []\n");
  });

  it("refuses grants that are not plain capability names", () => {
    expect(() => buildProfile({ ...SIZE, grants: ["github:acme/shop"] })).toThrow(/Invalid grant/);
    expect(() => buildProfile({ ...SIZE, grants: ['claude", "evil'] })).toThrow(/Invalid grant/);
  });

  it("refuses a setup script that would end the TOML string or read as a skiff template", () => {
    expect(() => buildProfile({ ...SIZE, grants: [] }, "echo '''")).toThrow(/'''/);
    expect(() => buildProfile({ ...SIZE, grants: [] }, "echo {{ .VM }}")).toThrow(/\{\{/);
  });

  it("writes the profile under a name derived from its content, readable only by the owner", async () => {
    const dir = join(folder(), "profiles");
    const first = await writeProfile(dir, { ...SIZE, grants: ["claude"] });
    expect(await writeProfile(dir, { ...SIZE, grants: ["claude"] })).toBe(first);
    const second = await writeProfile(dir, { ...SIZE, grants: ["claude", "github"] });
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe(buildProfile({ ...SIZE, grants: ["claude"] }));
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
