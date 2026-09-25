import type { Room } from '../src/room';
declare module 'cloudflare:test' { interface ProvidedEnv { ROOM: DurableObjectNamespace<Room>; ASSETS: Fetcher } }
