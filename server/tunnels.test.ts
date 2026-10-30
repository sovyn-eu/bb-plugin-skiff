import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnels, type TunnelProcess } from "./tunnels";

class FakeProcess extends EventEmitter implements TunnelProcess {
  killed: string | null = null;
  kill(signal: NodeJS.Signals) {
    this.killed = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tunnels", () => {
  it("starts one tunnel per VM, restarts it with backoff when it exits, and stops it on request", () => {
    vi.useFakeTimers();
    const spawned: { name: string; process: FakeProcess }[] = [];
    const tunnels = createTunnels({
      spawn(name) {
        const process = new FakeProcess();
        spawned.push({ name, process });
        return process;
      },
      log: () => {},
      initialDelayMs: 1000,
      maxDelayMs: 4000,
    });
    tunnels.ensure("bb-one");
    tunnels.ensure("bb-one");
    expect(spawned.map((entry) => entry.name)).toEqual(["bb-one"]);
    spawned[0]?.process.emit("exit", 255, null);
    vi.advanceTimersByTime(999);
    expect(spawned).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spawned).toHaveLength(2);
    spawned[1]?.process.emit("exit", 255, null);
    vi.advanceTimersByTime(2000);
    expect(spawned).toHaveLength(3);
    tunnels.stop("bb-one");
    expect(spawned[2]?.process.killed).toBe("SIGTERM");
    vi.advanceTimersByTime(10_000);
    expect(spawned).toHaveLength(3);
    expect(tunnels.active()).toEqual([]);
  });

  it("treats a failed spawn like an exit", () => {
    vi.useFakeTimers();
    const processes: FakeProcess[] = [];
    const tunnels = createTunnels({
      spawn() {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      },
      log: () => {},
      initialDelayMs: 500,
    });
    tunnels.ensure("bb-one");
    processes[0]?.emit("error", new Error("ENOENT"));
    vi.advanceTimersByTime(500);
    expect(processes).toHaveLength(2);
  });

  it("stops every tunnel at shutdown and accepts no new ones", () => {
    const processes: FakeProcess[] = [];
    const tunnels = createTunnels({
      spawn() {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      },
      log: () => {},
    });
    tunnels.ensure("bb-one");
    tunnels.ensure("bb-two");
    tunnels.stopAll();
    tunnels.ensure("bb-three");
    expect(processes.map((process) => process.killed)).toEqual(["SIGTERM", "SIGTERM"]);
    expect(tunnels.active()).toEqual([]);
  });

  it("refuses names that are not VM names", () => {
    const tunnels = createTunnels({ spawn: () => new FakeProcess(), log: () => {} });
    expect(() => tunnels.ensure("../x")).toThrow(/Invalid VM name/);
  });
});
