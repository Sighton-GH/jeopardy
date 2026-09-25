# Jeopardy UI prototype

Static design slice for the SLxCA game. Open landing.html, host.html and phone.html directly. All styling is in theme.css; no network assets or framework needed. These are mocks, not functional room UI. The host board value and "Preview question" open a sample reveal; the phone state selector previews waiting, armed and locked states. Remove demo selectors when wiring real state.

Integration: import theme.css; keep classes `.board`, `.tile.category`, `.tile.value`, `.reveal`, `.host-side` for the host; `.player` and its `data-state=waiting|ready|locked` for the player. Populate values, categories, scores, clues and current state from room messages. The board mock uses 4x5 because the current SLxCA round has four categories; change `grid-template-columns` to a CSS custom property or class for imported boards with 5-6 categories. Cells are real buttons. Room join/create form awaits handlers and validation.

Visual direction: real game-show geometry: 4-column deep blue board, large gold values, white all-caps category and clue reveal, near-black framing. Phone is deliberately separate: bright, one giant thumb-friendly buzzer and obvious state feedback, informed by Connor's request for Kahoot-grade ease. A narrow warm red trim is an event accent, *not* asserted to be an official Schulich color. The official Schulich Leaders website currently leans blue (#3165A8 favicon, #2f62a5 stylesheet), not red: https://schulichleaders.com/ . Do not place a third-party logo unless provided/cleared by the organizer. No exact Jeopardy logo/fonts/assets are copied.

These examples are sample UI data, not the event's exact question/score state. Do not ship hard-coded placeholder clue/team names as production content.
