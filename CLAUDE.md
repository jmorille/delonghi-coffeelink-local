# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## If you read nothing else

1. **`server.mjs` is the only thing that runs.** The route handlers under `src/app/api/**` and
   `src/app/local_lan/**` are shadowed in every mode; so are the `src/lib/*.ts` modules only they
   import. A fix applied there changes nothing at runtime.
2. **Roles are inverted**: the machine is the HTTP *client*. We only ever initiate `local_reg`.
3. **Every data access goes through `forMachine(id)`.** There is no machine-less store API.
4. **The client never calls bare `fetch` on `/api/*`** — use `mfetch` (or `forId`), or the request
   silently targets the *default* machine instead of the one on screen.
5. **Commands act on a real appliance.** "On" triggers a physical hot-water rinse. Confirm intent.
6. **No test suite here** — protocol changes are validated live against the machine.

## What this project is

Reverse-engineering of the **De'Longhi Coffee Link** Android app (`it.delonghi`) to build a
**100 % local controller** for a De'Longhi Primadonna Soul **ECAM 610.75.MB** espresso machine,
bypassing the De'Longhi/Ayla cloud.

**This file lives in `lan-server/`, which IS the git repository root.** The workspace directory
above it (`delonghi-coffee-link/`) is not versioned and holds three siblings:

- `../docs/` — the private protocol analysis (the source of truth for how the machine works),
  see the redaction rule below.
- `lan-server/` — **this repo**: the buildable deliverable, a Next.js app implementing an
  **Ayla LAN mode** server plus web UIs to control the machine and configure recipes.
- `../delonghi_coffeelink_ha/` — a **separate git repo** (`actabi/delonghi_coffeelink`, HACS,
  published), the *cloud* counterpart: a Home Assistant integration driving the same machines
  through Ayla instead of LAN mode. Not part of this build; do not edit it as part of lan-server
  work. Two reasons it still matters here: it is the only place with working **Eletta Explore /
  `DL-striker-cb`** handling — the STRIKER gap this file flags as unimplemented — and its
  `tests/` assert against **real frames captured from users**, i.e. ground truth we have nowhere
  else. Its own CI runs only HACS validation and hassfest, so **those tests never run in CI**.
- `../apk/`, `../decompiled/` — the app being reverse-engineered.

**The protocol docs exist twice, and only the redacted copy is versioned.** `../docs/` is the
private working analysis (real serial, IP, MAC, profile names, plus `secrets.md` and
`capture-reveil-app.txt`); **`doc/`** — inside this repo — is the copy that ships, same text with
`IP_MACHINE`, `AC000W0XXXXXXXX`, `XX:XX:XX:XX:XX:XX`, `VLAN_IOT`, "Grain A/B" substituted. A
protocol finding must be written to **both**, and anything device-specific must be a marker in
`doc/`. They have already drifted in substance, not just redaction (`../docs/commandes-cafe.md`
still says `machine-model.json` where `doc/` correctly says `machine-catalogs.json`), so when they
disagree, diff them rather than trusting either. **Paths written `docs/…` elsewhere in this file
mean the private copy at `../docs/…`**; its redacted twin is `doc/…`.

The machine's Wi-Fi module is an **Ayla Networks `AY008ESP1` (ESP32)**, firmware `DL-millcore`.
It speaks the Ayla IoT protocol, transporting the **same binary ECAM frames** the app uses over
Bluetooth, base64-encoded inside Ayla properties.

## Commands

Uses **pnpm**, Node ≥ 26:

```bash
pnpm install
pnpm dev            # server.mjs with Next in dev/HMR mode, on 0.0.0.0:3000
pnpm dev:next-only  # Next alone, no server.mjs — UI-only work (no machine I/O)
pnpm build          # production build
pnpm start          # production server (= node server.mjs)
pnpm lint           # next lint
node_modules/.bin/tsc --noEmit   # typecheck (TypeScript 7)

# Diagnostics: a standalone LAN-mode server on :3005 that logs VERBATIM everything the machine
# sends — the tool for framing / keep-alive / key-exchange-sequence bugs.
node --env-file=.env.local debug-capture.mjs

# Regenerate the extracted tables from the APK (do not hand-edit their JSON output).
node scripts/extract-catalogs.mjs   # → src/lib/machine-catalogs.json
node scripts/extract-models.mjs     # → src/lib/machine-models.json
```

`pnpm-workspace.yaml` exists solely to **refuse** the install scripts of `@parcel/watcher` and
`@swc/core` (pnpm 11 demands an explicit decision). Nothing depends on them — do not "fix" that
prompt by allowing them.

**lan-server has no test suite.** Protocol changes are validated live against the real machine, not unit tests.
CI (`.github/workflows/ci.yml`) therefore checks what can be checked without a machine: `tsc`,
`node --check` on every `.mjs`, the message catalogue (invalid JSON or an angle bracket in a string),
`pnpm build`, the SQLite store's init/migration, and that the Docker image builds and answers
`/api/status`. On a green push to `master`/`main` it then **publishes `ghcr.io/<repo>:edge`** — so a
bad merge becomes a pullable image, not just a red check. `release.yml` fires on a `v*` tag: multi-arch image to GHCR + a GitHub release with a
Docker-less tarball. `packageManager` in `package.json` pins pnpm for corepack and for the runners.

(The sibling HA repo does have one, runnable with plain pytest and no Home Assistant install:
`cd ../delonghi_coffeelink_ha && pytest tests/`, or a single file `pytest tests/test_monitor.py`.)

