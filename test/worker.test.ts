import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker, { type Env } from '../src/worker';

describe('HTTP routes', () => {
  it('creates a private host URL and limits repeated creates from one IP', async () => {
    const ip = `test-${crypto.randomUUID()}`;
    const request = () => new Request('https://example.test/api/rooms', { method: 'POST', headers: { 'cf-connecting-ip': ip } });
    const first = await worker.fetch(request(), env as Env);
    expect(first.status).toBe(201);
    const created = await first.json() as { code: string; hostUrl: string };
    expect(created.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(new URL(created.hostUrl).pathname).toBe('/host.html');
    expect(new URL(created.hostUrl).searchParams.get('host')).toBe(created.code);
    expect(new URL(created.hostUrl).searchParams.get('token')?.length).toBeGreaterThan(32);
    for (let i = 1; i < 12; i++) expect((await worker.fetch(request(), env as Env)).status).toBe(201);
    const limited = await worker.fetch(request(), env as Env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await worker.fetch(new Request('https://example.test/api/nope'), env as Env)).status).toBe(404);
  });
});
