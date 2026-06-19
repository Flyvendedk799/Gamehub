import { afterEach, describe, expect, it, vi } from 'vitest';

const originalApiUrl = process.env['NEXT_PUBLIC_API_URL'];

async function loadConfig() {
  vi.resetModules();
  return import('../config');
}

afterEach(() => {
  if (originalApiUrl === undefined) {
    Reflect.deleteProperty(process.env, 'NEXT_PUBLIC_API_URL');
  } else {
    process.env['NEXT_PUBLIC_API_URL'] = originalApiUrl;
  }
  vi.resetModules();
});

describe('API config', () => {
  it('defaults to the local API dev port', async () => {
    Reflect.deleteProperty(process.env, 'NEXT_PUBLIC_API_URL');

    const { API_BASE, API_ORIGIN, API_WS_BASE, DEFAULT_API_BASE } = await loadConfig();

    expect(DEFAULT_API_BASE).toBe('http://localhost:3191');
    expect(API_BASE).toBe(DEFAULT_API_BASE);
    expect(API_ORIGIN).toBe(DEFAULT_API_BASE);
    expect(API_WS_BASE).toBe('ws://localhost:3191');
  });

  it('honors NEXT_PUBLIC_API_URL', async () => {
    process.env['NEXT_PUBLIC_API_URL'] = 'https://api.playforge.test';

    const { API_BASE, API_ORIGIN, API_WS_BASE } = await loadConfig();

    expect(API_BASE).toBe('https://api.playforge.test');
    expect(API_ORIGIN).toBe('https://api.playforge.test');
    expect(API_WS_BASE).toBe('wss://api.playforge.test');
  });
});
