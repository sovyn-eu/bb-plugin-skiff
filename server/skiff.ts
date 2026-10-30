import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { VM_OWNER, requireVmName } from "./names";
import { cleanText } from "./text";

const GRANT = /^[a-z][a-z0-9-]*$/;
/** A VM a concurrent create just made is not in the keep list yet; gc leaves VMs younger than this alone. */
const GC_MIN_AGE = "5m";
const MINUTE = 60_000;

export const vmSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  /** running, stopped, creating or broken. */
  state: z.string(),
  ip: z.string().default(""),
  owner: z.string().default(""),
  slot: z.string().default(""),
});
export type Vm = z.infer<typeof vmSchema>;

export interface CreateVmInput {
  name: string;
  vcpus: number;
  memMiB: number;
  grants: readonly string[];
}

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type Run = (args: string[], options?: RunOptions) => Promise<string>;

export interface Skiff {
  list(): Promise<Vm[]>;
  /** The VM with this name, or null when skiff does not know it. */
  find(name: string): Promise<Vm | null>;
  create(input: CreateVmInput): Promise<Vm>;
  /** Runs argv in the VM exactly as given; stdin and stdout are passed through. */
  exec(name: string, argv: string[], options?: RunOptions): Promise<string>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  /**
   * Removes every VM this plugin owns that is not in `keep` and is older than a few minutes.
   * VMs without an owner are never touched.
   */
  gc(keep: readonly string[]): Promise<void>;
}

function parseJson<T>(command: string, output: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(`skiff ${command} returned invalid JSON: ${cleanText(output.slice(0, 200))}`, {
      cause: error,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`skiff ${command} returned unexpected data: ${parsed.error.message}`);
  }
  return parsed.data;
}

function grantArgs(grants: readonly string[]): string[] {
  return grants.flatMap((grant) => {
    if (!GRANT.test(grant)) throw new Error(`Invalid grant: ${grant}`);
    return ["--grant", grant];
  });
}

export function createSkiff(run: Run): Skiff {
  const list = async () =>
    parseJson("ls", await run(["ls", "--json"], { timeoutMs: MINUTE }), vmSchema.array());
  return {
    list,
    async find(name) {
      requireVmName(name);
      return (await list()).find((vm) => vm.name === name) ?? null;
    },
    async create(input) {
      const args = [
        "new",
        requireVmName(input.name),
        "--owner",
        VM_OWNER,
        "--vcpus",
        String(input.vcpus),
        "--mem",
        String(input.memMiB),
        ...grantArgs(input.grants),
        "--json",
      ];
      // A boot takes seconds; the first `new` after a Mac reboot also starts the container service.
      return parseJson("new", await run(args, { timeoutMs: 5 * MINUTE }), vmSchema);
    },
    exec(name, argv, options) {
      return run(["exec", requireVmName(name), "--", ...argv], options);
    },
    async start(name) {
      await run(["start", requireVmName(name)], { timeoutMs: 5 * MINUTE });
    },
    async stop(name) {
      await run(["stop", requireVmName(name)], { timeoutMs: 5 * MINUTE });
    },
    async remove(name) {
      await run(["rm", requireVmName(name)], { timeoutMs: 5 * MINUTE });
    },
    async gc(keep) {
      const args = keep.flatMap((name) => ["--keep", requireVmName(name)]);
      await run(["gc", "--owner", VM_OWNER, "--older-than", GC_MIN_AGE, ...args, "--json"], {
        timeoutMs: 5 * MINUTE,
      });
    },
  };
}

/** The bb server may run without a login shell's PATH; skiff needs `container` and `ssh`. */
export function skiffEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = [join(homedir(), "go", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const path = [...extra, env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
  return { ...env, PATH: path };
}

export function skiffBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.SKIFF_BIN?.trim() || "skiff";
}

export function createRun(lifetime: AbortSignal, env = skiffEnvironment()): Run {
  const binary = skiffBinary(env);
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      const child = execFile(
        binary,
        args,
        {
          env,
          signal,
          timeout: options.timeoutMs ?? 2 * MINUTE,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const detail = cleanText((stderr || stdout || error.message).trim().slice(-2000), 2000);
          reject(new Error(`skiff ${args[0]} failed: ${detail}`, { cause: error }));
        },
      );
      child.stdin?.on("error", () => {}); // an early exit is reported through the callback
      child.stdin?.end(options.stdin);
    });
}
