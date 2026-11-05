import { isAbsolute, join } from "node:path";

/** skiff's name for a repository's profile file. */
export const REPO_PROFILE_FILE = ".skiff";

/**
 * Whether a bb SDK error says the thread does not exist. bb answers `404 thread_not_found`;
 * how the plugin RPC carries that is not specified, so status, code and message all count.
 */
export function isThreadNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  if (status === 404 || code === "thread_not_found") return true;
  return typeof message === "string" && /thread_not_found|thread not found/i.test(message);
}

/** A project folder as bb records it ("Add project"): a path on one of the machines. */
export interface ProjectSource {
  hostId: string;
  path: string;
  isDefault: boolean;
}

/** What the lookup needs from bb and the file system; injected so tests need neither. */
export interface ProjectLookup {
  /**
   * The project of a thread, or null when there is no such thread (the launch key of a machine
   * created without one). Any other failure must throw: a VM silently built without the
   * repository's profile would look fine and lack what the project needs.
   */
  threadProject(threadId: string): Promise<string | null>;
  projectSources(projectId: string): Promise<readonly ProjectSource[]>;
  isFile(path: string): Promise<boolean>;
}

/**
 * The repository profile for the VM a launch creates: `<project folder>/.skiff` on this Mac.
 *
 * For a thread's machine bb uses the thread id as the launch key, so the key leads to the
 * thread, its project and the project's folders. The plugin runs on the Mac, so a folder whose
 * `.skiff` exists here is the one the user added and can trust. The default folder comes first.
 * Anything else (a key that is no thread id, no folder here, no file) means no repository
 * profile, and the VM gets the plugin's profile and the machine default as before.
 *
 * The file is passed to skiff as it is: skiff checks that the user trusted exactly this path
 * and content (`skiff profile trust`), so an agent that changes .skiff cannot widen a VM.
 */
export async function findRepoProfile(deps: ProjectLookup, launchKey: string): Promise<string | null> {
  const projectId = await deps.threadProject(launchKey);
  if (projectId === null) return null;
  const sources = [...(await deps.projectSources(projectId))].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault),
  );
  for (const source of sources) {
    if (!isAbsolute(source.path)) continue;
    const candidate = join(source.path, REPO_PROFILE_FILE);
    if (await deps.isFile(candidate)) return candidate;
  }
  return null;
}
