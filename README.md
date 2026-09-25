# Jeopardy foundation

Cloudflare Worker with static assets and one in-memory Durable Object for each 8-character game code. No accounts, database, or persistent room storage. A room is temporary; a Worker/DO restart or idle eviction can end it. Do not use for a long-lived event without adding persistence/recovery. Host control and board upload are protocol seams, not yet a full host UI. The landing page creates a room and joins up to 10 teams; the phone buzzer is functional once a board is loaded via a later host view.

## Run

```sh
npm ci
npm run check
npm run build
npm run dev
```

`wrangler dev` serves frontend assets from `dist`; run `npm run build` first. Deploy with `npm run deploy`. Route `jeopardy.sighton.ca` in Cloudflare separately; no production DNS or deployment is included.

## Protocol (JSON WebSocket)

Create `POST /api/rooms` -> `{code,hostUrl}`. Connect `GET /api/rooms/:CODE/ws?role=host&token=...` using the private host URL, or `?role=team&name=...`; a reconnecting team sends its server-issued `reconnect` token and identical name. Code and names are URL encoded by `URLSearchParams`. The host token is a bearer secret: do not publish the host link or add external scripts to its page. No spectator role yet.

Server: `welcome {role,teamId?,reconnectToken?,state}` on connection, `state {state}` on change, `error {code,message}` for invalid commands, `pong` to `ping`. `state` includes phase, teams, board, selectedCellId, buzzQueue, lockedOut, buzzerDeadline (epoch milliseconds), hostConnected, version. Team views omit all answers, and show only the selected question. Host views contain all questions and answers. IDs, not names, identify teams and cells.

Team sends `buzz` (or `ping`). Host sends:
- `load_board {board:{categories:[{id,name,cells:[{id,question,answer,value,dailyDouble}]}]}}`
- `pick_cell {cellId}` from board; `arm_buzzers` from question-showing
- `correct` awards selected value to first in queue; `wrong` deducts selected value, locks them out, and gives next queued team a 15-second answer window or reopens buzzers
- `back_to_board` reveals the picked cell and clears buzz state; `adjust_score {teamId,delta}` adjusts a score

The first buzz is current answerer. Subsequent buzzes queue in arrival order. A 15-second timer starts per active answerer; expiry locks that team out without a score penalty and advances the queue. Daily doubles are stored but not yet given special wager behavior. On `correct`, the cell is revealed; `back_to_board` also reveals the cell, even if unanswered. Scores may be negative. Replacing a board resets its revealed flags, so use only for initial setup in normal play.

## Integration seams

The next host view should keep its host token in the URL/session, connect as host, render the host `state`, and send the typed commands from `src/protocol.ts`. A spreadsheet parser should validate and normalize uploaded rows client-side or in a new Worker endpoint into `BoardInput` and then send `load_board` over the authenticated host socket. Keep raw spreadsheets out of the room DO. Theme config belongs in frontend configuration/assets, not game rules. Future views can replace `public/app.ts` without changing the state machine. The `View` contract intentionally separates host and team visibility. Add a board/display route and question rendering there; the existing player page shows status and buzzer only.
