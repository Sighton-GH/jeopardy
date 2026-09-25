import { Room } from './room';
export { Room };
export { RateLimit } from './rate_limit';
import type { RateLimit } from './rate_limit';
export interface Env { ROOM: DurableObjectNamespace<Room>; RATE_LIMIT: DurableObjectNamespace<RateLimit>; ASSETS: Fetcher }
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function secret(size: number) { const bytes = crypto.getRandomValues(new Uint8Array(size)); return Array.from(bytes, b => alphabet[b % alphabet.length]).join(''); }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      // The edge sets CF-Connecting-IP; local dev shares one conservative bucket.
      const ip = request.headers.get('cf-connecting-ip') ?? 'local';
      const limiter = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(ip));
      const limit = await limiter.fetch('https://limit/check');
      if (!limit.ok) return new Response(JSON.stringify({ error: 'Too many rooms. Try again later.' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': limit.headers.get('retry-after') ?? '3600' } });
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = secret(8), token = crypto.randomUUID() + crypto.randomUUID();
        const room = env.ROOM.get(env.ROOM.idFromName(code));
        const init = await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }));
        if (init.ok) return response({ code, hostUrl: `${url.origin}/host.html?host=${code}&token=${token}` }, 201);
        if (init.status !== 409) return response({ error: 'Room creation failed' }, 500);
      }
      return response({ error: 'Could not generate a unique room code' }, 503);
    }
    const match = /^\/api\/rooms\/([A-Z2-9]{8})\/ws$/.exec(url.pathname);
    if (match && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const room = env.ROOM.get(env.ROOM.idFromName(match[1]!));
      return room.fetch(new Request(`https://room/ws${url.search}`, request));
    }
    if (url.pathname.startsWith('/api/')) return response({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};
