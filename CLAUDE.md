# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An Ayla **LAN-mode server** + web UI that drives a De'Longhi ECAM coffee machine entirely locally,
with no cloud. Developed against a Primadonna Soul ECAM 610.75.MB. `README.md` covers what it does
for a user; this file covers what you need to know to change it.

## The two facts the whole design follows from

1. **LAN mode inverts the roles.** This server does not connect to the machine — the machine
   connects to *us*. We announce an address (`SERVER_IP`) and it opens the sessions. So `SERVER_IP`
   must be reachable *from the machine's network*, and `machine → server:3000` must be allowed by
   the firewall. This is the first cause of "nothing works".
2. **The machine picks up exactly ONE command per visit** to `/local_lan/commands.json`. There are
   never two frames in flight. That is the only structural mutual exclusion in the system, and the
   whole scheduler (`src/lib/tasks.mjs`) exists to make it explicit rather than accidental.

Commands reach a real appliance. Anything physical or persistent is confirmed before it is sent,
and a failure is reported as a failure — never as a fake success.

## Commands

Node **≥ 26** (the store uses native `node:sqlite`), pnpm 11 (pinned by `packageManager`).

```bash
pnpm install
pnpm dev        # node server.mjs --dev  — Next HMR for pages, raw HTTP for device endpoints
pnpm build && pnpm start
pnpm lint       # ESLint 10, .mjs only (see § Lint)
node_modules/.bin/tsc --noEmit
for f in server.mjs src/lib/*.mjs; do node --check "$f"; done
```

`next dev` alone is **wrong**: it bypasses `server.mjs`, and the ESP32's HTTP client rejects the
App Router's response framing. `pnpm dev:next-only` exists for pure page work only.

### Verification — there is no test framework

Each check is a standalone, dependency-free script. Running one script *is* "running a single test".

```bash
node scripts/verif-tasks.mjs       # scheduler: ranks, preemption, sustain windows
node scripts/verif-monitor.mjs     # monitor decoding, replayed on REAL captured frames
node scripts/verif-lansession.mjs  # both LAN-session roles talking to each other
node scripts/verif-apps.mjs        # app registry + payload parsing
node scripts/verif-args.mjs        # ECAM frame table / argument decoding (byte offsets)
node scripts/verif-transfert.mjs   # writing a local recipe into a machine slot
node scripts/verif-messages.mjs    # literal next-intl keys exist in messages/fr.json
node scripts/verif-contraste.mjs   # WCAG + ΔL* of both finishes, read back out of globals.css
node scripts/verif-images.mjs      # the beverage-artwork fingerprint chain (extractor → table → URL → cache rule)
node scripts/verif-surfaces.mjs    # the 12 surfaces in a REAL headless Chrome (see § Styling)
```

These exist because the modules they cover are **pure**, and the errors they catch are the silent
ones: a one-byte offset or a swapped key direction raises nothing — it produces plausible, wrong
values. Keeping those modules pure is what keeps this possible.

`verif-surfaces.mjs` is the one exception and it is deliberate: it seeds a throwaway SQLite
database, boots `server.mjs` on port 3127 and drives a real Chrome (`puppeteer-core` — plain
`puppeteer` is refused, third-party install scripts are blocked by `pnpm-workspace.yaml`; point
`CHROME_PATH` at a binary if it is not in the usual place). It covers what only a browser can
answer — a focus trap, an Escape key, an inert background, a `box-shadow` that a layer silently
overrode. **Nothing in `src/ui` or `surfaces.css` ships without it green.**

Live diagnostics and loopback rigs, when a real behaviour is in question:

```bash
node --env-file=.env.local debug-capture.mjs       # standalone LAN server on :3005, VERBATIM log
PROXY_APPS=1 SERVER_PORT=3099 node server.mjs      # multiplexer, end to end on loopback:
node scripts/faux-app.mjs --serveur 127.0.0.1:3099 --port 8888
node scripts/fausse-machine.mjs --serveur 127.0.0.1:3099
node scripts/extract-models.mjs                    # regenerate the APK-derived tables
node scripts/extract-catalogs.mjs
node scripts/extract-images.mjs
```

`.github/workflows/ci.yml` runs all of the above plus the SQLite migration chain (v1→v2→v3 on
fabricated databases) and a Docker smoke test. Read it before adding a check — it is the closest
thing to a spec of what can be proven without a coffee machine.

## Architecture

### `server.mjs` is the real server, in every mode

~5 500 lines, and the single entry point. It handles in raw `node:http`, before Next ever sees the
request: `/ota_status.json` + `/local_lan/lan_ota` (logged, never served), `/regtoken.json` +
`/local_reg.json` (only when the multiplexer is on), `/local_lan/*` (device-facing), `/api/*`
(control API, ~35 endpoints). Everything else falls through to the Next handler — **pages only**.

### Shadowed code: do not edit it expecting an effect

