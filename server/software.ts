/**
 * The software every VM gets before bb enrolls it. bb's bootstrap needs Node, npm and curl in
 * the guest; Claude Code and the GitHub CLI are what agents run. Bump here, then run
 * `npm test`: the provision tests check that a checksum exists for every pinned archive.
 */
export const VM_SOFTWARE = {
  node: "22.23.3",
  claude: "2.1.301",
  gh: "2.102.0",
} as const;
export type SoftwareName = keyof typeof VM_SOFTWARE;

export const VM_SOFTWARE_VERSION = (Object.keys(VM_SOFTWARE) as SoftwareName[])
  .map((name) => `${name}-${VM_SOFTWARE[name]}`)
  .join("-");
