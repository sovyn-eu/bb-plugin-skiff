import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { VM_OWNER, requireVmName } from "./names";
import { cleanText } from "./text";

/** A VM a concurrent create just made is not in the keep list yet; gc leaves VMs younger than this alone. */
const GC_MIN_AGE = "5m";
const MINUTE = 60_000;
/**
 * skiff reads a repository profile from ./.skiff unless --profile names the files. Started from
 * the bb server's directory (often $HOME) that path is skiff's own state folder, ~/.skiff. The
 * plugin always passes --profile now; running from the root keeps every other command, and a
 * future one that forgets --profile, away from a stray ./.skiff too.
 */
export const SKIFF_CWD = "/";
/** A profile setup downloads Node, gh and Claude Code on a fresh guest; generous for a slow connection. */
const SETUP_TIMEOUT_MS = 25 * MINUTE;

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
  /** Only a launch's own size; the settings' size is in the plugin's profile. A flag beats every file. */
  vcpus?: number;
  memMiB?: number;
  /**
   * Absolute paths of the profile files, merged in order after the machine default: the
   * plugin's (./profile.ts), then the project's .skiff when there is one.
   */
  profiles: readonly string[];
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
  /**
   * Boots a VM owned by bb and applies the profiles: setup, grants and guest settings. skiff
   * refuses a file that is not trusted; the plugin trusts its own with `trustProfile`.
   */
  create(input: CreateVmInput, options?: { signal?: AbortSignal }): Promise<void>;
  /** Applies the profiles again, setup included, to a running VM of an earlier attempt. */
  apply(name: string, profiles: readonly string[], options?: { signal?: AbortSignal }): Promise<void>;
  /** Records trust for one file as it is now; never called for a repository's .skiff. */
  trustProfile(profile: string): Promise<void>;
  /**
   * Fails when skiff is older than 0.6.0 (before 0.5.0 a second --profile would replace the
   * first) or cannot read the profile merged with a broken or clashing machine default.
   */
  checkProfile(profiles: readonly string[]): Promise<void>;
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

/**
 * 0.5.0 made --profile repeatable with trust per file, 0.5.1 added --version, 0.6.0
 * `allow_grants`, which the settings point users to.
 */
export const MIN_SKIFF_VERSION = [0, 6, 0] as const;
const VERSION = /\bv?(\d+)\.(\d+)\.(\d+)/;

/**
 * Whether `skiff --version` output (`skiff version v0.6.0`) meets MIN_SKIFF_VERSION. A build
 * without version information reports `dev`; that is someone working on skiff, so it passes.
 */
export function supportedSkiffVersion(output: string): boolean {
  const text = output.trim();
  if (/\bdev$/.test(text)) return true;
  const match = VERSION.exec(text);
  if (!match) return false;
  const found = match.slice(1, 4).map(Number);
  for (const [i, need] of MIN_SKIFF_VERSION.entries()) {
    const have = found[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/**
 * No `--trust`: it would trust every file given, the project's .skiff included. The plugin
 * trusts its own file beforehand (`trustProfile`); a .skiff needs the user's `skiff profile
 * trust`, since it runs a script as root and picks grants.
 */
function profileArgs(profiles: readonly string[]): string[] {
  if (profiles.length === 0) throw new Error("A VM needs at least one profile file");
  return profiles.flatMap((profile) => ["--profile", requireAbsolute(profile)]);
}

/** skiff would resolve a relative path against its own working directory. */
function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error(`The profile path must be absolute: ${path}`);
  return path;
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
    async create(input, options = {}) {
      const args = [
        "new",
        requireVmName(input.name),
        "--owner",
        VM_OWNER,
        ...(input.vcpus === undefined ? [] : ["--vcpus", String(input.vcpus)]),
        ...(input.memMiB === undefined ? [] : ["--mem", String(input.memMiB)]),
        ...profileArgs(input.profiles),
      ];
      // No --json: nothing uses the result, and callers look the VM up with `find`.
      await run(args, { timeoutMs: SETUP_TIMEOUT_MS, signal: options.signal });
    },
    async apply(name, profiles, options = {}) {
      await run(["apply", requireVmName(name), "--setup", ...profileArgs(profiles)], {
        timeoutMs: SETUP_TIMEOUT_MS,
        signal: options.signal,
      });
    },
    async trustProfile(profile) {
      await run(["profile", "trust", requireAbsolute(profile)], { timeoutMs: MINUTE });
    },
    async checkProfile(profiles) {
      let version: string;
      try {
        version = (await run(["--version"], { timeoutMs: MINUTE })).trim();
      } catch {
        version = "older than 0.5.1, which added --version";
      }
      if (!supportedSkiffVersion(version)) {
        throw new Error(`skiff ${MIN_SKIFF_VERSION.join(".")} or newer is needed, this is ${version}`);
      }
      // `show` resolves and validates the merge, as `new` will; `lint FILE` checks the file alone.
      await run(["profile", "show", ...profileArgs(profiles)], { timeoutMs: MINUTE });
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
          cwd: SKIFF_CWD,
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
