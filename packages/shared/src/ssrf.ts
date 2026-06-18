/**
 * ssrf — the ONE canonical Server-Side Request Forgery guard for Playforge.
 *
 * Any code path that fetches a URL whose value is influenced by an attacker or
 * the model (the `read_url` tool, asset/provider fetches, remix imports, …)
 * MUST run it through this guard first. Do not fork a second copy: a divergent
 * blocklist is how the cloud-only threat model (plan §7) springs a leak.
 *
 * The guard has three layers, smallest blast radius first:
 *   1. `isBlockedIp`          — pure: is THIS literal IP in a private range?
 *   2. `assertSafeUrlString`  — sync: scheme + hostname + literal-IP checks.
 *   3. `assertSafeUrl`        — async: the above, THEN DNS-resolves the
 *                               hostname and re-checks every answer so a public
 *                               name that *statically* resolves to
 *                               169.254.169.254 / 10.x / ::1 is rejected.
 *
 * ⚠️ DNS REBINDING IS NOT FULLY CLOSED HERE. `assertSafeUrl` resolves the host
 * and validates the answers, but the caller's `fetch()` then performs its OWN
 * independent DNS resolution to connect — a TOCTOU window in which a low-TTL
 * attacker record can flip from a public IP (passes the guard) to a private one
 * (used by the socket). Fully closing this requires PINNING the connection to
 * the validated IP at connect time (e.g. an undici `Agent` whose `connect.lookup`
 * returns only the address `assertSafeUrl` validated, applied to every redirect
 * hop). That needs network-level integration testing and is tracked as a
 * pre-public-launch hardening item (see SECURITY_AUDIT.md). The guard here still
 * blocks the far more common static-record and literal-IP cases.
 *
 * REDIRECTS ARE NOT COVERED HERE. A single `assertSafeUrl` call validates one
 * URL. If the caller's fetch follows redirects, the guard is bypassed the
 * moment the origin answers `302 Location: http://169.254.169.254/`. Callers
 * MUST either fetch with `redirect: 'manual'` and re-run `assertSafeUrl` on
 * every `Location` hop, or use `redirect: 'error'` to refuse redirects
 * outright. See `read-url.ts` for the manual-hop pattern.
 */

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/**
 * Parse a strict IPv4 dotted-quad into its four octets, or null if the string
 * is not a canonical dotted-quad. Deliberately strict: rejects leading zeros
 * (octal ambiguity), >3 digits, out-of-range octets, and the shorthand forms
 * (`127.1`, `0x7f.0.0.1`, decimal `2130706433`). Anything ambiguous is treated
 * as "not a literal IPv4" so it falls through to hostname/DNS handling rather
 * than being silently mis-parsed into a different address.
 */
function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Must be 1–3 ASCII digits, no sign, no leading zero (except "0" itself).
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;

  // 0.0.0.0/8 — "this host" / unspecified (includes 0.0.0.0 itself).
  if (a === 0) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 10.0.0.0/8 — RFC1918 private.
  if (a === 10) return true;
  // 172.16.0.0/12 — RFC1918 private (172.16.x.x – 172.31.x.x).
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private.
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local / APIPA. Includes 169.254.169.254, the
  // cloud instance-metadata endpoint (AWS/GCP/Azure/DO) — the single most
  // important SSRF target.
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — CGNAT (RFC6598). 100.64.x – 100.127.x.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * Parse an IPv6 textual address (including the compressed `::` form and a
 * trailing embedded IPv4 like `::ffff:1.2.3.4`) into its 8 16-bit hextets, or
 * null if it is not a valid IPv6 literal. Zone ids (`%eth0`) are stripped.
 */
function parseIpv6(input: string): number[] | null {
  let s = input;

  // Strip a zone id if present (`fe80::1%eth0`).
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  if (s.length === 0) return null;
  // An IPv6 literal must contain a ':'. Bare hex without ':' is not IPv6.
  if (!s.includes(':')) return null;

  // Handle an embedded trailing IPv4 (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
  let tailHextets: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    tailHextets = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    // Replace the dotted tail with nothing; the trailing ':' stays as a marker.
    s = s.slice(0, lastColon + 1);
  }

  // Split on the "::" compression marker (at most one allowed).
  const doubleColonCount = (s.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const g of segment.split(':')) {
      if (g === '') return null; // stray empty group outside of "::"
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };

  let hextets: number[];
  if (doubleColonCount === 1) {
    const [headRaw, tailRaw] = s.split('::') as [string, string];
    // Trim boundary colons left behind by the embedded-IPv4 rewrite (which
    // leaves a trailing ':') or by `::`-adjacent groups.
    const head = headRaw.replace(/:$/, '');
    const tailStr = tailRaw.replace(/^:/, '').replace(/:$/, '');
    const headGroups = parseGroups(head);
    const tailGroups = parseGroups(tailStr);
    if (headGroups === null || tailGroups === null) return null;
    const explicit = headGroups.length + tailGroups.length + tailHextets.length;
    if (explicit > 8) return null;
    const fill = 8 - explicit;
    hextets = [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups, ...tailHextets];
  } else {
    const trimmed = s.replace(/:$/, '');
    const headGroups = parseGroups(trimmed);
    if (headGroups === null) return null;
    hextets = [...headGroups, ...tailHextets];
    if (hextets.length !== 8) return null;
  }

  if (hextets.length !== 8) return null;
  if (hextets.some((h) => h < 0 || h > 0xffff)) return null;
  return hextets;
}

/**
 * If `hextets` is an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible
 * (::a.b.c.d, all-zero high bits) address, return the embedded IPv4 octets so
 * the caller can re-check them with the IPv4 rules. Otherwise null.
 */
