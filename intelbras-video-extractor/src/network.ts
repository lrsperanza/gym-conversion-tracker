import os from "node:os";
import net from "node:net";

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  let result = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const base = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum === null || baseNum === null) return false;

  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

export function isTailscaleInterfaceName(name: string): boolean {
  return /tailscale|^ts\d+$/i.test(name);
}

export type LanInterface = { name: string; address: string };

export function findLocalLanAddress(cidr: string): LanInterface | null {
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || isTailscaleInterfaceName(name)) continue;
    for (const addr of addresses) {
      if (addr.family !== "IPv4") continue;
      if (addr.internal) continue;
      if (ipInCidr(addr.address, cidr)) {
        return { name, address: addr.address };
      }
    }
  }
  return null;
}

export function checkTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Best-effort check of the Tailscale daemon. Returns true/false when the CLI
 * answered, null when it is unavailable. Successful operation never depends
 * on this — an OS-level subnet route works regardless.
 */
export function probeTailscaleStatus(): boolean | null {
  try {
    const proc = Bun.spawnSync(["tailscale", "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const text = proc.stdout.toString();
    const parsed = JSON.parse(text) as { BackendState?: string };
    return parsed.BackendState === "Running";
  } catch {
    return null;
  }
}

export type NetworkReport =
  | { mode: "lan"; interfaceName: string; address: string }
  | {
      mode: "tailscale";
      rtspReachable: boolean;
      httpReachable: boolean;
      tailscaleRunning: boolean | null;
    }
  | { mode: "unreachable"; rtspReachable: boolean; httpReachable: boolean };

export async function detectNetwork(opts: {
  dvrHost: string;
  rtspPort: number;
  httpPort: number;
  gymCidr: string;
}): Promise<NetworkReport> {
  const lan = findLocalLanAddress(opts.gymCidr);
  if (lan) {
    return { mode: "lan", interfaceName: lan.name, address: lan.address };
  }

  const [rtspReachable, httpReachable] = await Promise.all([
    checkTcp(opts.dvrHost, opts.rtspPort, 3000),
    checkTcp(opts.dvrHost, opts.httpPort, 3000),
  ]);

  if (rtspReachable || httpReachable) {
    return {
      mode: "tailscale",
      rtspReachable,
      httpReachable,
      tailscaleRunning: probeTailscaleStatus(),
    };
  }

  return { mode: "unreachable", rtspReachable, httpReachable };
}
