import { describe, expect, it } from "vitest";
import { type ProjectLookup, findRepoProfile, isThreadNotFound } from "./repo-profile";

const source = (path: string, isDefault = false) => ({ hostId: "host_mac", path, isDefault, type: "local_path" as const });

function lookup(options: {
  thread?: { projectId: string } | Error;
  sources?: ReturnType<typeof source>[];
  files?: string[];
}): ProjectLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async threadProject(threadId) {
      calls.push(`thread ${threadId}`);
      if (options.thread instanceof Error) throw options.thread;
      return options.thread?.projectId ?? null;
    },
    async projectSources(projectId) {
      calls.push(`project ${projectId}`);
      return options.sources ?? [];
    },
    async isFile(path) {
      return (options.files ?? []).includes(path);
    },
  };
}

describe("repository profile lookup", () => {
  it("finds the .skiff in the project folder on this Mac, from the thread the VM is launched for", async () => {
    const deps = lookup({
      thread: { projectId: "proj_1" },
      sources: [source("/Users/me/dev/shop", true)],
      files: ["/Users/me/dev/shop/.skiff"],
    });
    expect(await findRepoProfile(deps, "thr_abc")).toBe("/Users/me/dev/shop/.skiff");
    expect(deps.calls).toEqual(["thread thr_abc", "project proj_1"]);
  });

  it("prefers the default source when several folders have one", async () => {
    const deps = lookup({
      thread: { projectId: "proj_1" },
      sources: [source("/Users/me/old/shop"), source("/Users/me/dev/shop", true)],
      files: ["/Users/me/old/shop/.skiff", "/Users/me/dev/shop/.skiff"],
    });
    expect(await findRepoProfile(deps, "thr_abc")).toBe("/Users/me/dev/shop/.skiff");
  });

  it("skips folders that are not on this Mac or have no .skiff", async () => {
    const deps = lookup({
      thread: { projectId: "proj_1" },
      sources: [source("/home/other/shop", true), source("/Users/me/dev/shop")],
      files: ["/Users/me/dev/shop/.skiff"],
    });
    expect(await findRepoProfile(deps, "thr_abc")).toBe("/Users/me/dev/shop/.skiff");
  });

  it("returns null when the project has no .skiff", async () => {
    const deps = lookup({ thread: { projectId: "proj_1" }, sources: [source("/Users/me/dev/shop", true)] });
    expect(await findRepoProfile(deps, "thr_abc")).toBeNull();
  });

  it("returns null when the launch key is not a thread, as for `bb machine create`", async () => {
    expect(await findRepoProfile(lookup({}), "launch-123")).toBeNull();
  });

  it("fails instead of booting without the project's profile when bb cannot answer", async () => {
    await expect(findRepoProfile(lookup({ thread: new Error("server unavailable") }), "thr_abc")).rejects.toThrow(
      /server unavailable/,
    );
  });

  it("ignores relative source paths", async () => {
    const deps = lookup({ thread: { projectId: "proj_1" }, sources: [source("shop", true)], files: ["shop/.skiff"] });
    expect(await findRepoProfile(deps, "thr_abc")).toBeNull();
  });
});

describe("thread-not-found detection", () => {
  it("recognises bb's 404 by status, code or message and nothing else", () => {
    expect(isThreadNotFound(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(isThreadNotFound({ code: "thread_not_found" })).toBe(true);
    expect(isThreadNotFound(new Error("Thread not found"))).toBe(true);
    expect(isThreadNotFound(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isThreadNotFound(new Error("Project not found"))).toBe(false);
    expect(isThreadNotFound("Thread not found")).toBe(false);
    expect(isThreadNotFound(null)).toBe(false);
  });
});
