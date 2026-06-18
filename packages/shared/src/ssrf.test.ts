import { describe, expect, it } from 'vitest';
import { assertSafeUrl, assertSafeUrlString, isBlockedIp } from './ssrf';

describe('isBlockedIp — IPv4 ranges', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0/8 unspecified'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', '127.0.0.0/8'],
    ['10.0.0.1', '10/8 private'],
    ['10.255.255.255', '10/8 private'],
    ['172.16.0.1', '172.16/12 private (low)'],
    ['172.31.255.255', '172.16/12 private (high)'],
    ['192.168.0.1', '192.168/16 private'],
    ['192.168.1.1', '192.168/16 private'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'CGNAT low'],
    ['100.127.255.255', 'CGNAT high'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['172.15.0.1', 'just below 172.16/12'],
    ['172.32.0.1', 'just above 172.16/12'],
    ['192.169.0.1', 'just outside 192.168/16'],
    ['169.253.0.1', 'just below link-local'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.0', 'just above CGNAT'],
    ['126.0.0.1', 'just below loopback /8'],
    ['128.0.0.1', 'just above loopback /8'],
    ['11.0.0.1', 'just above 10/8'],
    ['93.184.216.34', 'example.com public'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isBlockedIp — IPv6 ranges', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'ULA fc00::/7 (fc..)'],
    ['fd12:3456:789a::1', 'ULA fc00::/7 (fd..)'],
    ['fe80::1', 'link-local fe80::/10'],
    ['febf::1', 'link-local upper edge fe80::/10'],
    // IPv4-mapped — dotted form. Must unwrap to the IPv4 and re-check.
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted)'],
    ['::ffff:169.254.169.254', 'IPv4-mapped cloud metadata (dotted)'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private (dotted)'],
    // IPv4-mapped — hex form `::ffff:AABB:CCDD`. 0x7f000001 = 127.0.0.1.
    ['::ffff:7f00:1', 'IPv4-mapped loopback (hex)'],
    // 0xa9fea9fe = 169.254.169.254
    ['::ffff:a9fe:a9fe', 'IPv4-mapped cloud metadata (hex)'],
    // IPv4-compatible (deprecated) ::a.b.c.d
    ['::127.0.0.1', 'IPv4-compatible loopback'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['2001:4860:4860::8888', 'Google public IPv6 DNS'],
    ['2606:4700:4700::1111', 'Cloudflare public IPv6 DNS'],
    ['::ffff:8.8.8.8', 'IPv4-mapped PUBLIC address (dotted) stays allowed'],
    ['::ffff:0808:0808', 'IPv4-mapped PUBLIC address (hex) stays allowed'],
    ['2001:db8::1', 'documentation prefix (not in any blocked range)'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('strips a zone id before classifying', () => {
    expect(isBlockedIp('fe80::1%eth0')).toBe(true);
  });
});

describe('isBlockedIp — non-IP strings are not "blocked"', () => {
  it.each(['example.com', 'localhost', 'not-an-ip', '', '999.999.999.999', '127.1', '0x7f.0.0.1'])(
    'returns false for non-literal-IP %j',
    (s) => {
      expect(isBlockedIp(s)).toBe(false);
    },
  );
});

describe('assertSafeUrlString', () => {
  it.each([
    'https://example.com',
    'https://example.com/path?q=1',
    'http://example.com',
    'https://8.8.8.8',
    'https://1.1.1.1',
    'https://[2001:4860:4860::8888]/',
  ])('accepts public URL %s', (url) => {
    expect(() => assertSafeUrlString(url)).not.toThrow();
  });

  it.each(['ftp://example.com', 'file:///etc/passwd', 'data:text/html,hi', 'gopher://x'])(
    'rejects non-http(s) scheme %s',
    (url) => {
      expect(() => assertSafeUrlString(url)).toThrow(/SSRF_BLOCKED/);
    },
  );

  it.each([
    'http://localhost',
    'http://localhost:8080',
    'http://app.localhost',
    'http://service.local',
    'http://db.internal',
  ])('rejects blocked hostname %s', (url) => {
    expect(() => assertSafeUrlString(url)).toThrow(/SSRF_BLOCKED/);
  });

  it.each([
    'http://127.0.0.1',
    'http://127.0.0.1:9000/admin',
    'http://10.0.0.5',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects blocked literal-IP URL %s', (url) => {
    expect(() => assertSafeUrlString(url)).toThrow(/SSRF_BLOCKED/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => assertSafeUrlString('http://')).toThrow(/SSRF_BLOCKED/);
    expect(() => assertSafeUrlString('not a url')).toThrow(/SSRF_BLOCKED/);
  });

  it.each([
    'https://example.com', // default 443
    'http://example.com', // default 80
    'https://example.com:443',
    'http://example.com:80',
    'https://example.com:8080',
    'https://example.com:8443',
  ])('accepts allowed web port %s', (url) => {
    expect(() => assertSafeUrlString(url)).not.toThrow();
  });

  it.each([
    'http://example.com:6379', // Redis
    'http://example.com:5432', // Postgres
    'http://example.com:22', // SSH
    'http://example.com:25', // SMTP
    'http://example.com:9200', // Elasticsearch
    'http://example.com:3000', // arbitrary internal app
  ])('rejects a public host on a non-web port %s (internal-service SSRF)', (url) => {
    expect(() => assertSafeUrlString(url)).toThrow(/SSRF_BLOCKED: port not allowed/);
  });
});

describe('assertSafeUrl (async)', () => {
  // Literal IPs never hit DNS, so these assertions are network-free.
  it('rejects a blocked literal-IP URL without DNS', async () => {
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /SSRF_BLOCKED/,
    );
    await expect(assertSafeUrl('http://10.0.0.1/')).rejects.toThrow(/SSRF_BLOCKED/);
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('accepts a public literal-IP URL without DNS', async () => {
    await expect(assertSafeUrl('https://8.8.8.8/')).resolves.toBeUndefined();
    await expect(assertSafeUrl('https://1.1.1.1/')).resolves.toBeUndefined();
    await expect(assertSafeUrl('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });

  it('rejects a non-http scheme before any DNS', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/SSRF_BLOCKED/);
  });
});
