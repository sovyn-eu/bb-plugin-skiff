// Keeps tabs and newlines; drops escape sequences and carriage returns that could forge log lines.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Text that originates in a VM or a CLI is untrusted: strip control characters and bound it. */
export function cleanText(value: string, max = 1000): string {
  return value.replace(CONTROL, " ").slice(0, max);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
