# Jeopardy foundation

Cloudflare Worker with static assets and one SQLite-backed Durable Object per 8-character game code. No accounts. Each room saves its board, scores, team and host tokens, queue, and deadlines in Durable Object storage; a Worker/DO restart or idle eviction closes live sockets, but clients can reconnect to the saved room. Create a room by uploading a CSV or XLSX board at `/create`, then share the eight-character code with up to 10 teams. The host board and phone buzzer update through WebSockets.

## Run

```sh
npm ci
npm run check
npm run build
npm run dev
```

`npm run check` builds `dist` before running TypeScript, ESLint, and Vitest (the Workers test pool requires the assets directory). `wrangler dev` serves the built frontend assets from `dist`. The four pages are `/`, `/create`, `/host`, and `/player`; Workers Assets redirects `.html` URLs to the clean path and preserves query parameters. To verify a real local process restart (uses port 8799 and a persistent test directory), run `JEOPARDY_PERSIST_TEST_DIR=/tmp/jeopardy-room-restart-$USER npm run test:restart`; use a fresh directory for each run. Deploy with `npm run deploy`. Route `jeopardy.sighton.ca` in Cloudflare separately; no production DNS or deployment is included.

## Protocol (JSON WebSocket)

Create `POST /api/rooms` -> `{code,hostUrl}`. Connect `GET /api/rooms/:CODE/ws?role=host&token=...` using the private host URL, or `?role=team&name=...`; a reconnecting team sends its server-issued `reconnect` token and identical name. Code and names are URL encoded by `URLSearchParams`. The host token is a bearer secret: do not publish the host link or add external scripts to its page. No spectator role yet.

Server: `welcome {role,teamId?,reconnectToken?,state}` on connection, `state {state}` on change, `error {code,message}` for invalid commands, `pong` to `ping`. `state` includes phase, teams, board, selectedCellId, buzzQueue, lockedOut, buzzerDeadline (epoch milliseconds), hostConnected, version. Team views omit all answers, and show only the selected question. Host views contain all questions and answers. IDs, not names, identify teams and cells.

Team sends `buzz` (or `ping`). Host sends:
- `load_board {board:{categories:[{id,name,cells:[{id,question,answer,value,dailyDouble}]}]}}`
- `pick_cell {cellId}` from board; `arm_buzzers` from question-showing
- `correct` awards selected value to first in queue; `wrong` deducts selected value, locks them out, and gives next queued team a 15-second answer window or reopens buzzers
- `back_to_board` reveals the picked cell and clears buzz state; `adjust_score {teamId,delta}` adjusts a score

The first buzz is current answerer. Subsequent buzzes queue in arrival order. A 15-second timer starts per active answerer; expiry locks that team out without a score penalty and advances the queue. Daily doubles are stored but not yet given special wager behavior. On `correct`, the cell is revealed; `back_to_board` also reveals the cell, even if unanswered. Scores may be negative. Replacing a board resets its revealed flags, so use only for initial setup in normal play.

## Frontend flow

The landing join form sends players to `/player.html?code=CODE&name=NAME` with encoded values; Workers Assets canonicalizes this to `/player`. Create at `/create`: upload a Jeopardy Labs export or a simple CSV/XLSX sheet, review the parsed categories, then create the room and load the board over the host WebSocket. The server-issued private host URL uses `/host.html?host=CODE&token=TOKEN` and canonicalizes to `/host` in local Wrangler. Do not share the token or host URL with players. The board, controls, team buzzers, score adjustments and reconnects use live room state.

The design source mocks and theme are in `design/` for reference; the live landing imports `public/theme.css`, the host retains the theme plus its own CSS rules, and the create and player views retain their slice styles. The design mock data is not used as game data.

## Current limits

Rooms save state and tokens on each accepted change in SQLite-backed Durable Object storage. A Worker/DO restart or idle eviction drops open sockets, so host and teams must reconnect with their saved credentials. A room expires after six hours from creation; a persistent alarm enforces expiry and answer deadlines even across restarts. A restarted object treats previous sockets as disconnected and settles an overdue answer timer when it restores. If a client loses its token, the host may re-admit it by name after checking identity in person. Persisted room data remains stored after expiry (not yet purged), so monitor storage over repeated events. Cloudflare outages, failed writes, and phones without usable saved tokens can still interrupt play; rehearse on the deployed Worker. Room creation is limited to 12 requests per rolling hour per edge visitor IP (local dev uses a shared bucket). This is basic abuse protection, not account authentication or a distributed anti-abuse service; shared networks can hit the limit together. Host token is a bearer credential in the initial create response and redirect URL, then removed from the host address bar and saved only for this tab's session. Do not share the initial URL or browser history; deploy behind HTTPS. A saved tab can reopen its host socket after refresh.

This app runs one Jeopardy round. Daily-double cells are hidden until selected but have no wagering flow; Final Jeopardy and early-buzz lockout are not implemented. Clock skew affects the display countdown only, not the server deadline. Room-code collisions are improbable; each code has a persistent initialized record, and an expired code is not reused. The host has explicit score correction controls (+/-100 and +/-500). A host can re-admit a disconnected team on a new device by invalidating its former token; only do this after checking the team identity in person, since anyone with the room code and team name could take that slot while re-admission is pending. The board uploader rejects oversized messages and limits category/clue text lengths.

## Dependency audit (2026-09-25)

`npm audit` reports seven development-tool advisories (two moderate, five high), in Vitest, its Cloudflare Workers pool and transitive packages (including Wrangler, Miniflare, sharp, and ws). An attempted major pool/Vitest bump did not pass TypeScript because `cloudflare:test` is unavailable from that release with the current test setup, so the lockfile retains the last tested versions. Do not describe the advisories as fixed; migrate the test harness and re-audit before production deployment. The deployed Worker bundle does not use these dev-only testing packages, but the tooling should still be updated.

Visual shell: game-style rounded controls, large join code, blue-and-white SLxCA palette. The host board keeps its deep Jeopardy blue layout. No live-status badge is shown; connection failures appear as text only when needed.

Browser-visible join failures: a rejected team WebSocket upgrades long enough to send an error event before closing, so duplicate names, full rooms, and mid-question joins display specific messages instead of an unreadable HTTP-handshake body. The host page stacks board then panels at narrow widths.
