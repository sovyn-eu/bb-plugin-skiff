import { VM_SOFTWARE } from "./software";

/**
 * Installers for the software every VM gets. Each runs as root inside a fresh Ubuntu 24.04
 * guest (curl, tar, git and systemd are there; Node is not) and is also what a re-run of the
 * provision script executes, so every installer must be safe over an existing installation.
 *
 * Archives are checked against the publishers' SHA-256 sums (nodejs.org/dist/vX/SHASUMS256.txt,
 * gh_X_checksums.txt on the cli/cli release). Claude Code's installer checks its own download.
 */
export const CHECKSUMS = {
  node: {
    "22.23.3": {
      arm64: "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
      x64: "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
    },
  },
  gh: {
    "2.102.0": {
      arm64: "7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484",
      amd64: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
    },
  },
} as const;

function checksum(name: "node" | "gh", arch: string): string {
  const version = VM_SOFTWARE[name];
  const sums = (CHECKSUMS[name] as Record<string, Record<string, string>>)[version];
  const sum = sums?.[arch];
  if (!sum) throw new Error(`No ${name} ${version} checksum for ${arch} in server/install.ts`);
  return sum;
}

const CURL = "curl --fail --silent --show-error --location --retry 3 --connect-timeout 15";

/** Node from the official tarball into /usr/local, where npm's global prefix then lives too. */
export const installNode = String.raw`set -eu
case "$(uname -m)" in
  aarch64|arm64) node_arch=arm64; node_sha256=${checksum("node", "arm64")} ;;
  x86_64) node_arch=x64; node_sha256=${checksum("node", "x64")} ;;
  *) echo "Unsupported Node architecture $(uname -m)" >&2; exit 1 ;;
esac
node_tmp=$(mktemp -d)
trap 'rm -rf "$node_tmp"' EXIT
${CURL} --max-time 600 "https://nodejs.org/dist/v${VM_SOFTWARE.node}/node-v${VM_SOFTWARE.node}-linux-$node_arch.tar.gz" -o "$node_tmp/node.tar.gz"
printf '%s  %s\n' "$node_sha256" "$node_tmp/node.tar.gz" | sha256sum --check --strict
tar -xzf "$node_tmp/node.tar.gz" -C /usr/local --strip-components=1 --no-same-owner \
  --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
node --version
npm --version`;

/** Anthropic's installer owns the binary in /root/.local/bin, so Claude Code can update itself. */
export const installClaude = String.raw`set -eu
claude_tmp=$(mktemp -d)
trap 'rm -rf "$claude_tmp"' EXIT
${CURL} --max-time 120 https://claude.ai/install.sh -o "$claude_tmp/install.sh"
bash "$claude_tmp/install.sh" ${VM_SOFTWARE.claude}
/root/.local/bin/claude --version`;

export const installGh = String.raw`set -eu
case "$(uname -m)" in
  aarch64|arm64) gh_arch=arm64; gh_sha256=${checksum("gh", "arm64")} ;;
  x86_64) gh_arch=amd64; gh_sha256=${checksum("gh", "amd64")} ;;
  *) echo "Unsupported GitHub CLI architecture $(uname -m)" >&2; exit 1 ;;
esac
gh_tmp=$(mktemp -d)
trap 'rm -rf "$gh_tmp"' EXIT
gh_dir=gh_${VM_SOFTWARE.gh}_linux_$gh_arch
${CURL} --max-time 300 "https://github.com/cli/cli/releases/download/v${VM_SOFTWARE.gh}/$gh_dir.tar.gz" -o "$gh_tmp/gh.tar.gz"
printf '%s  %s\n' "$gh_sha256" "$gh_tmp/gh.tar.gz" | sha256sum --check --strict
tar -xzf "$gh_tmp/gh.tar.gz" -C "$gh_tmp" "$gh_dir/bin/gh"
install -m 0755 "$gh_tmp/$gh_dir/bin/gh" /usr/local/bin/gh
gh --version`;
