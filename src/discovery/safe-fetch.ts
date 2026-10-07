import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;

export type HostResolver = (hostname: string) => Promise<string[]>;

export class UnsafeUrlError extends Error {
  constructor(url: string) {
    super(`Refusing to fetch ${url}: not a public web address`);
  }
}

const dnsResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * A `fetch` for user-supplied URLs: only http(s) on default ports to hosts that resolve to public addresses, with
 * redirects followed by hand so every hop is checked too. Unsafe targets throw `UnsafeUrlError`.
 */
export function publicFetch(fetcher: typeof fetch = globalThis.fetch, resolve: HostResolver = dnsResolver): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : input);
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url, resolve);
      const response = await fetcher(url.toString(), { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) {
        Object.defineProperty(response, "url", { value: url.toString() });
        return response;
      }
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${input}`);
      url = new URL(location, url);
    }
  }) as typeof fetch;
}

export async function assertPublicUrl(url: URL, resolve: HostResolver = dnsResolver): Promise<void> {
  if (!/^https?:$/.test(url.protocol) || url.port || url.username || url.password) throw new UnsafeUrlError(url.href);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(url.href);
  }
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new UnsafeUrlError(url.href);
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const ip = address.toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]!);
  if (ip === "::" || ip === "::1") return false;
  return !/^(f[c-d]|fe[89ab])/.test(ip) && !ip.startsWith("::ffff:") && !ip.startsWith("64:ff9b:");
}

function isPublicIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
