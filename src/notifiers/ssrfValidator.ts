import dns from 'node:dns/promises';
import net from 'node:net';

export interface SsrfValidationOptions {
  /**
   * Whether to allow http:// protocol (default: false, only https:// allowed).
   */
  allowHttp?: boolean;
  /**
   * Explicit list of allowed protocols (defaults to ['https:'] or ['https:', 'http:'] if allowHttp is true).
   */
  allowedProtocols?: string[];
  /**
   * Whether to allow private and loopback IPs (default: false, for secure production use).
   */
  allowPrivateIps?: boolean;
  /**
   * Optional custom DNS lookup function for mocking or specialized resolution.
   */
  dnsLookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export interface SsrfValidationResult {
  isValid: boolean;
  error?: string;
  url?: URL;
  resolvedIps?: string[];
}

/**
 * Determines whether an IPv4 address belongs to a private, loopback, link-local,
 * multicast, or reserved subnet according to RFC 1918, RFC 1122, RFC 3927, etc.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is treated as unsafe
  }

  const [b0, b1, b2] = parts;

  // 0.0.0.0/8 (Current network / "this" network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (Private Class A)
  if (b0 === 10) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT / Shared Address Space)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 127.0.0.0/8 (Loopback / Localhost)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-Local / Cloud Instance Metadata Services e.g. 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (Private Class B: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1 documentation)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (b0 === 192 && b1 === 88 && b2 === 99) return true;

  // 192.168.0.0/16 (Private Class C)
  if (b0 === 192 && b1 === 168) return true;

  // 198.18.0.0/15 (Network Interconnect Benchmark Testing: 198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2 documentation)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 documentation)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255) & 240.0.0.0/4 (Reserved / Broadcast)
  if (b0 >= 224) return true;

  return false;
}

/**
 * Determines whether an IPv6 address belongs to a private, loopback, link-local,
 * multicast, unique local, or reserved subnet.
 */
export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // IPv6 Loopback (::1 or 0:0:0:0:0:0:0:1)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // IPv6 Unspecified (:: or 0:0:0:0:0:0:0:0)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1 or ::ffff:192.168.1.1)
  if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
    const rawIpv4 = normalized.replace(/^.*ffff:/, '');
    if (net.isIPv4(rawIpv4)) {
      return isPrivateIpv4(rawIpv4);
    }
    return true;
  }

  // Unique Local Address (ULA) fc00::/7 (covers fc00::/8 and fd00::/8)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // Link-Local Unicast fe80::/10 (fe80..febf)
  if (/^fe[89ab][0-9a-f]/i.test(normalized)) return true;

  // Multicast ff00::/8
  if (normalized.startsWith('ff')) return true;

  return false;
}

/**
 * Validates whether an IP address (IPv4 or IPv6) is a private, loopback, or reserved address.
 */
export function isPrivateIp(ip: string): boolean {
  const cleanIp = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(cleanIp)) {
    return isPrivateIpv4(cleanIp);
  }
  if (net.isIPv6(cleanIp)) {
    return isPrivateIpv6(cleanIp);
  }
  // If not a recognized IP string, treat as unsafe
  return true;
}

/**
 * Validates a destination URL against Server-Side Request Forgery (SSRF) vulnerabilities.
 * Checks protocol enforcement (https:// required by default) and performs DNS resolution
 * to ensure no target IPs belong to private or loopback subnets.
 *
 * @param urlString The destination URL to validate
 * @param options SSRF validation configuration
 * @returns SsrfValidationResult indicating validity and error reason if invalid
 */
export async function validateSsrf(
  urlString: string,
  options: SsrfValidationOptions = {}
): Promise<SsrfValidationResult> {
  if (!urlString || typeof urlString !== 'string') {
    return {
      isValid: false,
      error: 'Destination URL must be a non-empty string',
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString.trim());
  } catch (err: any) {
    return {
      isValid: false,
      error: `Invalid URL format: ${err.message}`,
    };
  }

  // 1. Protocol validation (https:// enforced by default)
  const allowedProtocols =
    options.allowedProtocols ||
    (options.allowHttp ? ['https:', 'http:'] : ['https:']);

  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    return {
      isValid: false,
      error: `Disallowed protocol '${parsedUrl.protocol}'. Only ${allowedProtocols.join(', ')} permitted.`,
      url: parsedUrl,
    };
  }

  const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!hostname) {
    return {
      isValid: false,
      error: 'Destination URL must contain a valid hostname',
      url: parsedUrl,
    };
  }

  // 2. Reject obvious internal hostname patterns
  if (
    !options.allowPrivateIps &&
    (hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan'))
  ) {
    return {
      isValid: false,
      error: `Destination hostname '${hostname}' is an internal domain.`,
      url: parsedUrl,
    };
  }

  // 3. Direct IP address check (if URL contains an IP address directly)
  if (net.isIP(hostname)) {
    if (!options.allowPrivateIps && isPrivateIp(hostname)) {
      return {
        isValid: false,
        error: `Destination IP address '${hostname}' belongs to a private/loopback/reserved subnet.`,
        url: parsedUrl,
        resolvedIps: [hostname],
      };
    }
    return {
      isValid: true,
      url: parsedUrl,
      resolvedIps: [hostname],
    };
  }

  // 4. DNS resolution to resolve all associated IP addresses
  let resolvedAddresses: string[] = [];
  try {
    if (options.dnsLookup) {
      const records = await options.dnsLookup(hostname);
      resolvedAddresses = records.map((r) => r.address);
    } else {
      const records = await dns.lookup(hostname, { all: true });
      resolvedAddresses = records.map((r) => r.address);
    }
  } catch (dnsErr: any) {
    return {
      isValid: false,
      error: `DNS resolution failed for hostname '${hostname}': ${dnsErr.message}`,
      url: parsedUrl,
    };
  }

  if (resolvedAddresses.length === 0) {
    return {
      isValid: false,
      error: `Hostname '${hostname}' resolved to zero IP addresses.`,
      url: parsedUrl,
    };
  }

  // 5. Verify every resolved IP against private address ranges
  if (!options.allowPrivateIps) {
    for (const ip of resolvedAddresses) {
      if (isPrivateIp(ip)) {
        return {
          isValid: false,
          error: `Hostname '${hostname}' resolves to private/loopback IP address '${ip}'.`,
          url: parsedUrl,
          resolvedIps: resolvedAddresses,
        };
      }
    }
  }

  return {
    isValid: true,
    url: parsedUrl,
    resolvedIps: resolvedAddresses,
  };
}

/**
 * Asserts that a URL is safe from SSRF attacks.
 * Throws an Error if validation fails, or returns the validated URL string.
 */
export async function assertSsrfSafe(
  urlString: string,
  options?: SsrfValidationOptions
): Promise<string> {
  const result = await validateSsrf(urlString, options);
  if (!result.isValid) {
    throw new Error(`SSRF validation blocked request: ${result.error}`);
  }
  return urlString;
}
