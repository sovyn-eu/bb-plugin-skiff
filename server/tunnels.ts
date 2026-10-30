import { spawn } from "node:child_process";
import { requireVmName } from "./names";
import { skiffBinary, skiffEnvironment } from "./skiff";

export interface TunnelProcess {
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  /** Node reports a failed spawn (ENOENT, EMFILE) as `error` without `exit`. */
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface Tunnels {
  ensure(name: string): void;
  stop(name: string): void;
  stopAll(): void;
  active(): string[];
}

interface Entry {
  process: TunnelProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  delayMs: number;
  startedAt: number;
}

/**
 * Keeps one `skiff tunnel NAME` per live VM so its capability broker (Claude token, GitHub
 * token on the Mac) is reachable inside the VM for as long as the VM lives.
 */
export function createTunnels(options: {
  spawn(name: string): TunnelProcess;
  log(message: string): void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** A tunnel that held this long starts over at the initial delay when it drops. */
  stableAfterMs?: number;
}): Tunnels {
  const initialDelayMs = options.initialDelayMs ?? 5_000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const stableAfterMs = options.stableAfterMs ?? 60_000;
  const entries = new Map<string, Entry>();
  let closed = false;

  function launch(name: string, entry: Entry) {
    entry.timer = null;
    entry.startedAt = Date.now();
    const process = options.spawn(name);
    entry.process = process;
    const gone = (reason: string) => {
      if (entries.get(name) !== entry || entry.process !== process) return;
      entry.process = null;
      if (Date.now() - entry.startedAt >= stableAfterMs) entry.delayMs = initialDelayMs;
      options.log(`tunnel for ${name} ${reason}; restarting in ${entry.delayMs} ms`);
      entry.timer = setTimeout(() => launch(name, entry), entry.delayMs);
      entry.delayMs = Math.min(entry.delayMs * 2, maxDelayMs);
    };
    process.on("exit", (code, signal) => gone(`exited (code ${code}, signal ${signal})`));
    process.on("error", (error) => gone(`failed: ${error.message}`));
  }

  function stop(name: string) {
    const entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    if (entry.timer) clearTimeout(entry.timer);
    entry.process?.kill("SIGTERM");
  }

  return {
    ensure(name) {
      requireVmName(name);
      if (closed || entries.has(name)) return;
      const entry: Entry = { process: null, timer: null, delayMs: initialDelayMs, startedAt: 0 };
      entries.set(name, entry);
      launch(name, entry);
    },
    stop,
    stopAll() {
      closed = true;
      for (const name of [...entries.keys()]) stop(name);
    },
    active: () => [...entries.keys()],
  };
}

export function spawnTunnel(name: string, log: (message: string) => void): TunnelProcess {
  const env = skiffEnvironment();
  const child = spawn(skiffBinary(env), ["tunnel", requireVmName(name)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => log(`tunnel ${name}: ${chunk.toString().trim()}`));
  return child;
}
