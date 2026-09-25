import { DurableObject } from 'cloudflare:workers';
/** One Durable Object per visitor IP, with a bounded rolling-hour create counter. */
export class RateLimit extends DurableObject {
  async fetch(): Promise<Response> {
    const now = Date.now();
    const attempts = ((await this.ctx.storage.get<number[]>('attempts')) ?? []).filter(time => now - time < 60 * 60 * 1000);
    if (attempts.length >= 12) return new Response(null, { status: 429, headers: { 'retry-after': String(Math.ceil((attempts[0]! + 60 * 60 * 1000 - now) / 1000)) } });
    attempts.push(now);
    await this.ctx.storage.put('attempts', attempts);
    return new Response(null, { status: 204 });
  }
}
