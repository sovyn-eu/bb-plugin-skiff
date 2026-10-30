import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { CreateVmInput, Skiff, Vm } from "./skiff";
import type { Tunnels } from "./tunnels";

/** An in-memory skiff for tests: every call is recorded, VMs live in a map. */
export function fakeSkiff(initial: Vm[] = []) {
  const vms = new Map(initial.map((vm) => [vm.name, vm]));
  const calls: string[][] = [];
  const failures = new Map<string, Error>();
  const fail = (command: string) => {
    const error = failures.get(command);
    if (error) throw error;
  };
  const skiff: Skiff = {
    async list() {
      calls.push(["ls"]);
      fail("ls");
      return [...vms.values()];
    },
    async find(name) {
      calls.push(["find", name]);
      fail("ls");
      return vms.get(name) ?? null;
    },
    async create(input: CreateVmInput) {
      calls.push(["new", input.name, String(input.vcpus), String(input.memMiB), ...input.grants]);
      fail("new");
      const vm: Vm = { name: input.name, state: "running", ip: "192.168.64.9", owner: "bb", slot: "" };
      vms.set(vm.name, vm);
      return vm;
    },
    async exec(name, argv, options) {
      calls.push(["exec", name, ...argv, options?.stdin?.slice(0, 20) ?? ""]);
      fail("exec");
      return '{"node":"22.23.3","gh":"2.102.0","claude":"2.1.301"}\n';
    },
    async start(name) {
      calls.push(["start", name]);
      fail("start");
      const vm = vms.get(name);
      if (vm) vms.set(name, { ...vm, state: "running" });
    },
    async stop(name) {
      calls.push(["stop", name]);
      fail("stop");
      const vm = vms.get(name);
      if (vm) vms.set(name, { ...vm, state: "stopped" });
    },
    async remove(name) {
      calls.push(["rm", name]);
      fail("rm");
      vms.delete(name);
    },
    async gc(keep) {
      calls.push(["gc", ...keep]);
      fail("gc");
      for (const vm of [...vms.values()]) {
        if (vm.owner === "bb" && !keep.includes(vm.name)) vms.delete(vm.name);
      }
    },
  };
  return { skiff, calls, vms, failures };
}

export function fakeTunnels() {
  const active = new Set<string>();
  const events: string[] = [];
  const tunnels: Tunnels = {
    ensure(name) {
      events.push(`ensure ${name}`);
      active.add(name);
    },
    stop(name) {
      events.push(`stop ${name}`);
      active.delete(name);
    },
    stopAll() {
      events.push("stopAll");
      active.clear();
    },
    active: () => [...active],
  };
  return { tunnels, events };
}

export function fakeReport() {
  const lines: string[] = [];
  return {
    lines,
    report: { step: (text: string) => lines.push(`step: ${text}`), log: (text: string) => lines.push(`log: ${text}`) },
  };
}

export const noopExecutor: MachineExecutor = { exec: async () => ({ exitCode: 0 }) };
