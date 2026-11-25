# Repository Guidelines

simple-tsumeshogi: a personal PWA for solving real-game tsumeshogi (mate problems) against an in-browser shogi engine. A move that keeps the mate going is accepted even if it differs from the stored solution. It is a single-screen, phone-first app written in TypeScript with Vite and no framework. Setup, data and deployment are described in `README.md`; open work is in `docs/TODO.md`.

## Project Structure

- `src/main.ts` boots the app, tells the boot watchdog in `index.html` that the JS started (`window.__started`), and registers the service worker in production builds only.
- `src/app.ts` is the single `App` class: the phase state machine (`loading | playing | result | error`), input handling (one delegated click listener reading `data-action`), and rendering with `innerHTML` templates.
- `src/engine/` talks to the WASM engines over USI. `src/game/` holds the engine-judged attempt (`session.ts`), feats (`feats.ts`) and finishing-move detection (`finish.ts`). `src/history/` holds the answer history (`record.ts` is shared with the Worker and must stay dependency-free; `store.ts` is the local store with an outbox synced to `/api/history`). `src/problems/` loads and selects problems. `src/shogi/` is the rules. `src/ui/` holds the board view, sound (`sound.ts`), move feel (`step.ts`), effects (`effects/`, all motion goes through `AnimationScope`) and the ghost (`ghost/`).
- `src/settings.ts` holds the settings and their per-field validation (localStorage `tsume.settings.v1`).
- `worker/index.ts` is the Cloudflare Worker: `/api/history` (D1, rate-limited writes), `/problems/*` (R2) and `/__dev/*` (dev only). Everything else is static assets. `migrations/` holds the D1 schema.
- `public/` holds the PWA files (`sw.js`, `manifest.webmanifest`, `_headers`, icons, fonts) and the prebuilt engines in `public/engine/`.
- `engine/` is the engine build (YaneuraOu submodule and WASM patch). `scripts/` holds data, engine and icon scripts. `.cache/` holds problem data and toolchains and is not committed.
- `tests/` holds the vitest tests. `tests/d1.ts` replays the migrations on `node:sqlite`.
- `docs/` holds design notes: `move-feel.md` (sound and motion), `ghost.md`, `engine-tuning.md`, `minimal-hand.md`.

## Build, Test, and Development

- `npm install` installs the locked dependencies. Node is pinned in `.nvmrc`.
- `npm run dev` starts `cf dev` (http://localhost:5173) with local D1 and R2. Load the problem data into the local R2 once with `npm run upload:problems -- --local` while the dev server is running.
- `npm run typecheck` type-checks the app and tests (`tsconfig.json`) and the Worker (`worker/tsconfig.json`).
- `npm test` runs the vitest unit tests in `tests/`.
- `npm run build` runs the typecheck and `cf build`. Production (`tsumeshogi.houchishoujo.com`) deploys from pushes to `main` via Workers Builds; do not deploy or push unless asked.
- To see a change in the running app (motion, board, result card, review), use the `run-app` skill in `.claude/skills/run-app/`: it starts `cf dev` and drives headless Chrome through a chosen problem.

For changes, run `npm run typecheck`, `npm test`, and `npm run build`, and drive the app with `run-app` when the UI changes.

## Coding Style

Use TypeScript ES modules and keep the strict compiler settings. Follow the existing style: 2-space indentation, single quotes, semicolons, and trailing commas in multiline structures. Keep game rules and decisions (feats, streak, selection, ghost rules) as pure functions outside `app.ts` so they can be tested. Respect `prefers-reduced-motion` in every new animation. Comments and docs are written in Japanese, matching the existing files. No formatter or linter is configured, so keep changes consistent with nearby code.

## Testing

Tests run in the default node environment (no jsdom), so they cover the pure modules: rules, session, feats, finish, ghost rules, history and store, the D1 API, settings and sound pitch. Add a test next to any new pure logic. The DOM, the service worker and the Worker routing are checked by driving the app with `run-app`.

## Shared with sibling apps

simple-eigo, simple-whowhy and simple-tsumeshogi keep these parts the same. When you change one of them here, change the other apps too (or note in their docs why not).

- CSS token names: `--bg`, `--surface`, `--text`, `--muted`, `--border`, `--accent`, `--accent-soft`, `--correct`, `--correct-soft`, `--wrong`, `--wrong-soft`, `--warn`, `--radius`. The colors stay specific to each app.
- BEM class names for the shared parts: `.feat-chips` / `.feat-chip` / `.feat-chip--rare`, `.header__combo` / `.header__combo--hot`, `.combo-burst` / `.combo-burst__count` / `.combo-burst__label`.
- A 3px `:focus-visible` outline. Dialogs have `role="dialog"`, `aria-modal="true"` and an `aria-label`, close on Escape, take focus when opened and give it back when closed.
- `ComboBurst` (React apps): shows the count at combo milestones for 1200ms and hides as soon as a non-milestone answer comes in.
- Sound effects are synthesized with Web Audio through one master `GainNode`; the unlock listeners stay for the life of the page.
- `index.html` has a boot watchdog (`window.__started`), `public/_headers` sets `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`, and the viewport does not use `viewport-fit=cover`.

This app has no header combo and no `ComboBurst`: the streak is shown by the ghost (`src/ui/ghost/`). It also sets COOP/COEP in `_headers`, which the engine's SharedArrayBuffer needs; the other apps leave them out because they load cross-origin resources.

## Commits

Work directly on `main`. This is a one-person project, so do not create feature branches or pull requests: commit each change straight to `main`. Pushing `main` deploys to production, so push only when asked.

Use short imperative subjects (for example, `Add review step keys`) and keep each commit focused.