`src/app/api/*/route.ts` and `src/app/local_lan/**/route.ts`, plus the `src/lib/*.ts` they import
(`config.ts`, `session.ts`, `crypto.ts`, `ecam.ts`, `machine.ts`, `program.ts`, `recipes.ts`,
`keepalive.ts`), are **dead at runtime** — `server.mjs` intercepts those paths first. They still
type-check, so they look alive. The live implementations are the `.mjs` siblings.

### `src/lib` — the pure core

| Module | Role |
|---|---|
| `tasks.mjs` | the scheduler (pure: the instant is always a parameter) |
| `ecam-args.mjs` | the ECAM protocol reference: op table, frame reading, argument decoding. Anything that *names* a command reads this table |
| `beverages.mjs` | per-model beverage catalog, Ayla property namespace, recipe bounds |
| `ingredients.mjs` + `transfert.mjs` | what actually goes into a persistent recipe write |
| `trame-bornes.mjs` | bounds-frame encoding |
| `monitor.mjs` | real-time state / sensor / alarm decoding |
| `profiles.mjs` | profile names, favourites, checksums, Bean System |
| `bean-adapt.mjs` | the grind/temp/aroma adjustment rule, re-implemented locally |
| `lansession.mjs` | LAN session crypto, both roles (client *and* device) |
| `appregistry.mjs` + `appproxy.mjs` | multiplexer state and payloads |
| `machine-models.mjs` | model identification from the serial number |
| `store.mjs` | SQLite persistence (the one impure module) |

Frame constructors live in `server.mjs`, decoders in `ecam-args.mjs`. They **must** read the same
table — a drift between them is invisible at runtime.

### Scheduler semantics

One queue per machine. A task is a list of steps plus a policy; four ranks, and one preemption rule:
a task may be suspended *at a step boundary* by a strictly higher rank. Three wait natures:

- `prop` — an Ayla property read: wait for the machine to POST *that* property;
- `reponse` — a reading ECAM command (`0x75`, `0xA2`, `0xA3`, `0xA6`, `0xB0`, `0xBA`): wait for any
  `data_response`;
- `fenetre` — an *acting* command (`0x84`, `0x83`, `0xA9`, `0xBB`, `0xB9`): nothing comes back, so
  `ms` is a **sustained-presence duration** — reaching it is success, not a timeout.

`device_connected` is served first and then every fifth visit, or the machine stops considering us
present. Presence-sustaining frames must be side-effect free: **`0xA9` selects a profile**, so using
it as a heartbeat silently forces profile 1.

### Storage

One SQLite file (`data/lan-server.db`; `DATA_DIR` / `DATABASE_FILE`), WAL + `synchronous = FULL` +
`STRICT` tables. Each received property is one upserted row, not a rewritten 80 kB blob. Schema v3;
migrations run automatically at boot and announce themselves through `bootMessages`. Every data
table carries a `machine` column with `ON DELETE CASCADE`; machine-independent settings live in
their own `settings` table.

### Several machines

Machine ids are **ours** (`m1`, `m2`…), not the DSN — the DSN is only discovered after an address is
entered. The browser keeps the current machine in `localStorage` (a per-browser display preference,
deliberately not server state) and every API call carries `?machine=`. Always go through `mfetch`
in `src/app/machine.ts`; a bare `fetch` targets the server's *default* machine. Two limits, stated
in the UI: the `MACHINE_*` / `LANIP_*` env vars describe only the first machine, and the beverage
catalog is one model's, shared by all — a mismatch is reported, not corrected.

### Model detection, and generated tables

`d270_serialnumber` characters 1–5 index the manufacturer table (`0132217055` → `17055` →
ECAM 610.75.MB) — no cloud involved. `machine-models.json`, `machine-catalogs.json` and
`beverage-images.json` are **generated** by `scripts/extract-*.mjs` from the APK (ESLint ignores the
first two). Never hand-edit them; change the script.

### App multiplexer — off by default

`PROXY_APPS=1` makes this server answer `/regtoken.json` and `/local_reg.json` as the machine would,
so several apps can share the machine's **single** `local_reg` slot (an official app on the network
evicts us with no error and no signal at all). It is opt-in because impersonating a device is an
explicit act, not a side effect of an upgrade. Apps build URLs as `http://<ip>/` with no port, so
they only ever look on **port 80** — listen there or redirect, otherwise nothing arrives.

## Front-end conventions

Next 16 App Router, React 19, TypeScript 7, `next-intl`. **Code, comments and UI are in French**,
with dense "why did this end up like this" headers — match that register.

- Single locale, **no locale prefix** in URLs: a `[locale]` segment would move every page for no
  benefit while `server.mjs` intercepts `/api` and `/local_lan` upstream.
- The API sends **stable protocol identifiers** (`slug` for a beverage, the ECAM enum name for a
  parameter) plus a fallback label; the client translates via `src/i18n/labels.ts`. Nothing
  translatable crosses the API. A name typed on the machine ("Grain A") is user data and is
  **never** translated.
