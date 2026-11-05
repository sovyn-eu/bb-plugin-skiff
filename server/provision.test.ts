import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKSUMS } from "./install";
import { SCRIPT_ENVIRONMENT, buildSetupScript } from "./provision";
import { VM_SOFTWARE } from "./software";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Installed = Partial<Record<"node" | "claude" | "gh", string>>;

/**
 * Runs the real script with stub tools on PATH: the `sh -c` installers are recorded instead
 * of executed, so the decisions (what to install) are exercised exactly as in the VM.
 */
function run(installed: Installed, options: { installersFail?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "bb-skiff-provision-"));
  folders.push(folder);
  const bin = join(folder, "bin");
  const log = join(folder, "steps.log");
  mkdirSync(bin);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const version = (value: string | undefined, output: string) =>
    value === undefined ? "exit 127" : `echo "${output}"`;
  tool("claude", version(installed.claude, `${installed.claude} (Claude Code)`));
  tool("gh", version(installed.gh, `gh version ${installed.gh} (2026-01-01)`));
  tool(
    "sh",
    `case "$2" in
    *nodejs.org/dist*) echo "install node" ;;
    *claude.ai/install.sh*) echo "install claude" ;;
    *cli/cli/releases*) echo "install gh" ;;
    *) echo "install unknown" ;;
  esac >> "${log}"
${options.installersFail ? 'echo "download failed" >&2; exit 1' : ""}`,
  );
  if (installed.node === undefined) tool("node", "exit 127");
  else symlinkSync(process.execPath, join(bin, "node"));
  const script = buildSetupScript().replace(SCRIPT_ENVIRONMENT, `export PATH="${bin}:/usr/bin:/bin"`);
  expect(script).not.toBe(buildSetupScript());
  const result = spawnSync("sh", ["-se"], { input: script, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  let steps: string[] = [];
  try {
    steps = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {}
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    steps,
  };
}

describe("setup script", () => {
  it("is valid shell and never reads the script itself from stdin", () => {
    const script = buildSetupScript();
    expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
    expect(script.match(/^  sh -c '/gm)).toHaveLength(3);
    expect(script.match(/' <\/dev\/null$/gm)).toHaveLength(3);
  });

  it("has checksums for every pinned archive", () => {
    expect(CHECKSUMS.node[VM_SOFTWARE.node]).toMatchObject({ arm64: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(CHECKSUMS.gh[VM_SOFTWARE.gh]).toMatchObject({ arm64: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("installs everything on a fresh VM and prints the versions", () => {
    const result = run({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.steps).toEqual(["install node", "install gh", "install claude"]);
    expect(result.stdout).toContain("bb-skiff installed node , gh , claude \n");
  });

  it("skips what is current, upgrades what is behind and never downgrades", () => {
    const result = run({ node: process.versions.node, gh: "1.0.0", claude: "99.0.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.steps).toEqual(["install gh"]);
  });

  it("stops at the first failed installer with its error on stderr", () => {
    const result = run({}, { installersFail: true });
    expect(result.status).not.toBe(0);
    expect(result.steps).toEqual(["install node"]);
    expect(result.stdout).toContain("bb-skiff setup");
    expect(result.stderr).toContain("download failed");
  });
});
