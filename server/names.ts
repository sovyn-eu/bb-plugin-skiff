import { createHash } from "node:crypto";

/** skiff's own rule: a DNS-label-like name, at most 31 characters. */
export const VM_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Every VM this plugin creates carries this owner label, so `skiff gc --owner bb` only touches ours. */
export const VM_OWNER = "bb";

const NAME_PREFIX = `${VM_OWNER}-`;
const DIGEST_LENGTH = 12;

/**
 * The VM name for a machine launch key. Deterministic, so a retried create and
 * `reconcileCleanup` find the VM of an earlier attempt without any journal.
 */
export function vmNameForKey(key: string): string {
  if (key.trim() === "") throw new Error("A machine key must not be empty");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, DIGEST_LENGTH);
  return `${NAME_PREFIX}${digest}`;
}

export function requireVmName(name: string): string {
  if (!VM_NAME.test(name)) throw new Error(`Invalid VM name: ${name}`);
  return name;
}