- Every physical or persistent action goes through the shared confirmation dialog
  (`src/app/confirm.tsx`, prefs in `confirmPrefs.ts`). Never `window.confirm`: unstylable, and it
  returns `false` in a sandboxed iframe, which makes every button on the page silently inert.
- Anything the machine can change arrives over SSE (`/api/events`, hook in `src/app/events.ts`),
  never by polling — a property read is not synchronous; the machine pushes 2–4 s later.

### Styling: Tailwind 4 + shadcn/ui, and one law about the cascade

**shadcn is the target for every surface**, existing ones included — migrated 2026-08-26. `src/ui`
holds the mounted primitives; `cn()` is `clsx` + `tailwind-merge`; the CLI is configured by
`components.json` (style `new-york`, alias `@/ui`). A `shadcn add` lands in the right world.

Three files, three jobs:

| | |
|---|---|
| `src/app/globals.css` | tokens on `:root` with a `[data-theme="light"]` override, so **dark is the default** — plus the **token bridge** (`@theme inline`) that remaps shadcn's fixed vocabulary onto the boîtier's roles, and the `tactile:` / `court:` / `dark:` variants |
| `src/ui/*.tsx` | the components, each carrying the product's own matter in utilities |
| `src/app/surfaces.css` | what is left: page layout, and the rules no utility can express |

⚠️ **`utilities` beats `surfaces` in the layer cascade — specificity does not enter into it.** This
is the single fact the whole migration turns on. A rule in `surfaces.css` that repaints a component
loses **silently**: it type-checks, it lints, the page renders, and the wrong colour ships. The fix
is always the same — **move the matter onto the component**, as a class or a variant. Every
component in `src/ui` that departs from the CLI's version says in its header what it took over and
why. Paid for once by `.confirm` (57 dead lines) and once by three card modifiers.

⚠️ **Two remaps are product law, not taste.** `--primary` is the **neutral** key, *not* amber: a
command's colour states its FUNCTION (`marche` starts something on the appliance, `arret` stops or
destroys, amber means *chosen*), never its importance. And `--radius` is 2 px, the boîtier's value.

⚠️ **A Radix `Switch` / `Checkbox` / `RadioGroupItem` is a `<button>`, and a `<label>` does not name
a button.** Wrapping one produces an unnamed control, in silence, where the native input got a name
for free. Use `aria-labelledby` pointing at the visible text.

Three native elements were deliberately reversed in that migration — `<select>`, `<dialog>`,
`<input type="range">`. Each was rendering a real service the component now owes:
`scripts/verif-surfaces.mjs` checks all three in a real browser (focus trap, Escape, background
inertness, the `--crans` graduation, the profile listbox). Do not weaken those assertions.
- `verif-messages.mjs` only sees **literal** keys written on the spot. A key requested inside a
  helper that receives a translator (`fmtAge(sec, t)`) is invisible to it — that is the very bug
  that motivated it.

## Lint

ESLint 10 flat config, `.mjs` **only** — that is where the hole was: `tsconfig.json` includes only
`.ts`/`.tsx`, so the files that actually run had no checking beyond `node --check`. The `.tsx` side
is covered by `tsc --noEmit`.

⚠️ **Do not add `typescript-eslint`.** TypeScript 7 (the native port) no longer exports the classic
compiler API it needs, and its peer range excludes 7. The install succeeds; the analysis fails on
the first line of TSX. The full reasoning is in the header of `eslint.config.mjs`.

## Secrets and data hygiene

Never commit, publish, or attach to a report: `.env.local`; `data/lan-server.db` (LAN keys, serial
numbers, profile names — treat it as a password file); `public/boissons*` (De'Longhi artwork — the
repo ships the *mapping* `src/lib/beverage-images.json`, never the images); the workspace's `apk/`,
`decompiled/` and `docs/`. `src/lib/cloud-app.json` is committed on purpose and is not secret.

Device-specific values in any documentation are written as markers (`IP_MACHINE`,
`AC000W0XXXXXXXX`, `VLAN_IOT`, "Grain A/B"). `scripts/faux-app.mjs` is deliberately incapable of
building an ECAM frame — a test tool that can start a hot-water rinse is a dangerous thing to leave
lying around.

## Current state

Commit `c807a2c` ("CLean doc") deleted `CLAUDE.md`, `ETAT.md`, `PRODUCT.md` and the whole `doc/`
tree. `README.md` and many source comments still point at `doc/*.md`
(`analyse-connexion-wifi.md`, `commandes-cafe.md`, `format-trame-boisson.md`, `bean-adapt.md`,
`materiel-et-firmware.md`, `securite.md`, `spec-proxy-multi-app.md`): those links are dead until
`doc/` comes back. The content is recoverable with `git show c807a2c^:doc/<file>`.
