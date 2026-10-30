import { spawn } from "node:child_process";
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";
import { requireVmName } from "./names";
import { skiffBinary, skiffEnvironment } from "./skiff";

/** skiff mirrors the remote exit status; 255 is its own "connection failed". */
const CONNECTION_FAILED = 255;
const KILL_GRACE_MS = 5_000;

export interface ExecutorOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs bb's enrollment commands inside a VM through `skiff exec NAME -- argv`.
 * stdin carries the private bootstrap bundle and never appears in argv; stdout and
 * stderr stream into bb's progress log.
 */
export function createSkiffExecutor(name: string, options: ExecutorOptions = {}): MachineExecutor {
  requireVmName(name);
  const env = options.env ?? skiffEnvironment();
  const binary = options.binary ?? skiffBinary(env);
  return {
    exec(request) {
      return runExec(binary, env, ["exec", name, "--", ...request.command], request);
    },
  };
}

function runExec(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  request: MachineExecutorRequest,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted"));
      return;
    }
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`skiff exec timed out after ${request.timeoutMs} ms`)));
      terminate();
    }, request.timeoutMs);
    const onAbort = () => {
      finish(() => reject(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted")));
      terminate();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    function finish(outcome: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      request.signal.removeEventListener("abort", onAbort);
      outcome();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => request.onOutput(chunk));
    child.stderr.on("data", (chunk: string) => request.onOutput(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ exitCode: code ?? CONNECTION_FAILED })));
    child.stdin.on("error", () => {}); // an early exit is reported through `close`
    child.stdin.end(request.stdin);
  });
}
