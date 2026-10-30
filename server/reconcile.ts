import type { JsonValue } from "@get-bb/plugin-sdk";
import { PROVIDER_ID, resourceSchema } from "./machine";
import type { Skiff } from "./skiff";
import { errorMessage } from "./text";
import type { Tunnels } from "./tunnels";

/** The subset of a bb host this plugin reads. */
export interface TrackedHost {
  id: string;
  machineProviderId: string | null;
  status: "connected" | "disconnected";
  lifecycle: { phase: string };
}

export interface ReconcileDeps {
  listHosts(): Promise<TrackedHost[]>;
  getResource(hostId: string): Promise<JsonValue | null>;
  skiff: Skiff;
  tunnels: Tunnels;
  log(message: string): void;
}

export interface ReconcileResult {
  tracked: string[];
  tunnels: string[];
}

/**
 * Lines skiff up with what bb knows: a tunnel for every live VM, no tunnel for a suspended
 * or vanished one, and `skiff gc` for VMs bb has forgotten (a crash between `skiff new` and
 * the checkpoint). VMs without an owner are never touched.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const hosts = (await deps.listHosts()).filter(
    (host) => host.machineProviderId === PROVIDER_ID && host.lifecycle.phase !== "destroyed",
  );
  const tracked: string[] = [];
  const live: string[] = [];
  for (const host of hosts) {
    const parsed = resourceSchema.safeParse(await deps.getResource(host.id));
    if (!parsed.success) continue;
    tracked.push(parsed.data.vm);
    if (host.lifecycle.phase === "active") live.push(parsed.data.vm);
  }

  for (const name of deps.tunnels.active()) {
    if (!live.includes(name)) deps.tunnels.stop(name);
  }
  for (const name of live) deps.tunnels.ensure(name);

  try {
    await deps.skiff.gc(tracked);
  } catch (error) {
    deps.log(`skiff gc failed: ${errorMessage(error)}`);
  }
  return { tracked, tunnels: deps.tunnels.active() };
}

/** Sleeps for `ms` unless `signal` aborts first; a plain setTimeout would outlive a reload. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