Container: `Dockerfile` (multi-stage, `node:26-alpine`, prod deps installed — **not** Next's
`standalone`, whose dependency tracing starts from Next's own server, not our `server.mjs`),
`docker-compose.yml`, and **`DOCKER.md` for every configuration option**. The two
non-obvious ones, both consequences of the inverted roles: `SERVER_IP` must be an address the
machine can reach (never the container's own IP), and the published port must be **the same number
on both sides** — `SERVER_PORT` is what we listen on *and* what we announce in `local_reg`, so
`-p 8080:3000` sends the machine knocking at the wrong door.

**`.env.local` changes require a dev-server restart** to take effect. Copy `.env.local.example`;
the LAN key comes from `docs/secrets.md`. **`MACHINE_DSN` is optional** — see below.

## The Ayla LAN mode protocol (the core mental model)

**Roles are inverted**: our server *hosts* the endpoints; the **machine is the HTTP client** that
connects back to us. Full detail in `docs/analyse-connexion-wifi.md` §7; command frames in
`docs/commandes-cafe.md`. The flow:

1. We `POST http://<machine>/local_reg.json` to announce our `ip:port` (this is the *only* request
   we initiate toward the machine).
2. Machine → `POST /local_lan/key_exchange.json` — establishes an encrypted session.
3. Machine → `GET /local_lan/commands.json` — we serve the queued command (encrypted).
4. Machine → `POST /local_lan/property/datapoint.json` — pushes monitor state to us.
5. Machine → `POST /local_lan/property/datapoint/ack.json` — acknowledges, we drain the queue.

Crypto — `makeSession()` in `server.mjs`, an exact port of the decompiled `AylaEncryption`. (The
`src/lib/crypto.ts` of the same name is one of the shadowed copies: it does not run.)
- Keys derived via double HMAC-SHA256; **"app" keys** encrypt us→machine, **"dev" keys** decrypt
  machine→us (same formula, operands swapped).
- **`lanip_key` is used as the ASCII bytes of the base64 string — do NOT base64-decode it.**
- AES-256-CBC is a **persistent stream** per session (`cipher.update()` never re-initialized);
  a desync forces a new key exchange.

Two hard-won environment gotchas, already fixed in code — do not regress them:
- `local_reg` **must** use `node:http` with explicit `Content-Length`, not `fetch`/undici (the
  ESP32's tiny HTTP server returns 400 to undici's framing, 202 to node:http).
- The key-exchange `time_2` response must be a **JSON number < 2^53**, not a string; `time_1` from
  the machine must be read from the **raw body** (regex) to avoid JS number-precision loss.

## ECAM frame format

`0D <len> <cmd> <flag> <payload…> <crc16>`; `len` = total − 1; **CRC-CCITT init `0x1D0F`** over all
bytes except the last two. Header is `0x0D` in requests / `0xD0` in machine responses. A single
command `0x83` prepares every beverage (beverage id at offset 4, mode/params/profile follow).
`server.mjs` builds these (`frameDispense` and friends); `src/lib/ecam.ts` is the shadowed copy.
`docs/commandes-cafe.md` has the beverage-id and parameter tables.
**Classic** generation (this machine) uses properties `data_request` / `d302_monitor`; the "Striker"
generation uses `app_data_request` / `d302_monitor_machine`.

## Several machines

The server drives **N machines**, each with its own address, LAN key, DSN, model, session, command
queue and read cache. Nothing is shared between them.

**Identity is an id we mint** — `m1`, `m2`… — not the DSN: the DSN is discovered *after* the address
is entered, so it cannot key a machine at creation time. `m1` is frozen: it is what the v1→v2
migration assigns to all pre-existing data, and what the historical env vars still describe.

**Which machine does an API request mean?** The `machine` query parameter, on **every** method
(`pickMachine()` in `server.mjs`); absent → the default machine (`settings.defaultMachine`, else the
first created). An **unknown id is a 404 with `unknownMachine: true`, never a silent fallback** to
the default — brewing on the wrong appliance because a tab held a stale id is not recoverable after
the fact. The parameter is in the query string, not the body, so the `NEEDS_MACHINE` guard can read
it without parsing the body.

**Which machine is CALLING us?** The device-facing endpoints carry **no identity**: the `uri` we
announce in `local_reg` is common to all, and only `key_exchange.json` carries a `key_id`. So
`machineByPeer()` discriminates on the **source address**, the only thing available on all three
endpoints, in this order: (1) a single known machine → it, unconditionally, so a mono-machine
install cannot regress; (2) source address matches the configured or resolved address; (3) source
address was already recognised at a key exchange (`peerIp`). At key exchange only, `machineByKeyId()`
is the fallback — each machine has its own LAN key, hence its own `key_id`; ambiguous ⇒ refuse.
Consequence to keep in mind: **two machines behind the same source address are indistinguishable.**

**Global vs per-machine.** `CFG` now holds only what belongs to the server: `serverIp`, `port`. Per
machine: address (+ DNS cache), DSN (+ its throttle `dsnLastTry` and log dedupe `dsnLastMsg`), LAN
key, model, generation (`send`/`mon`), session, program, import queue, `cmdId`, monitor, keepalive,
active profile, bean/stat scans, OTA requests. The **log is single**, all machines together, each
line carrying `m` — separate logs would have forced the UI to re-stitch a chronology, which is
exactly what one looks at when a command does not go through. The console prefixes `[m1]` only when
there is more than one machine, so a mono-machine terminal is unchanged.

**Env vars describe the FIRST machine only** (`ENV_MACHINE` + `envForced(m, field)`): `MACHINE_IP`
cannot designate two appliances. Never test `process.env.MACHINE_*` inside a per-machine function —
that would let `MACHINE_IP` claim machine 2's address. Everything else is configured in the UI and
persisted per machine in the DB.

**The client must never call `fetch` on `/api/*`** — `mfetch` (`src/app/machine.ts`) appends the
current machine. A bare `fetch` targets the server's *default* machine, which is not necessarily the
one on screen. The selection lives in `localStorage`, deliberately not server-side: a global
"current" would move the page under someone while another tab chose otherwise, and these are
commands that act on a real appliance. `mfetch` also self-heals: a 404 with `unknownMachine` clears
the stored id and reloads (no loop — the next load sends no id).

**`/machines`** lists, adds, renames, sets the default, and deletes. Deleting a machine deletes
**all** its data — `ON DELETE CASCADE` in the schema does it, so there is no table list to keep in
sync here and none to forget when a table is added. `/api/machines*` is handled **before**
`pickMachine` and is not in `NEEDS_MACHINE` — same reason as `/api/lankey`: it is what repairs the
situation.

**Deleting the LAST machine resets it instead of refusing.** The entry cannot leave the registry (no
"no machine" state exists, and an empty DB recreates one at boot), but refusing was the wrong answer:
it sent the user to do by hand what the button should do, and left the read cache in place anyway.
`forMachine(id).reset()` wipes the five tables for that machine in one transaction — address, LAN
key, DSN, model, checksums, props, stats, beans, recipes — the entry survives empty, and the runtime
record is rebuilt with `makeMachine`. In-flight `setTimeout` closures (bean/stat scans) are disarmed
first, or a running scan would keep announcing to the old address on an object no longer in the
registry. The response carries `reset: true`, the `cleared` counts, and **`envRestored`**: whatever
`.env.local` forces comes straight back, and saying so is the difference between "it worked" and "it
did nothing".

**`/cle-lan` no longer exists as a page — it 307-redirects to `/machines`.** Its two settings were
the *selected* machine's, so configuring a second machine meant switching to it first, then leaving
the page you were on: two round trips for one setting. They now live in the card of the machine
concerned, and every request there names its machine explicitly (`forId` in `src/app/machine.ts`,
**not** `mfetch`) — which is what allows configuring one machine without leaving the one you are
looking at. Do not "simplify" those calls to `mfetch`: it would send them to the selected machine.
The `lankey` and `machine` message namespaces are reused verbatim; they were not duplicated. The
config block is **open by default on a machine that is not `ready`** and collapsed on one that is.

**Two entries for one appliance is detected and said out loud.** `machineDuplicates()` flags other
machines sharing the same **DSN** (definitive — it is the serial), or the same configured/resolved
address. Registering the same machine twice (short name, then FQDN) is the natural first mistake,
and it fails **silently**: source-address routing means only one entry ever gets the session, the
other stays mute forever. It happened on the first real use of the page.

**The subscription lives in `src/app/events.ts`, and so does the rule.** `useMachinePush(onChange)`
is what pages use: it holds the marker, exposes `live` / `busy` / `busyRef`, and fires `onChange` on
the two signals that mean "there is something new to read" — `importedAt` moved (every write of read
data goes through `putProp` / `putStats` / `putBeanSystem`, which timestamp it) or a read/program just
**finished** (the moment to re-read even when nothing was written: mute machine, expired window).
Four pages share it (`/machines`, `/beans`, `/profils`, `/statistiques`); each had written its own
version with its own timer. `attendreLibre(busyRef)` waits for the machine to be free by watching an
**in-memory ref** — no request goes out; it replaced a loop that polled `/api/stats` every 1.5 s,
twenty times per range, just to learn whether it could continue. Every page keeps a fallback: if the
stream cannot be established, it polls again, and only while something is running, and says so. The
callback is held in a **ref**: passed as an effect dependency, a function recreated on every render
would close and reopen the connection in a loop. `/beans` uses it with two triggers and no timer:
`importedAt` moving (the machine wrote something — `putBeanSystem` timestamps it) or a read/program
just **finishing** (a scan chains one program per bean, and its end is when to re-read even if
nothing was written). It replaced a `setTimeout(refresh, 6000)` after a read and a
`setInterval(refresh, 3000)` during a scan — two timers that could only be wrong: too early they
showed the previous state, too late they made you wait for nothing.

**State is PUSHED, not polled: `GET /api/events` (SSE).** A property read is not synchronous — the
POST returns as soon as `local_reg` is sent, and the *machine* pushes the value ~2 s later. Polling
meant re-downloading the whole list every 2 s to see one field change, and getting the timing wrong
anyway. **The trigger is the log**: every meaningful state change in this server already goes through
`L()`, so `sseTouch()` hooks there — no instrumenting twenty call sites and no forgetting the
twenty-first. Coalesced over 250 ms (an import logs one line per property). `sseWatch()` covers the
one thing the log cannot say: a window that **expires** without the machine ever connecting writes no
line, so without it the "lecture…" badge would hang forever; it runs only while something is open and
stops after one final broadcast. `fenetreOuverte()` judges liveness on the **duration**, not on the
`active` flag alone — that flag only falls when the machine fetches the next command. `/api/events`
is handled **before** the DSN resolution in `handleApi`: a subscription must not trigger a 4 s probe.
The client (`/machines`) merges pushed state per machine and keeps the object identity of unchanged
ones, so React redraws only the card that moved; it falls back to polling only if the stream fails.
Do not add `Content-Length` or `Connection: close` to that response, and never route it through
`raw()`.

**A machine's first read fires by itself, as soon as it becomes possible.** `maybeInitialRead(m)`
queues the **model** (`d270_serialnumber`) and the **names** (profile names + custom-recipe names,
both name families) the moment the *second* prerequisite lands — key obtained when the address was
already there, or address entered when the key came from the environment. Both are Ayla property
reads, so both need an encrypted session, so neither can be computed when a machine is merely
*added*: at that point you only have its address and the DSN it just gave. The queue is built from
what is **missing**, property by property, so the function is idempotent without a "done" flag and a
machine whose model is known but names are not still gets its names. Pure reads — nothing prepared,
nothing written. It deliberately sets **no** `checksumMark`: replicating `/api/profiles/import`'s
rule here risks marking names fresh when they are not, and a wrongly-set mark suppresses the re-read
until someone passes `force: true` — far worse than one redundant read.

**Each machine gets its OWN catalog**, chosen by its detected model — see the beverage-catalog
section. Two machines of different models are therefore served correctly, as long as both are in
the supported set; a model whose catalog cannot be served falls back to the default one and says so
(banner on `/machines`, warning in the log, `/systeme`).

## lan-server architecture

Next.js 16 App Router, all routes on the **Node runtime** (crypto + machine I/O). Two route groups:

- **Device-facing** `src/app/local_lan/**` — the endpoints the machine calls (dotted folder names
  like `commands.json/` map to literal `.json` paths). `[...rest]/` is a diagnostic catch-all that
  logs any unhandled path.
- **Control API** `src/app/api/**` — `register`, `command` (queue on/off/dispense/stop/clear +
  auto local_reg), `recipes` (CRUD), `status`, `monitor`.

**`server.mjs` is the real entry point, in every mode** (`pnpm dev` = `node server.mjs --dev`).
It serves `/local_lan/*` and `/api/*` itself in raw `node:http` and delegates only the UI pages
to Next — the ESP32 rejects Next's response framing (`vary: rsc,…`). The route handlers under
`src/app/local_lan/**` and `src/app/api/**` are **shadowed in every mode** and kept only for
reference; `/api/beverages*` exists only in `server.mjs`. Never add a device-facing or control
endpoint as a Next route handler alone — it will not be reached.

Those shadowed copies (and the `src/lib/*.ts` modules only they import: `crypto`, `ecam`, `session`,
`program`, `keepalive`, `machine`, `recipes`, `config`) had silently drifted into holding the exact
regressions this file warns against — a `0xA9` heartbeat in `program.ts`, beverage ids 14/17–21 in
`ecam.ts`, `progress` in the monitor. Four of them carry a "does not run" banner and match
`server.mjs` (`ecam`, `session`, `program`, `recipes`); `crypto`, `keepalive`, `machine` and
`config` still do **not** — add the banner if you touch one, and never read them as current.
**On any divergence `server.mjs` wins**; a fix applied only to the `.ts` copy changes nothing at
runtime. They remain a duplicate implementation, so deleting them is a live option.

UIs: `/` (beverage catalog, power toggle, global stop, and a row of named profile buttons where one
click both selects and activates the profile — the landing page; **only profiles the user actually
renamed are listed**, factory names like "Profil 4" are filtered out via the `renamed` flag from
`/api/profiles`. Each beverage's details panel is an **editable** recipe editor for the active
profile: sliders bounded by the model's min/max, seeded from the profile's stored values, with
"prepare with these values" and "write into the profile"). The editor offers **two distinct resets** — do
not merge them: "↺ réinitialiser" returns to the profile's stored values, "⟲ valeurs par défaut"
returns to the **model's** defaults (per-parameter chips do the same for one line). A parameter whose
`def` falls outside `[min,max]` (0 or 255 = never configured, e.g. the travel mug's coffee/milk/water)
has **no** default to offer: it is labelled "pas de défaut" and left untouched by the global button
rather than forced to `min`. Both resets are local — nothing reaches the machine until "Préparer" or
"Écrire"), `/profils` (imports profile names/icons, favourite order, custom-recipe names, and
lists **all** profiles including factory-named ones), `/pilotage`
(dashboard: on/off, live monitor, log), `/recipes` (custom recipes, **constrained by the model's min/def/max bounds** — the `0xB0` bounds are
model characteristics shared by all 5 profiles, so a profile may only pick a value inside them; the
page shows them and clamps inputs, shows the profile's stored value beside them, and can **write a
recipe into a profile on the machine** — `0x83` with mode `DONTCARE` + action `SAVE_BEVERAGE`, a
persistent device write), `/statistiques` (usage counters: the
10 identified ones with labels and unit conversion, the 52 unlabelled ones raw, and buttons that
read them — 3 range requests for the known set, 8 for a full sweep, exploiting the fact that the
machine enumerates), `/machines` (**every machine's configuration, in place** — see the
multi-machine section: the two prerequisites of any control, in dependency order, inside the card of
the machine concerned: its **address** — entered, probed and stored, no default anywhere — then the
LAN key's state (`set`/`keyId`/`source`/`cachedAt`, never the key), its discovery from the De'Longhi
account, and forgetting the cached key),
`/systeme` (technical sheet: firmware, OTA, module, Ayla
platform, model, protocol state, security findings). `/boissons` 307-redirects to `/`, and
`/bean-adapt` to **`/beans`** — the beans page moved, the old URL stays alive for open tabs.

**`/beans` shows TWO lists, both as card grids.** The machine's six Bean-System slots, and a
**local library** of remembered configurations (`meta.beanPresets` per machine, `GET`/`POST`/`DELETE
/api/beanpresets`). The library exists because the machine has only six slots — one of which is not
a coffee — and overwriting one loses the previous setting: you cannot try a grind and go back.
Nothing there is sent to the machine; writing a remembered config into a slot goes through
`/api/beanadapt/save` (`0xBB`, persistent) with a confirmation that names the slot being overwritten,
and slot 0 is excluded from the targets. Bounds are checked **on save**, not only on write: storing a
setting that cannot be applied would only fail later, far from where it was typed. `machineSummary`
carries `beanPresets` (a count) because `setMeta` deliberately does not touch `importedAt` — without
it a second tab would never learn the library changed. Presets live in `meta`, not a table: a few
rows, and a table would have cost a schema version for an array of five entries.

Each beverage card also shows its **category** usage counter (see the statistics paragraph); the
per-beverage "all parameters" table that used to sit in the details panel was **removed on request**
— the recipe editor above it already shows every setting with its bounds, default and profile value,
so the read-only duplicate added nothing. The technical panel keeps what is not visible elsewhere:
the Ayla property names and the raw frame.

**The DSN is discovered, not configured.** `GET http://<machine>/regtoken.json` returns
`host_symname`, which *is* the DSN — no auth, no cloud. `resolveDsn()` in `server.mjs` resolves it
from, in priority order: `MACHINE_DSN` in `.env.local` (an explicit override always wins), the
machine itself, then the local cache (`restoreDsn` reads `meta.dsn`, so a restart works while the
machine is unreachable). It is probed at boot with `compare: true`, which logs a warning when an
explicit `MACHINE_DSN` disagrees with the machine, and lazily in `handleApi` while still unknown —
the DSN goes into every property payload we serve. **Never hardcode the serial as a fallback**: it
is device data and belongs in `docs/secrets.md`, not in code. `/api/status` and `/api/system` report
`dsnSource` so the UI can say where the value came from.

**The LAN key can be discovered too, on demand, from the De'Longhi account** — `POST /api/lankey`
with `{email, password}` (or `{jwt}` to skip Gigya). Four hops, all verified against the real
servers: Gigya `accounts.login` (**eu1** — `us1` answers `301001 served by another data center`) →
`accounts.getJWT` (`login_token` → `id_token`) → Ayla `token_sign_in.json` (JWT + app_id/app_secret
→ `access_token`) → Ayla `dsns/<DSN>/lan.json` (→ `lanip_key` + `lanip_key_id`).

**Never send `targetEnv: "mobile"` to `accounts.login`.** Probed side by side on the real servers
with the same account: `targetEnv=mobile` returns `sessionInfo = {sessionToken, sessionSecret,
expires_in}`, the default (browser) returns `sessionInfo = {cookieName, cookieValue}`. A *mobile*
session is an OAuth1 session — its `sessionToken` is meant to **sign** subsequent requests, it is not
a `login_token`; passing it to `accounts.getJWT` answers `Unauthorized user [403005]`, while
`cookieValue` yields the `id_token` immediately. This is what made discovery fail while the Android
app worked (the app signs, through the mobile Gigya SDK). Read **only** `sessionInfo.cookieValue`:
the old `?? sessionInfo.sessionToken` fallback rescued nothing, it forwarded a wrong-typed token
instead of failing with a clear message. `403042 invalid loginID or password` is the unrelated,
literal case — bad credentials. Priority is
`LANIP_KEY` in `.env.local` > the local cache (`meta.lanKey` in `data/lan-server.db`, written by a
discovery) > this flow.

**The static APK values it needs are in the repo, not in `.env.local`** — `src/lib/cloud-app.json`
(Gigya api key + datacenter, Ayla app_id/app_secret, the two Ayla base URLs), loaded into `APP` in
`server.mjs` with each value still overridable by its env var. They are **not secrets**: identical
for every user, readable in a public binary, and powerless without an account's credentials — making
users type them protected nobody and just made discovery unavailable to anyone who did not have them
at hand. The file also records the manifest's alternate Gigya keys (`API_KEY_EU_US`, `API_KEY_CH`)
for a non-European account. `GET /api/lankey` still reports `missingConfig`, now normally empty — it
only fills if that file was gutted or a var set to the empty string. What stays secret is unchanged:
the LAN key (in the DB), the account password (never stored), `AYLA_TOKEN`.

The UI for it is **inside each machine's card on `/machines`** — deliberately not `/systeme`,
which is a read-only technical sheet where a credentials form has no place. `/systeme` says
**nothing** about the LAN key beyond what its "Protocole et réseau" block already renders
(`protocol.lanKeySet` / `lanKeyId` / `lanKeySource` from `/api/system`): the pointer card that
briefly sat there was removed on request, the nav already leads to the page. Do not re-add a
`system.lanKey*` key — the messages live in their own `lankey` namespace, which `/machines` reuses
verbatim rather than duplicating forty strings.

**Without a LAN key, write endpoints refuse instead of pretending.** `NEEDS_MACHINE` in
`server.mjs` lists the endpoints that queue a frame only an encrypted session can carry; a **POST**
to one of them returns **409** with `needsMachineIp: true` or `needsLanKey: true` (checked in that
order) and a plain message. This is not
cosmetic: the machine would connect, get a 412 at key exchange and leave, so the command was
accepted and silently lost while the UI announced "sent". **GET stays served** — the cache read
earlier must remain browsable without a key. `/api/lankey` is deliberately **not** in the list, in
either method: blocking it would make the situation unrecoverable. Both `/` and `/pilotage` show one
shared banner (`common.noLanKey` + a link to `/machines`) when `status.config.lanKeySet` is false, and
`/pilotage` now reads its command responses — it used to `await fetch(...)` and drop the result, so a
refusal was invisible there.

**`SERVER_IP` has no default either, for the same reason as `MACHINE_IP`.** It is the address we
*announce* in `local_reg`, so a loopback fallback can never work — the machine would connect to
itself — while making an unconfigured server look configured: `local_reg` answers 202, the queue
fills, the UI says "sent", and the session stays "en attente" forever. That is exactly how a
container deploy failed. `serverIpProblem()` in `server.mjs` judges it (unset, `127.0.0.0/8`,
`0.0.0.0`, `::1`, `localhost`); `postLocalReg()` refuses to send, the POST guard returns **409 with
`needsServerIp: true`** alongside `needsMachineIp` / `needsLanKey`, boot logs a warning that lists
the non-loopback addresses seen locally, and `/` and `/pilotage` both show a banner
(`common.badServerIp`) while `/pilotage` marks the announced-address row. The boot hint says plainly
that in a bridge container the useful address is the **host's**, not the container's — copying
`172.17.x.x` reproduces the same failure.

**The machine's address has no default and is entered in the UI.** `m.ip` comes from
`ENV_MACHINE.ip` (i.e. `MACHINE_IP`) for the first machine and is `null` otherwise — **never** a
hardcoded IP: one would be somebody else's
configuration and would make an unconfigured server look configured while talking into the void.
Priority mirrors the DSN and the LAN key: `MACHINE_IP` in `.env.local` > `meta.machineIp` in the DB
(written by the UI) > nothing. The **`/machines` page** carries both prerequisites, address first,
in the card of the machine concerned (`GET`/`POST`/`DELETE /api/machine` for it — the endpoints kept
their singular name, and take `?machine=`); a `POST`
validates the host (IPv4 **or** hostname, and a hostname survives a DHCP lease change), saves it,
then **probes `regtoken.json` immediately** and re-resolves
the DSN, so a saved-but-mute address is reported at once instead of being discovered at the first
failed command. Changing the address drops `m.session` **and** the cached DSN (it is the previous
appliance's serial) unless `MACHINE_DSN` forces one. The two settings share one page **because the
dependency is real**: Ayla files the key under the DSN, and the DSN only comes from the machine — so
the key cannot be fetched before the address is known. Once the DSN is cached the discovery no
longer needs the address (verified: with the address cleared but `meta.dsn` present, the flow ran
past the DSN gate all the way to Ayla). There is no `/machine` route; it briefly existed and was
merged on request. `probeRegtoken()` and `postLocalReg()` both
short-circuit when the address is unknown rather than letting `node:http` dial a null host.

**The module refuses any `Host` header that is not its own IP** — it answers a `404 - Page not
found` HTML page. Measured side by side, same destination, only the header changing: `192.168.x.x`
+ `Host: cafe` → 404, `cafe` + `Host: 192.168.x.x` → 200. So a hostname IS usable (and preferable —
it survives a DHCP lease change) but only if **we resolve it ourselves** and put the IP in `Host`.
`machineTarget()` in `server.mjs` does that, with a 60 s cache (a `local_reg` fires every 2.5 s
during a program) invalidated whenever the address changes; `probeRegtoken()` and `postLocalReg()`
both go through it. Do not "simplify" it back to `host: m.ip` — that sends `Host: <name>`
and breaks every request to the machine. This is a vicious diagnostic trap: the 404 comes back fast
and looks like another server answering, which is exactly the wrong conclusion it once produced
("cafe is not the machine" — it was). In a container add `extra_hosts` or `dns_search`: a short name
does not inherit the host's DNS search domain, hence `getaddrinfo ENOTFOUND`. See
`docs/analyse-connexion-wifi.md` §1.2.

**The nav hides the key-dependent pages when there is no key.** `src/app/Nav.tsx` (a client
component; the layout stayed a server component) holds the entry list with a `needsMachine` flag and
filters on `/api/status`, read through `mfetch` so the judgement is about the **selected** machine:
an entry is hidden unless **both** prerequisites hold (`config.machineIp` set *and*
`config.lanKeySet`). Only `/machines` and `/systeme` survive — `/machines` because it is what fixes
**both** prerequisites *and* how you switch away from a misconfigured machine (hiding it would leave
no way back), `/systeme` because it depends on neither. The nav also
carries the machine selector, fed by the `machines` array that `/api/status` now returns — so it
costs no extra request — and shown only from two machines up. **Hidden pages are still served**: a
hand-typed URL shows the cached data plus the banner. We remove the invitation, not the access.
Two details not to regress: the unknown state (`lanKeySet === null`, and any fetch failure) shows
**everything**, because defaulting to hidden would flicker the menu on every load in the normal case;
and
`/machines` dispatches a `lankey-changed` window event after changing either prerequisite, which is
the only way the menu can come back without a full reload — navigation is plain `<a href>`, so every
other page change rebuilds the nav anyway.

Non-negotiable for this feature: **the password is never logged, stored, or returned** (it exists
only as a parameter for the duration of the request), **no endpoint ever returns the LAN key**
(`/api/lankey` and `/api/status` expose only `set`, `keyId`, `source` — the key id is not a secret,
it travels in cleartext in the key exchange), and **local control must never depend on any of
this**: the flow is opt-in, and once the key is cached nothing calls the cloud again. Changing the
key drops `m.session`, since the live session was derived from the old one.

`/systeme` is fed by `GET /api/system`, which mixes three clearly-labelled sources: a **live** probe
of `http://<machine>/regtoken.json` (the only endpoint the module serves outside AP mode — all the
others 404 in normal operation), the **frozen** cloud device sheet in `src/lib/device-sheet.json`
(non-secret fields only; personal ones stay in `docs/secrets.md`), and our own protocol state. OTA is
reported from the local side: in LAN mode the **machine fetches the image from us**
(`/ota_status.json`), so requests recorded in `m.otaRequests` are the only local OTA signal.

**The Ayla token is minted on demand, and the cascade picks the cheapest route** (`aylaToken()`):
(1) the access token still held **in memory** for this machine — no network at all; (2) a stored
`refresh_token`, if the user opted in — one call to Ayla, no Gigya, no password; (3) account
credentials — the full four hops; (4) `AYLA_TOKEN`. Level 1 never survives the process, by design.
**Level 2 is the only account-level secret this server can write to disk**, so it is opt-in
(`remember: true`), labelled as such in the UI, stored in `settings.aylaRefresh` (global — it is an
account credential, not a device's), never returned by any endpoint, forgettable via
`DELETE /api/cloudsession`, and cleared by "Tout effacer". The LAN key only grants local control of
one appliance and only from the network; a `refresh_token` acts on the De'Longhi account until
revoked — do not blur that difference. Ayla **rotates** the refresh token on each use, so keeping the
old one would break the next call. A failed refresh **forgets** the stored session: keeping a token
that may be worthless only defers the password prompt and makes it incomprehensible. Refresh path and
body shape (`{ user: { refresh_token } }`) are verified against the real deployment — a bogus token
answers `401 Your refresh token is not found`, an application-level reply where a wrong path would
have 404'd; only the happy path is still unexercised.

**Whether an update EXISTS can only be known from the cloud**, and no longer requires `AYLA_TOKEN`.
`aylaAccessToken()` — extracted from `discoverLanKey`, because two things need it — turns account
credentials into an Ayla access token; `checkCloudOta()` reads `dsns/<DSN>/ota.json` with it. The
LAN-key discovery now takes that reading **on the way past** (same token, best-effort: a failure
there must never fail the key discovery, which is the point of the call), and `POST /api/ota` repeats
it on demand — credentials first, `AYLA_TOKEN` as the fallback. **Only the result is stored**
(`meta.otaCheck`), never the token: opening a page must trigger no cloud call, and nothing must
remain that could trigger one later. `GET /api/system` therefore only *reports* the stored reading —
it used to probe the cloud on every page view, which for a local-control project was the wrong
default (and it cost up to 8 s per load; now 0.27 s). The action lives on `/machines`, next to the
credentials it reuses; `/systeme` shows the reading, on **one** line — it used to print "désactivée"
and then a sentence ending in "vérification cloud désactivée".

`/` has **no bulk-import block** (removed on request). Beverage settings are re-read one at a time
with the per-card "Lire" button; `POST /api/beverages/import` still accepts a full-catalog import if
a bulk entry point is ever needed again.

**Beverage display order** — `/` lists beverages in the **machine's own order** for the active
profile, taken from `d{260+p}_{p}_rec_priority` and exposed as `order` by `/api/beverages`. The
category grouping (Cafés, Boissons lactées…) is our own invention and is only the fallback when
that order has not been read. Activating a profile queues a re-read of its order property, so the
list cannot show a stale order.

**Beverage names** — a custom slot renamed on the machine must show under that name everywhere.
`readNames(store, kind)` / `machineBeverageNames(store)` in `server.mjs` are the single source, used
by both `/api/profiles` and `/api/beverages`; the latter overrides the catalog label and keeps
`catalogLabel` / `machineName` / `machineNameProp` for traceability. Do not re-read the name blocks
locally in a new endpoint — that divergence is what once made `/` show "Recette perso 1" while
`/profils` correctly showed "Lacteso". The Bean System slot (id 200) is NOT covered: its name comes
from the bean-system data (`0xBA`, 40-byte UTF-16), not from the recipe-name properties.

**Beverage catalog — per model.** `src/lib/beverages.mjs` (plain ESM so `server.mjs` can import it)
over `src/lib/machine-catalogs.json`, extracted from the APK's `assets/MachinesModels.json` for all
30 connected models (`node scripts/extract-catalogs.mjs`). `catalogFor(modelKey)` returns that
model's list; `m.catalog` holds it per machine. The machine is **never asked which beverages it
supports** — that list is static, per model; the machine only supplies values.

**The property numbering does NOT depend on the model**, and that is what makes switching safe. It
is a frozen De'Longhi namespace, keyed by beverage *name*, read out of `p258z7/z.java`:
`v()` gives `(profile − 1) × 21` plus a **fixed** offset per slug (rec_espresso + 39 … +
rec_brew_over_ice + 59); `t()` gives `(profile − 1) × 6` + 160…165 for the bean-system recipes;
bounds are `d001_rec_espresso` … `d021_rec_brew_over_ice` in the same order. Two consequences worth
keeping straight: **the 21 is a constant of the app, not the model's recipe count** (an earlier
version of this file asserted the opposite and refused to switch catalogs on that basis — the
inference was wrong), and switching a catalog **invalidates no cached read**, since names never move.
Custom recipes are `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06` with **profile 1 hard-coded**:
the app writes those names literally and has no builder that varies the profile, so asking for
`d200_2_…` would be inventing a name.

What the table supports, and it is not everything — say so rather than guessing:
- **10 models** (5 PD_SOUL of 28 beverages, 5 PD_SOUL_BETTER of 22, 3 profiles, 3 custom slots) are
  fully addressable. `support: "classic"`.
- **7 STRIKER_BEST** list 48 beverages including the `iced` (50-56) and `mug` (80-86, 100-107)
  families, which go through the *other* naming (`d%s_rec_%s_…`, stride 43) — not implemented and
  not verifiable without such a machine. Their catalog is served with those ids flagged
  `unaddressable`: listed, neither readable nor settable.
- **13 STRIKER_GOOD** have an **empty** recipe list in the table; the app gets theirs elsewhere.
  `catalogFor` falls back to the default model and `applyCatalog` says so.

**The generation is derived from the model too**, faithfully to the app: `p258z7/s.r()` returns true
when the `appModelId` *contains* "striker", case-insensitively. It decides the transport properties
(`data_request`/`d302_monitor` vs `app_data_request`/`d302_monitor_machine`), so defaulting to
`classic` on a Striker means talking into the void. Derived from the **detected** model, not from the
catalog: when the catalog is a stand-in (a Striker with no recipes), the catalog belongs to another
model and would say `classic`. `MACHINE_GENERATION` still wins, and only for the first machine.

**The model itself IS asked, though — and locally.** `src/lib/machine-models.mjs` +
`machine-models.json`: the machine publishes property **`d270_serialnumber`** (response command
**`0xA1`**, no other known use), whose ASCII serial starts at byte 6 and whose **characters 1–5 are
exactly the key that indexes the manufacturer table** (`product_code.slice(-5)`). That is how the
official app does it (`DeLonghiWifiConnectService.l1()` → `DefaultsTable`), so no cloud, no token, no
account. Verified live on the real machine: `D17055XX` → `17055` → ECAM 610.75.MB / PD_SOUL (the
last two characters come from the serial — markered here, like everything device-specific). `docs/commandes-cafe.md` §13
has the frame layout and the derivation. `POST /api/model` asks for the read (a **read** — nothing is
prepared or written), `GET /api/model` reports, `/systeme` shows it and warns on mismatch, and
`MACHINE_MODEL_KEY` forces a value (priority mirrors the DSN: var > `meta.model` cache > machine).
The identification table holds the **30 non-Bluetooth** models of the 117 in the table, keyed by
those 5 characters, and deliberately **without recipes** — the active catalog stays
`machine-catalogs.json` — that table identifies models, this one holds their catalogs, and mixing
the two would give two sources of truth for the same thing. Regenerate with
`node scripts/extract-models.mjs`.

**The detected model DOES switch the catalog** — `applyCatalog(m)`, called from `applyIdentity`,
`restoreModel` and at boot. `matchesCatalog: false` no longer means "the catalog is probably wrong",
it means "the detected model's catalog could not be served and a stand-in is in use"; the UI wording
follows. A real defect this uncovered: the bean-system profile property had **no stride** —
`d160_<p>_bs_recipe_01` for every profile, a name that does not exist for p ≥ 2. The read answered
empty and was filed as "absent on this model", so the Bean Adapt recipe of profiles 2-5 was
unreadable and nothing said so.

`d270_serialnumber` is routed **by exact name**, before the command-byte switch: `0xA1` has no
decoder (it would fall into `default` and stay "non décodée"), and the app itself parses the value
positionally without looking at that byte. Exact name, never a pattern — pattern routing
(`_beansystem` → recipe decoder) is what once produced the misalignments. Beverage ids are NOT contiguous
(no 14, no 17–21; tea = 22, cortado = 24, brew over ice = 27) — see `docs/commandes-cafe.md` §2.
Recipes are read back with two distinct frame formats: `0xB0` = min/def/max quads,
`0xA6` = per-profile values (§6). Recipes **are** per-profile on the machine: read via
`d{39+i+(p-1)*21}_{p}_rec_*`, written via `0x83`/`SAVE_BEVERAGE` with the profile in
`(profileId << 2) | action` (§1.3). Dispensing a drink whose `INVERSION (12)` param is 1 (flat white,
cappuccino reverse, cortado, long black on this model) must use action `PREPARE_BEVERAGE_INVERSION`
(6), not 2 (protocol doc, dispense section). A parameter whose `min == max` (e.g. flat white's
INVERSION, always 1) is not adjustable but **must still be sent** — it is what selects the
inversion action. Both editing UIs show it read-only and keep it in the payload.
- **Never filter recipe parameters on `kind`.** That field is our own grouping hint, not part of the
  protocol. A parameter is adjustable iff `max > min`; its start value is the profile's stored value
  when in range, else the model default when in range, else `min`. Filtering on `kind === "user"`
  plus "default within bounds" once hid real options — including the travel mug's coffee, milk and
  hot water, whose defaults are 0 because they were never configured.

Reads happen in pure LAN via an Ayla `property.json?name=` command served in `commands.json` — no
cloud, no token.

**Cache validation** — response `0xA3` (`decodeChecksums` in `profiles.mjs`) returns one 16-bit
checksum per profile's recipe quantities plus one for custom recipes and one for names. One 6-byte
request (`0D 05 A3 F0`) tells you whether anything changed, instead of re-reading 21 properties per
profile. `POST /api/checksums` asks, `GET /api/checksums` reports current/previous/changed/stale, and
`POST /api/profiles/import` skips name reads when the names checksum is unchanged (`force: true`
overrides). The checksums do **not** cover favourite order. `size` is not in the frame — derive it as
`(len - 9) / 2`. See `docs/commandes-cafe.md` §9.

The "up to date" marker (`checksumsAtImport`) is written by `applyChecksumMark` **at the end of an
import**, and only for the families that import actually read — never at send time, and never for a
family it did not queue. Writing it eagerly (the original code) made a *failed* import claim the
names were fresh, and made a `what:"order"` import — which reads no name at all — mark them fresh
too; both then permanently skipped the name re-read, recoverable only with `force: true`. A property
absent on this model counts as read, not as a failure; a property that never answered blocks the
marker.

**Usage statistics** — command **`0xA2`** (`0D 08 A2 0F <idHi> <idLo> <qty> <crc>`, flag `0x0F`),
response `D0 <len> A2 0F` + n×(16-bit BE id, 32-bit BE value), `n = (len-5)/6`, **capped at 10
entries** per reply. `POST /api/stats` requests (`ids[]`, or `from`+`qty`), `GET /api/stats` reads
back; values land in that machine's `stats` table (`m.store.allStats()`). Two things not to relearn the hard way: the friendly Ayla
properties (`d7xx_tot_*`, listed in `p258z7/w.java`) **return nothing** on a plain property read —
same trap as the Bean Systems, the ECAM command is mandatory; and **the machine enumerates** — an
id that does not exist yields the next existing ones, skipping gaps, which is how the whole space
was mapped (62 parameters here: 1xx, 3xxx, 23xxx, 43xxx). A `23000` reply to a request for 3047 is
*not* an error sentinel. 10 ids have an **established** meaning, read out of
`p018b7/e.java` where they are bound to the `p258z7/w.java$a` category enum (105 descales, 106 water
in 0.5 ml units → litres = /2000, 108 filters, 115 milk cleans, 3000 no-milk drinks, 3001+3003
hot-milk drinks, 3017 cold-milk (Maestosa only), 3021 choco, 3025 tea); `STAT_MEANINGS` in
`server.mjs` holds them. The other 52 are unknown — do not guess.

**The machine counts by CATEGORY, not per beverage.** There is no "number of espressos": espresso,
long coffee, doppio+ and americano all feed `3000`. Tea is the only drink with its own counter
(`d719_id22_tea` confirms it — 22 is tea's catalog id). `/api/beverages` therefore attaches
`counter` with `scope: "category"`, and the card labels it as a category total; never present it as
a per-cup count. See `docs/commandes-cafe.md` §12.

**Profiles** — `src/lib/profiles.mjs`. This machine is **not "Striker"** (`isStriker = false` in
the logcat), so profile/custom-recipe names come from `d034_profiles_1_3` / `d035_profiles_4_5` /
`d036_recipe_custom_name_1_3` / `d037_recipe_custom_name_4_5`, decoded with `J0()` semantics
(**stride 21**, not `K0()`/22 — that's the Striker path). Names are UTF-16 **big-endian**, and the
entry count comes from bytes 4–5 of the frame (first/last index), NOT from the frame size — the
block may leave a spare byte before the CRC. Zero padding is stripped in **2-byte units**, never
byte by byte: a name ending in a U+xx00 character left an odd-length buffer and `swap16()` threw,
which lost the **whole** name block, not just that name. Favourite order per profile is
`d{260+p}_{p}_rec_priority`. See `docs/commandes-cafe.md` §8.

**Protocol detail belongs in the journal, not in a confirmation.** No UI message carries a frame any
more: five of them read like "Écriture envoyée — trame 0d 33 bb f0 …", which tells the user nothing
about whether their setting went through — it shows them bytes. The information is precious in
diagnosis, so it did not disappear: `startProgram` logs one line carrying everything — the human
label, the **operation** the frame represents, and the bytes. `ECAM_OPS` + `describeFrame()` name it
(`nature · nom (0x..)`, nature being the verb: lecture / écriture / action), and `0x83` is refined by
its **mode byte** because the same command prepares a drink, stops one, and **writes a recipe into a
profile** — the last one being the persistent write, labelled `écriture`. The frame's trailing 4
timestamp bytes are stripped, or the log would show four bytes that are not part of the command.
`frameHex` stays in the API responses (useful from curl); no page reads it.

Session and command state live in the **per-machine records** of the `MACHINES` map in
`server.mjs` — see § *Several machines*. (`src/lib/session.ts`, which describes a single
process-global singleton guarded on `globalThis`, and `src/lib/config.ts` are shadowed copies from
before the multi-machine refactor: they do not run, and they no longer describe the design.)

## Storage — SQLite (`src/lib/store.mjs`)

Everything persistent lives in **one SQLite file**, `data/lan-server.db` by default, through the
built-in `node:sqlite` (`DatabaseSync`). **Schema v2 carries the machine dimension**: every data
table has a `machine` column and a composite primary key, with
`REFERENCES machines(id) ON DELETE CASCADE`; settings that belong to no machine live in their own
`settings` table rather than under a sentinel machine, which would have made the foreign key lie.
The v1→v2 migration recreates the tables (SQLite cannot alter a primary key) and attaches every
existing row to `m1` — the only possible reading, since a v1 base could only describe one machine —
in a single transaction, so a crash leaves it in v1 and retryable. **CI plays that migration on a
purpose-built v1 base**: it is the one operation in this project that can destroy a user's data. Its location is configurable — `DATA_DIR` (directory for all
persistent state, and where the migration looks for the old JSON files) and `DATABASE_FILE` (full
path of the DB itself). The container sets `DATA_DIR=/data` and mounts a volume there. It replaced three JSON files — `machine-beverages.json`,
`recipes.json`, `lan-key.json` — which the module **migrates on first boot** and then renames to
`*.json.migrated` (kept, not deleted, so the pre-migration state is still there). `PRAGMA
user_version` gates that: a restart does not re-migrate.

Tables: `machines` (`id`, `createdAt`, `data` JSON with the label), `props` (one row per Ayla
property: `machine`, `name`, `at`, `kind`, `data` JSON of the rest), `bean_systems`, `stats`
(`machine`, `id`, `value`, `at` — real columns), `recipes`, `meta` (JSON values keyed by
`(machine, name)`: `dsn`, `machineIp`, `model`, `activeProfile`, `checksums`, `checksumsPrev`,
`checksumsAtImport`, `importedAt`, `lanKey`) and `settings` (global, currently `defaultMachine`).
All `STRICT`, so a wrong-typed value is refused at write time instead of surfacing as `NaN` in a
page months later.

**Why it changed**: the old code did `readMachine()` → mutate → `writeMachine()`, i.e. re-serialise
the **whole** 80 kB cache for every single property received — ~60 times per import, 4.9 MB rewritten
to change 58 rows. Writes are now one-row upserts in their own transaction, so their cost no longer
depends on the size of the cache (measured: 4.0 ms/property *with* fsync, vs 5.9 ms without).

- **All data access goes through `forMachine(id)`**, which returns the API bound to one machine.
  There is deliberately **no machine-less version** of these functions: a call that forgot to say
  which machine would write into the wrong one, and nothing would signal it for weeks.
- Write through the targeted helpers — `putProp`, `putStats`, `putBeanSystem`, `putChecksums`,
  `setMeta`, `putRecipe` — **never** by reading a whole view and writing it back. `machineView()` is
  a **read-only** assembly for endpoints that walk everything (`/api/beverages`, `/api/profiles`);
  to read one value use `getProp` / `getMeta` / `countStats`.
- `putChecksums(cs)` shifts the previous reading into `checksumsPrev` and returns `{prev, current}`
  in one transaction — that couple is what says what changed, it must never be half-written.
- `journal_mode = WAL` + `synchronous = FULL`: the write volume is tiny, so full durability is free.
  A crash can no longer leave a truncated cache (the old failure mode: `readMachine()` swallowed the
  parse error and silently restarted from an **empty** cache, losing the whole import).
- `importedAt` is bumped **only** by machine-data writes. The old `writeMachine()` bumped it on
  every write, so merely saving the active profile moved the "read on" date the pages display.
- `/api/system` reports `storage` (engine, schema version, journal mode, row counts, size) and
  `/systeme` shows it.
- ⚠️ **`data/lan-server.db` is secret material**: it holds the LAN keys (`meta.lanKey`, one per
  machine), the serial numbers and the profile names typed on the machines. Never attach it to a bug report. `data/` is
  gitignored as a whole, `-wal`/`-shm`/`.migrated` included.
- `src/lib/recipes.ts` (shadowed, does not run) still describes the JSON file. It now carries a
  second banner saying so — it would write a file nothing reads.

**Current status is tracked in `ETAT.md`** — read it before continuing LAN-server work. Its title
date (2026-08-19) is stale: the file has been appended to well past it, so trust the last sections,
not the heading.
Summary: end-to-end local control **works** against the real machine (on/off confirmed, live
monitor decoded); importing the beverage catalog works (28/28 properties decoded exactly); importing
profiles works (5 names + icons, 5 favourite orders, 6 custom-recipe names). **Profile activation is
proven** — `0xA9` demonstrably moved the machine from profile 3 back to profile 1, which is how the
heartbeat bug was found. Still unexercised on the appliance: **dispensing** a beverage, the **stop**
command, and a second machine of a different model.

**Monitor bytes 5–6 are the sensor bitfield, not a "progress" value** (byte = `5 + group`; 256 =
group 1 bit 0 = milk carafe connected, confirmed on the machine's own display). `/api/*` exposes it
as `switchBits`; nothing emits `progress`. The `/systeme` page still read `lastMonitor.progress` long
after the rename and printed "progress undefined" — if you rename a monitor field, grep the pages.
The alarm bitfield is `byte 7 | 8<<8 | 12<<16 | 13<<24`, and byte 13 must be **multiplied** by
`0x1000000`, not shifted: `0x80 << 24` is negative in JS and published a signed bitfield.

Two behaviours that took a long time to find — do not regress them:
- Our HTTP responses must carry `Content-Type` + explicit `Content-Length` and **no
  `Connection: close`**: the ESP32 chains key_exchange → commands.json on the same keep-alive
  connection, and closing it means the command is never fetched.
- A wake/command must serve `device_connected` (fresh unix seconds) **first**, then the ECAM
  frame, then sustained presence during boot, with `local_reg` re-posted every 2.5 s.
- **The heartbeat must be a read, not `0xA9`.** `0xA9` **is** PROFILE_SELECT, not a no-op: using
  it as sustained presence silently imposed a profile on the machine (a mere checksum request once
  moved the machine from profile 3 back to profile 1). `startProgram(..., sustain)` now defaults to
  a **monitor request** `0D 05 75 0F` (pure read); `sustain: "profile"` is reserved for the wake
  program (where the `0xA9` spam is the validated recipe) and for profile selection itself, where
  re-asserting the same value is idempotent. Any new command that targets a profile must also set
  `m.activeProfile`.
- Opening a page calls `POST /api/presence`, which posts `local_reg` and serves a monitor request so
  the machine pushes fresh state. It is **throttled server-side** (recent monitor, program already
  running, or called <15 s ago → skipped), so several tabs cannot spawn several sessions.
- `m.activeProfile` is a *request*, not an observation: we cannot read the machine's current
  profile (candidate property `d286_mach_sett_profile`, encoding unverified). It is persisted to `meta.activeProfile` and restored at
  startup so a restart does not silently claim profile 1, and `/api/status` also returns `activeProfileConfirmed` — false until we have
  actually imposed a profile this session. The UI highlights no profile while unconfirmed rather
  than claiming profile 1.

## Bean Adapt

`src/lib/bean-adapt.mjs` **reimplements the adjustment rule locally** — the official app posts the
questionnaire to De'Longhi's backend (`getBeanSystemAdv.sr`) and writes back what it returns. The rule
was derived by sweeping that API (`docs/bean-adapt.md` section 4) and is reproduced here; the
reference matrix verifies **9/9**. No cloud call.

- Grinder 1-7 and aroma 1-5 are **backend-verified** bounds. Temperature has **none**: the backend
  returns 0 for `temperature_in = 0`, so the floor stays 0 to match the reference matrix; the ceiling
  of 5 is our own prudence and the UI labels it as unverified. Do not "tidy" that floor to 1 - it
  would diverge from the reference.
- Where the backend **fails** (flow time 10-19 with neutral taste, a nominal case) our local rule
  simply returns the values unchanged.
- Reads use `0xBA` — **53 bytes**: name 40 bytes UTF-16BE at offset 5, grinder/temp/aroma at
  45/46/47, byte 49 = not-deleted, **byte 50 = the ACTIVE bean** (only one profile has it set;
  verified against the machine's own display). That extra byte is why the read frame is one longer
  than the write frame, and why **`0xBB` cannot select the active bean** — `0xB9` does.
- **`d(250+n)_beansystem_n` is empty until the matching `0xBA` command is sent.** Reading the
  property alone returns nothing and makes the profile look absent. One command per bean; use
  `POST /api/beanadapt/scan` to walk the list.
- Writes use
  `0xBB`, 52 bytes - and **deletion is the same frame with `visible = 0`**. Index 0 is not a coffee
  profile but the machine's own on/off entry; index n >= 1 maps to beverage 199 + n.

## Internationalisation

**next-intl**, French only for now. `messages/fr.json` is the single catalog; `src/i18n/request.ts`
returns the locale and messages, wired via `createNextIntlPlugin` in `next.config.mjs`; the root
layout wraps the (client) pages in `NextIntlClientProvider`.

**No locale segment in the URL** — deliberately. `server.mjs` intercepts `/api/*` and `/local_lan/*`
before Next, and a `[locale]` segment would move every page for no benefit while there is one
language. The extension point for a second language is `src/i18n/request.ts` (cookie or
`Accept-Language`), which leaves the pages untouched.

**Never put `<...>` in a message string.** next-intl reads angle brackets as rich-text tags, so a
message like `0D 08 A2 0F <id> <qty>` fails to parse and the UI prints the raw key
(`stats.protocolNote`) instead of the text. Use brackets or backticks for protocol placeholders.

**Nothing translatable crosses the API.** The server sends **protocol identifiers** — `slug` for a
beverage, `name` (the ECAM enum) for a parameter — and the client translates them via
`src/i18n/labels.ts` (`useBeverageLabel`, `useParamLabel`, `useUnitLabel`, `useCategoryLabel`),
each falling back to the server label when a key is missing. A **name typed on the machine**
(`machineName`: "Lacteso", "Malongo") is user data and is **never** translated.

The French labels still in `beverages.mjs` / `profiles.mjs` are for the **terminal log only**; UI
text comes from the catalog. Server-side `label` fields returned by `/api/command` are echoed as-is
in a few status messages — the remaining non-catalog strings, and the only thing left to key if a
second language is added.

## Secrets and data hygiene

- `docs/secrets.md` and `.env.local` hold the live LAN key, Ayla/Gigya tokens, and
  personal data; both are gitignored. Keep all secrets out of the other `docs/*.md` and out of code.
- The DB may also hold an Ayla **`refresh_token`** (`settings.aylaRefresh`) if the user asked to
  remember the cloud session. That is an **account-level** credential, unlike everything else in
  there — treat a leaked `lan-server.db` as a compromised De'Longhi account, not just a compromised
  coffee machine.
- `data/` is gitignored and holds machine-derived state — `lan-server.db` carries the
  discovered LAN key, the DSN, the serial number and the profile names. Treat the whole directory as
  secret material, not as a build artifact.
- `apk/`, `decompiled/`, and logcat captures are gitignored (large / redistributable under
  De'Longhi rights). The decompiled Java under `decompiled/sources/` (esp. `it/delonghi/` and
  `com/aylanetworks/aylasdk/localcontrol/lan/`) is the reference when porting protocol behavior.

## Operational notes

- The machine sits on an **isolated IoT VLAN** (`VLAN_IOT` / `IP_MACHINE` in the docs); the dev host
  is on another one. LAN mode needs bidirectional reachability (machine → server:3000 must be
  permitted). See `docs/securite.md` for the topology, and `../docs/` for the real values — **this
  file is versioned and published, so the redaction rule above applies to it first**.
- Sending an "on" command triggers a physical rinse (hot water through the spout). Commands act on
  a real appliance — confirm intent before firing, and never assume a queued command is harmless.
