import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkiffExecutor } from "./executor";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A stand-in for `skiff exec NAME -- argv`: drops the three leading words and runs argv locally. */
function fakeSkiff(): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-skiff-executor-"));
  folders.push(folder);
  const binary = join(folder, "skiff");
  writeFileSync(binary, '#!/bin/sh\n[ "$1" = exec ] || exit 64\nshift 3\nexec "$@"\n');
  chmodSync(binary, 0o755);
  return binary;
}

function request(command: string[], extra: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const output: string[] = [];
  return {
    output,
    request: {
      command,
      stdin: extra.stdin ?? "",
      timeoutMs: extra.timeoutMs ?? 5_000,
      signal: extra.signal ?? new AbortController().signal,
      onOutput: (chunk: string) => output.push(chunk),
    },
  };
}

describe("skiff executor", () => {
  it("passes argv through, feeds stdin and streams output", async () => {
    const executor = createSkiffExecutor("bb-test", { binary: fakeSkiff(), env: process.env });
    const { output, request: req } = request(["sh", "-c", "cat; echo err >&2; exit 3"], { stdin: "hello" });
    const result = await executor.exec(req);
    expect(result.exitCode).toBe(3);
    expect(output.join("")).toContain("hello");
    expect(output.join("")).toContain("err");
  });

  it("kills the command when the timeout passes", async () => {
    const executor = createSkiffExecutor("bb-test", { binary: fakeSkiff(), env: process.env });
    const { request: req } = request(["sleep", "30"], { timeoutMs: 200 });
    await expect(executor.exec(req)).rejects.toThrow(/timed out/);
  });

  it("kills the command when the signal aborts", async () => {
    const executor = createSkiffExecutor("bb-test", { binary: fakeSkiff(), env: process.env });
    const controller = new AbortController();
    const { request: req } = request(["sleep", "30"], { signal: controller.signal });
    const pending = executor.exec(req);
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(pending).rejects.toThrow(/stop/);
  });

  it("rejects a missing binary instead of hanging", async () => {
    const executor = createSkiffExecutor("bb-test", { binary: "/nonexistent/skiff", env: process.env });
    const { request: req } = request(["true"]);
    await expect(executor.exec(req)).rejects.toThrow(/ENOENT/);
  });

  it("refuses VM names that are not VM names", () => {
    expect(() => createSkiffExecutor("--all")).toThrow(/Invalid VM name/);
  });
});