function embeddedIpv4(hextets: number[]): [number, number, number, number] | null {
  const h = hextets;
  const highZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (!highZero) return null;
  // ::ffff:a.b.c.d (IPv4-mapped) or ::a.b.c.d / ::0:a.b.c.d (IPv4-compatible).
  const isMapped = h[5] === 0xffff;
  const isCompat = h[5] === 0 && !(h[6] === 0 && h[7] === 0); // exclude ::/::1
  if (!isMapped && !isCompat) return null;
  const a = (h[6]! >> 8) & 0xff;
  const b = h[6]! & 0xff;
  const c = (h[7]! >> 8) & 0xff;
  const d = h[7]! & 0xff;
  return [a, b, c, d];
}

function isBlockedIpv6(hextets: number[]): boolean {
  const h = hextets;

  // ::  (unspecified) and ::1 (loopback).
  const allZeroHigh = h.slice(0, 7).every((x) => x === 0);
  if (allZeroHigh && (h[7] === 0 || h[7] === 1)) return true;

  // IPv4-mapped / -compatible — UNWRAP and re-check against IPv4 rules so
  // ::ffff:127.0.0.1 / ::ffff:169.254.169.254 / ::ffff:7f00:1 are caught.
  const v4 = embeddedIpv4(h);
  if (v4 !== null && isBlockedIpv4(v4)) return true;

  // fc00::/7 — Unique Local Addresses (top 7 bits = 1111110). Covers fc.. + fd..
  if ((h[0]! & 0xfe00) === 0xfc00) return true;

  // fe80::/10 — link-local (top 10 bits = 1111111010).
  if ((h[0]! & 0xffc0) === 0xfe80) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Is `ip` a literal IP address inside a range we refuse to fetch server-side?
 *
 * Accepts IPv4 dotted-quads and IPv6 literals (compressed `::`, embedded IPv4,
 * IPv4-mapped `::ffff:` in both dotted and hex `::ffff:AABB:CCDD` forms). A
 * string that is not a parseable literal IP returns `false` — this function
 * answers "is this blocked IP", not "is this a hostname I trust"; hostname
 * policy lives in `assertSafeUrlString` and DNS resolution in `assertSafeUrl`.
 */
export function isBlockedIp(ip: string): boolean {
  const trimmed = ip.trim();

  const v4 = parseIpv4(trimmed);
  if (v4 !== null) return isBlockedIpv4(v4);

  const v6 = parseIpv6(trimmed);
  if (v6 !== null) return isBlockedIpv6(v6);

  return false;
}

/** True iff `host` parses as a literal IPv4 or IPv6 address. */
function isLiteralIp(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'] as const;

/**
 * Ports we allow an outbound server-side fetch to target. `read_url` exists to
 * pull copy from public *web* pages, which live on 80/443 (plus the common
 * alt-web ports). An allowlist — rather than a denylist of "bad" ports — closes
 * SSRF against internal services on non-web ports (Redis 6379, Postgres 5432,
 * SSH 22, SMTP 25, Elasticsearch 9200, …) by default. The empty string is the
 * scheme default (http→80, https→443), which `URL.port` reports as ''.
 */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Synchronous, DNS-free URL safety check. Throws `Error('SSRF_BLOCKED: …')`
 * when:
 *   - the URL does not parse,
 *   - the scheme is not http: or https:,
 *   - the hostname is `localhost` or ends in `.localhost` / `.local` /
 *     `.internal`,
 *   - the hostname is a literal IP inside a blocked range.
 *
 * Does NOT resolve DNS — a public name that points at a private IP passes this
 * check. Use `assertSafeUrl` for the full (async, DNS-aware) guard.
 */
export function assertSafeUrlString(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF_BLOCKED: invalid URL — ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF_BLOCKED: scheme not allowed — ${parsed.protocol}`);
  }

  // Port allowlist — block reaching internal services on non-web ports.
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new Error(`SSRF_BLOCKED: port not allowed — ${parsed.port}`);
  }

  // URL lowercases the hostname already; strip IPv6 brackets so the literal-IP
  // parser sees `::1` rather than `[::1]`.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`SSRF_BLOCKED: blocked hostname — ${host}`);
  }

  if (isLiteralIp(host) && isBlockedIp(host)) {
    throw new Error(`SSRF_BLOCKED: blocked IP literal — ${host}`);
  }
}

/**
 * Full async SSRF guard. Runs `assertSafeUrlString` first (scheme/hostname/
 * literal-IP), then — only when the hostname is NOT already a literal IP —
 * resolves it via DNS and throws if ANY resolved address is blocked. This is
 * the defense against a public hostname whose A/AAAA records point at a private
 * address (e.g. 169.254.169.254 cloud metadata, an internal 10.x service).
 *
 * IMPORTANT — redirects: this validates exactly ONE URL. A fetch that follows
 * redirects can be steered to a private address by a `Location` header AFTER
 * this returns. Callers MUST fetch with `redirect: 'manual'` and re-call
 * `assertSafeUrl` on every hop, or use `redirect: 'error'`.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  assertSafeUrlString(url);

  const { hostname } = new URL(url);
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Literal IPs were already fully checked synchronously; no DNS to do.
  if (isLiteralIp(host)) return;

  // Dynamic import keeps the module loadable in non-Node bundles that never
  // call the async guard (the sync API stays Node-free).
  const { lookup } = await import('node:dns/promises');

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SSRF_BLOCKED: DNS resolution failed for ${host} — ${msg}`);
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`SSRF_BLOCKED: ${host} resolves to blocked IP ${address}`);
    }
  }
}
