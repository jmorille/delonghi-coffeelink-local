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
pnpm lint           # eslint . — les .mjs SEULEMENT, voir eslint.config.mjs
node_modules/.bin/tsc --noEmit   # typecheck (TypeScript 7)

# Diagnostics: a standalone LAN-mode server on :3005 that logs VERBATIM everything the machine
# sends — the tool for framing / keep-alive / key-exchange-sequence bugs.
node --env-file=.env.local debug-capture.mjs

# Multiplexer, end to end on the loopback, no machine and no phone (see its section below).
PROXY_APPS=1 SERVER_PORT=3099 node server.mjs
node scripts/faux-app.mjs --serveur 127.0.0.1:3099 --port 8888   # a client, read-only
node scripts/faux-app.mjs --serveur 127.0.0.1:3099 --port 8890   # a second one
node scripts/fausse-machine.mjs --serveur 127.0.0.1:3099         # pushes one state to both

# Regenerate the extracted tables from the APK (do not hand-edit their JSON output).
node scripts/extract-catalogs.mjs   # → src/lib/machine-catalogs.json
node scripts/extract-models.mjs     # → src/lib/machine-models.json
node scripts/extract-images.mjs     # → src/lib/beverage-images.json + public/boissons/ (gitignoré)
```

`pnpm-workspace.yaml` exists solely to **refuse** the install scripts of `@parcel/watcher` and
`@swc/core` (pnpm 11 demands an explicit decision). Nothing depends on them — do not "fix" that
prompt by allowing them.

**lan-server has no test suite.** Protocol changes are validated live against the real machine, not unit tests.
CI (`.github/workflows/ci.yml`) therefore checks what can be checked without a machine: `tsc`,
`node --check` on every `.mjs`, **ESLint on every `.mjs`**, the message catalogue (invalid JSON or an angle bracket in a string),
**every literal translation key against its namespace** (`scripts/verif-messages.mjs`),
`pnpm build`, the SQLite store's init/migration, and that the Docker image builds and answers
`/api/status`. On a green push to `master`/`main` it then **publishes `ghcr.io/<repo>:edge`** — so a
bad merge becomes a pullable image, not just a red check. `release.yml` fires on a `v*` tag: multi-arch image to GHCR + a GitHub release with a
Docker-less tarball. `packageManager` in `package.json` pins pnpm for corepack and for the runners.

(The sibling HA repo does have one, runnable with plain pytest and no Home Assistant install:
`cd ../delonghi_coffeelink_ha && pytest tests/`, or a single file `pytest tests/test_monitor.py`.)

**ESLint lints the `.mjs` files and ONLY those — that is where the hole was.** `tsconfig.json`
includes only `**/*.ts` / `**/*.tsx`, so the 22 `.mjs` files — `server.mjs`, the one thing that
runs, among them — were never seen by `tsc`; their whole net was `node --check`, which reads
syntax and nothing else. Config in `eslint.config.mjs` (ESLint 10, flat), wired as `pnpm lint` and
as a CI step. It found real defects on its first run, including `/api/beanadapt/save` silently
dropping the `taskId`/`position` that every other queueing endpoint returns.

⚠️ **Do not "complete" it by adding `typescript-eslint`.** It cannot work here, and the failure is
structural rather than a version warning: this repo is on **TypeScript 7**, whose package no
longer exports the classic compiler API (`require("typescript").createSourceFile` is `undefined` —
the AST moved behind `typescript/unstable/ast`), while `typescript-eslint` declares
`typescript: ">=4.8.4 <6.1.0"` right down to its canary. Installing it succeeds and the parse
fails on the first line of TSX. The `.tsx` side is already covered by `tsc --noEmit`; when
typescript-eslint supports TS 7, adding a `files` block for `.ts`/`.tsx` also unlocks
`eslint-plugin-react-hooks`, which is worth having in a codebase this full of `useCallback` and
ref-held callbacks.

Two rules are deliberately relaxed, both documented at the site: `no-empty` allows an empty
`catch` (13 occurrences, all meaning "best effort" — failing loudly there would be the real
defect), and `no-useless-assignment` is off because the variables it flags are serialised into
JSON, where `null` and `undefined` are not interchangeable.

Historical note, so nobody re-diagnoses it: `"lint": "next lint"` was a `create-next-app`
leftover that **never checked anything** — there was no ESLint in the repo at all, so even under
Next 15 it would have dropped into its interactive setup wizard. Next 16 removed `next lint`, and
since `dev` is the default command taking a `[directory]`, `next lint` was read as
`next dev ./lint` — hence the baffling "Invalid project directory" error. Nothing regressed;
nothing was linting.

**A branch merged into `master` is deleted locally in the same breath.** `git merge --no-ff`, then
`git branch -d <branch>` — **never `-D`**. From the moment the merge lands the commits live in
`master`, so the branch pointer carries nothing; leaving it behind turns `git branch` into a list of
things you have to re-verify before you can trust it, and the one branch that genuinely is *not*
merged stops standing out. `-d` **is** the safety mechanism: it refuses when the branch is not
contained in `master`, so the cleanup checks its own precondition instead of taking your word for
it. Same rule for the remote copy once `master` is pushed, with the proof made explicit first —
`git merge-base --is-ancestor origin/<branch> master`, then `git push origin --delete <branch>`, and
skip any branch whose check fails rather than deleting it anyway. A remote branch can hold a commit
the local clone has never seen; that is the one case a blind delete destroys.

**Pushing to GitHub, and confirming the build that follows, is delegated to a subagent.** The push
is the outward-facing step, and its verdict does not arrive with it — CI answers minutes later. One
agent owns the whole round trip: push, prune the merged remote branches, watch the run to its
verdict, and **quote any annotations** rather than reporting a bare green. Give it the interdictions
in writing, because they are what makes the delegation safe: no `--force`, no rebase, no history
rewrite, no commit, no file edits, and **no attempt to repair a red CI** — it reports the failure
with the useful log lines and stops, since fixing a build is a decision, not an errand. It also
requires a clean tree and must **abort and say so** rather than stash or commit whatever it finds.
Corollary worth knowing: do not edit files while that agent runs, or it will abort on a tree that
was clean when you launched it.

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
twenty-first. ⚠️ **That sentence was false in exactly one place, and it was the most visible one:
the key exchange logged nothing.** `/local_lan/key_exchange.json` set `m.session` and returned, so
opening a LAN session — the most structuring event of the link — was both untraceable in the journal
and invisible to every subscriber: `/pilotage` kept showing "session LAN : en attente" while
`/api/status` had answered `active: true` since the exchange. Reloading the page fixed the display,
which made a real hole look like a browser quirk. It now logs one line (`session LAN
établie/rouverte (key_id N)`), which floods nothing — a session opens once — and if it reopens in a
loop that is precisely what one needs to see, folded with its count. The rule to keep: **a state
change that writes no log line is a state change no browser will ever learn about.** Coalesced over 250 ms (an import logs one line per property). `sseWatch()` covers the
one thing the log cannot say: a window that **expires** without the machine ever connecting writes no
line, so without it the "lecture…" badge would hang forever; it runs only while something is open and
stops after one final broadcast. `fenetreOuverte()` judges liveness on the **duration**, not on the
`active` flag alone — that flag only falls when the machine fetches the next command. `/api/events`
is handled **before** the DSN resolution in `handleApi`: a subscription must not trigger a 4 s probe.
The client (`/machines`) merges pushed state per machine and keeps the object identity of unchanged
ones, so React redraws only the card that moved; it falls back to polling only if the stream fails.
Do not add `Content-Length` or `Connection: close` to that response, and never route it through
`raw()`.

**All machine work goes through ONE queue per machine — `src/lib/tasks.mjs`.** The machine fetches
exactly **one** command per visit to `commands.json`, so there is never more than one frame in
flight; that is the only structural exclusion this protocol has. `startProgram` and `startImport`
each wrote into a single slot (`m.program`, `m.import`) **without looking at what was already
running**: last in, last served, and the previous one vanished without a log line, a failure or a
refusal — the remaining properties of an overwritten import were simply lost. Opening a page during
a bean sweep was enough to decapitate it.

A **task** is a list of **steps** plus a policy. An import of 21 properties is one task of 21 steps;
"Allumer" is a task of one step; a bean sweep is one task of six — where it used to be six separate
programs chained by a guessed `setTimeout(11000)`, with a two-second dead zone between each. Three
kinds of wait, because the machine does not answer the same way for everything: `prop` (it will push
that property), `reponse` (an answer will come — true of `0x75`, `0xA2`, `0xA3`, `0xA6`,
`0xB0`, `0xBA`), and `fenetre` (it has nothing to answer — `0x84`, `0x83`, `0xA9`, `0xBB`, `0xB9`).
For `fenetre`, `ms` is a **sustained-presence duration, not a failure deadline: reaching it is
success.** The kind is derived from `ECAM_OPS` via `natureTrame()`, so no call site decides it and
there is no second table to keep in sync.

⚠️ **`0x75` does NOT answer with a `data_response` — it answers with a `d302_monitor` datapoint
push**, and this file said the opposite for a long time. The consequence was not subtle: the monitor
branch of `handleProperty` returned without ever calling `apparier`, so a "Présence" step could only
be satisfied by a message the machine never sends for that command. Measured three times running —
monitor received at 16:19:58 and 16:20:11, the task declared "sans réponse" at 16:20:01 and "échouée
: 1 sans réponse" at 16:20:15. The state was there, decoded and on screen, and the task died anyway.
**Every state read failed**, which in use reads exactly like a disconnected machine while the link is
working perfectly. The match is deliberately **narrow** — a step now carries its ECAM `cmd` and
`reponse(file, {reponse: true, cmd})` only completes a step that asked for that command: monitor
pushes are *also* spontaneous (one every 1–3 s during a brew), so matching broadly would mark a
pending statistics step as answered and file counters as read that were never read. Without `cmd`
the old permissive behaviour stands, on purpose: the byte-for-byte correspondence has not been
verified for every command, and narrowing blindly would break reads that work today.

**Four ranks, one preemption rule**: a task may be suspended at a **step boundary** by a task of
strictly higher rank. `URGENT` (0) is `stop` alone — it preempts even a running dispense, at a cost
of at most one visit. `COMMANDE` (1) is on/off/dispense/profile/bean-select/writes. `LECTURE` (2)
never preempts a command. `LECTURE_BASSE` (3) is the back of the queue and holds exactly one thing:
the **statistics sweep**. Usage counters are the only data on this machine that does not go stale —
a descale count read thirty seconds later is the same count — while profile names, beverage bounds
and bean settings are what someone is watching a page for. A full sweep is eight round trips, so at
rank 2 it made every page opened during it wait for nothing. Everything falls out of one insertion
rule (`enfiler`: insert before the first task of strictly lower rank), including "a command never
cuts another command" and "an ordinary read overtakes a sweep already under way". Suspended, **not**
cancelled: the evicted task keeps its remaining steps and resumes — a sweep interrupted at request
three resumes at request three.

**Failures.** Each step has a deadline. A missed *read* step goes back **once** at the end of its
task (`repris`), then counts as unread. The **circuit breaker** is the important one: no contact of
any kind for `DELAIS.muet` (25 s) while a task heads the queue — with `local_reg` firing every
2.5 s — means the machine is mute, so the head fails and **the rest of the queue is cancelled with
the same motive, in one log line**, and the keep-alive stops. Without it, per-property retry would
*double* the wait in exactly the case where it can rescue nothing. The two regimes are told apart by
one question: has any response arrived since the task took the head? Note that a task is promoted to
`encours` **when it reaches the head, not when it is served** — `aServir` only runs when the machine
visits, and the case that matters most is the one where it never does; without that promotion the
breaker never fired and the queue waited forever. Nothing is persisted: a restart drops the queue.

**`m.program` / `m.import` are now derived views** (`vueProgramme`, `vueLecture`) because
`/machines`, `/api/beverages` and `/api/profiles` read those shapes. There is one state, so two
pages can no longer contradict each other about what the machine is doing. Every queueing endpoint
returns `taskId` and `position`; `/api/status` returns `queue` (running / waiting / last finished);
`{action:"clear"}` cancels everything, or one task with `taskId`. Cancelled and failed tasks land in
`finies` with their motive — they do not evaporate, which was the original defect.

**`finies` folds on `cle`, keeping only the LAST verdict per request.** Reported from real use: the
circuit breaker cancels the whole queue at once, so the five slots filled with five failed
"Présence" lines; the next presence succeeded but occupied only one of them, and the four stale
verdicts stayed on screen describing a state that no longer existed. Folding uses the key that
already means "these two are the same request" — the one that merges two *pending* tasks — so
nothing new decides what is a duplicate. **No key, no folding**: two dispenses keep two lines, which
is the boundary `cle` already draws (asking for two coffees is not asking for one). The count
survives as `repetitions` and `/pilotage` renders it `×5`, same rule as the journal's line folding:
"réussie" without the count would erase the fact that it took five tries. It also makes the five
slots hold five *distinct* requests instead of five copies of one. `verif-tasks.mjs` asserts all
four behaviours against the reported scenario.

**`POST /api/readall` reads everything the machine can tell us** — presence, model, checksums,
profile names + favourite order, the active profile's beverage bounds and values, the six bean
slots, and the full 62-counter sweep: **7 tasks, 90 steps**, all rank `LECTURE` so a user command
still goes ahead of them. Nothing is prepared or written. **This endpoint was not implementable
before the queue**: each of those reads wrote into the single `m.import` / `m.program` slot, so
chaining them meant overwriting them one after another and only the last survived. It is the first
feature that needed nothing but the ability to queue more than one thing. It is in `NEEDS_MACHINE`
— without a key or an address the six reads would be accepted and silently lost.

**The stat sweep ranges live in `STAT_RANGES` (server) and are published by `GET /api/stats`**, not
copied into `/statistiques`. They used to live only in the page, and `/api/readall` needs them too;
two copies of a protocol table that decides what gets read off an appliance is exactly the
divergence this file warns about elsewhere. The page consumes `ranges` and keeps an empty fallback
only for the first paint. Same pattern as `appIds`, which that endpoint already published.

**`/pilotage` no longer serves beverages at all — the card was removed.** It replayed `/`'s grid: a
second set of buttons that pour coffee, on a page titled "Pilotage local" whose every other block
describes *state*. Two places for the same gesture, and this one had neither the names read off the
machine, nor the profile's stored values, nor the recipe editor — it offered the same action, worse.
`/` is where a drink is started.

**"Arrêter" lives in "Commandes machine"**: on/off/stop are the three orders given to the appliance
itself, and separating the third meant hunting for it elsewhere. Removing the beverages card took
away what used to enable it (`lance`, the drink *this tab* had started), so it now follows a
server-side signal — **`program.dispense`**, not `program.active`. That distinction is the whole
point: since the queue exists, `active` is true whenever *any* task runs, so gating on it lit
"Arrêter" during a counter sweep and offered to interrupt it with a **beverage-stop frame**. Only
the `dispense` action is marked (`meta: { dispense: true }` at `startProgram`), and `vueProgramme`
publishes the flag; `/` ORs it with its own `lastDispensed`. Unchanged limit, worth stating: a drink
started at the machine's own panel never passed through us, so it does not light the button — that
was already true before the queue. The confirmation says outright that we do not know which drink is
pouring (`power.stopUnknownBeverage`)
rather than letting the user believe we are stopping what they see. The espresso fallback in the
frame stays necessary — the stop frame carries a beverage id — but it is never tacit. Leaving the
button permanently inert would have been worse than confirming an imprecise stop.

Below those three, under a "Lectures" sub-heading and deliberately **not** in the same row, sit
**"Lire l'état"** then "Tout lire": the three above act on the appliance, these only ask — equal
weight would equate "cut the hot water" with "re-read some counters".

**"Lire l'état" is `0x75`, the only frame that asks the machine where it is** — standby / heating /
ready, sensors, alarms. It posts to `/api/presence` with **`force: true`**, and that flag exists
because the endpoint is deliberately throttled for its *automatic* caller (opening four tabs must
not open four sessions): monitor younger than 30 s, non-empty queue, or called under 8 s ago, and it
answers `skipped`. For a click that is the wrong answer — one clicks precisely because the state row
is empty or dated. The merge key (`cle: "presence"`) still holds, so a double click is still one
task. Rank stays `LECTURE`: an état request must not overtake a command, but it does overtake a
counter sweep (`LECTURE_BASSE`), which is the long job one actually risked waiting behind. "Tout
lire" keeps the `.mini` treatment, same rule as `/statistiques`: two buttons that differ in extent,
not in nature. It asks **no confirmation**, unlike the three
above it: the question it used to pose warned about queueing seven tasks at once, back when each new
request destroyed the previous one. The queue removed that risk — the tasks stack at rank `LECTURE`,
a command overtakes them, "Activité" shows them one by one and each carries its own "Annuler". The
confirmations that remain guard a gesture that reaches the appliance and that no queue can undo
afterwards; this one only asks.

⚠️ **"Persistent write" is no longer one of those gestures, by the owner's explicit decision.**
"Écrire dans le profil" (`0x83` / `SAVE_BEVERAGE`, on both `/` and `/recipes`) and "Enregistrer
l'image" (`0xAB`) now fire on the click. Three things about how that was done, because each is
the difference between a change and a regression:

- **The warning moved, it did not vanish.** `editor.writeTitle` already said "Remplace durablement
  la recette de ce profil… La valeur précédente est perdue" in the button's tooltip; the other two
  buttons gained one carrying the same text (`beverages.imageConfirmWarning`,
  `recipes.writeToProfileWarning`). Removing the **interruption** is what was asked; removing the
  **fact** would have been a second, unasked change.
- **Both pages moved together.** `/` and `/recipes` write the same frame through the same
  endpoint; leaving one of them asking would have made one gesture behave two ways depending on
  the page — the exact divergence this file warns about everywhere else.
- **The `Geste` list stayed closed.** These two did NOT become disableable preferences in
  `confirmPrefs.ts`; they simply have no dialogue any more. The renounceable set is still
  `power` / `dispense` and still defaults to asking. That module's own comment used to assert
  that a profile write "ne doit jamais" lose its dialogue — it was corrected in the same commit,
  because **a comment stating an invariant has to fall with the invariant**; left standing it
  would promise the next reader a guarantee the code no longer offers.

**`L()` folds consecutive identical lines instead of writing them again.** Measured on a real
circuit-breaker run: 24 of the last 30 journal lines were `local_reg erreur: socket hang up`, and
the six that explained anything — the tasks being queued, the verdict — were pushed off screen. An
unreachable machine fills the journal mechanically (`local_reg` every 2.5 s) and drowns exactly what
one comes there to read. Only **consecutive** repeats from the same machine and direction fold; the
timestamp follows the LAST occurrence ("it is still happening" is the useful fact) and `repetitions`
carries the count, which `/pilotage` renders as `(×12)`. Same run after folding: 30 lines → 9, whole
story readable at a glance. Do not drop the count when rendering a log line — a folded line without
it reads as an isolated incident where there were two dozen.

**`scripts/verif-tasks.mjs` is the first thing in this repo that is verifiable without the
machine** — fourteen assertions over ordering (including the statistics sweep's back-of-queue rank
and its suspend-and-resume), preemption-with-resume, merging, the cap, retry, window-as-success, the
breaker, cancellation and the view. Plain `node scripts/verif-tasks.mjs`, no
dependencies. **It now runs in CI**, alongside `scripts/verif-monitor.mjs`,
`scripts/verif-lansession.mjs` and `scripts/verif-apps.mjs` — four now, and the list only grows
where a part was kept pure on purpose. The scheduler is pure
(the instant is always a parameter, no I/O, no logging) precisely so this stays possible; keep it
that way.

**`scripts/verif-monitor.mjs` is the second, and it replays REAL device behaviour.**
`scripts/captures/*.json` are three preparations recorded on the machine on 2026-08-22 — an
espresso (coffee only), an espresso macchiato (milk then coffee) and a hot milk (milk only) — and
the script decodes every frame through the very module the server uses. It is the only place in
this project where appliance behaviour is frozen and replayable. That is what makes the extraction
of `decodeMonitor` into **`src/lib/monitor.mjs`** worth its cost: the decoder is pure, so it can be
proven without the machine. **That module is not one of the shadowed `src/lib/*.ts` copies — it
runs, `server.mjs` imports it.**

**`/pilotage`'s "Activité" panel is the queue, in three blocks** — running (label, rank, `2 sur 6`,
current step, retries), waiting (one row per task, each with its own **Annuler**, plus "Vider la
file"), and the last finished tasks **with their verdict**. That third block matters as much as the
first: a task that ends having done nothing is otherwise indistinguishable from one that has not
answered yet, and the `muette` motive carries the repair (in LAN mode the machine connects to *us*,
so the usual culprit is the return path, not the command). The rank pill lives in the **value**
column, not the label column — the label column is capped at 13 rem, so a long task name pushed the
pill under it where it read as a second label. The panel replaced a "File de commandes" table that
read a `status.queue` the server had never returned; the field exists now, and means it. It sits
**below "Commandes machine", not above it**: liaison → what you came to do → what follows from it.
Above the commands it asked the reader to follow a queue before seeing what fills it, and pushed the
most frequent gesture of the page — turning the machine on — under a block that says "rien en file"
most of the time.

**The page's accessibility structure is deliberate, and it is the model for the others.** Each
`<section>` carries `aria-labelledby` pointing at its `<h2>`, which is what turns eight anonymous
boxes into eight **named regions** — without it an agent or a screen reader gets a flat run of
headings and text with no way to scope "the Activité panel". The `.kv` rows of a card are a `<dl>`
(`dl.kvListe` > `div.kv` > `dt.k` + `dd`, the `<div>` group being valid inside a `<dl>`), because the
label→value pairing otherwise exists **only** in the two-column grid: read linearly it was "Session
LAN", "établie", "Adresse…", "192.168…" with nothing saying which goes with which. `globals.css`
neutralises the browser's `<dd>` indent, which the grid cannot absorb. **"État de la machine" carries the AGE of the reading, because "Session LAN : établie" does not.**
`session.active` is `!!m.session`, and that session is dropped only on a configuration change — LAN
key, address, machine reset, forgetting either — **never on inactivity and never on a timeout**. It
therefore still reads "établie" hours after the machine stopped answering, which is exactly the
situation someone opens this page to diagnose. The only dated proof we hold is `lastMonitor.at`, so
the row now prints "lu il y a 45 s" beside the state pill, and past `AGE_PERIME` (90 s) says the
state may have changed since. `fmtAge` and that threshold moved from `page.tsx` into
`machineState.ts` — `/` showed the same fact with the same words and its own private copy, and two
scales for "how old is this reading" would diverge at the first edit. A local 15 s heartbeat drives
it, for the reason the home page already documents: nothing pushes an event because a minute
passed, so without it the age would freeze at its first value. What is still NOT shown anywhere is
`lastDataResponse.at` — the age of the last *ECAM* answer, which is what a mute stats sweep is
about. The **liaison report lands on the row it
describes**, not in a bordered box under the button: "Annonce envoyée à la machine (HTTP 202)" *is*
a machine state, and a separate panel made the reader shuttle between the button, the box, and the
"État de la machine" line it comments on. `StatutEnLigne` renders it beside the state pill, mounted
permanently and empty when there is nothing — a `role="status"` created at the same instant as its
content is not announced, only a change *inside* an already-present region is, so do not make it
conditional. A failure keeps the alert pictogram of the "Serveur" row above it. The Activité card is
`role="status"` **with `aria-atomic="false"`**: it is the only card that changes on its own, so it
must be announced, but `role="status"` implies atomic and would re-read the whole queue every two
seconds as the step counter ticks. Do not drop that `aria-atomic`.

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
(dashboard: on/off, live monitor, **activity**, log), `/recipes` (custom recipes, **constrained by the model's min/def/max bounds** — the `0xB0` bounds are
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
`/reglages` (**the appliance's own configuration** — water hardness, auto-off,
temperature, buzzer, energy saving — read and written locally; not to be confused with `/machines`,
which configures the *server*), `/systeme` (technical sheet: firmware, OTA, module, Ayla
platform, model, protocol state, security findings, plus the two monitor-mode probes). `/boissons` 307-redirects to `/`, and
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
**Custom recipes ARE per-profile, stride 6** — `d{200 + (p−1)×6 + (slot−1)}_{p}_cstm_recipe_{slot}`.
This file long asserted the opposite ("profile 1 hard-coded… asking for `d200_2_…` would be
inventing a name") from a fact that is itself correct: the app only ever writes six literals,
`C1("d200_1_cstm_recipe_01")` … `C1("d205_1_cstm_recipe_06")`, and has no profile-varying builder.
**The inference from it was wrong — what the app cannot ask for, the machine still publishes.**
Measured 2026-08-22 19:41 in the app journal: after a recipe write (`0x83`) the appliance pushed
all five profiles on its own — `d202_1`, `d208_2`, `d214_3`, `d220_4`, `d226_5`, each carrying
`d0 17 a6 f0 0P e8 …` whose **profile byte agrees with the digit in the name**, and `0xE8` = 232 =
"Recette perso 3". Stride 6 is the Bean System's (`t()`, base 160), and `200 + 5×6 = 230` lands
exactly where the custom-recipe beverage ids begin — no collision.
⚠️ **This was not a missing journal label: forcing profile 1 meant reading `d202_1_…` for profiles
2-5, i.e. showing profile 1's recipe as theirs.** Same shape as the bean-system missing-stride bug
above, but nastier — that one answered empty and looked absent, this one answered a plausible
value. And it surfaced the same way three other defects did today: the discovery marker fired
(`PROPRIÉTÉ NON IDENTIFIÉE`) on names the **machine** sent us and our own builder could not
reproduce. `profilePropForSlug` in `beverages.mjs` is the single builder; the inverse used for
naming derives from it, so fixing it fixes both directions at once.

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

**Machine settings — the read/write symmetry, `0x95` / `0x90`.** `REGLAGES` in `server.mjs` holds
the address table lifted from the app's settings view-model (`p018b7/d.java`): 50 water hardness,
61 coffee temperature, 62 auto-off, **63 a bitfield** (auto-start — *inverted*, bit set = disabled —
buzzer, cup light, energy saving, cup warmer), 64/65 the auto-start clock. The `0x95` response is
**not** shaped like `0xA2`: the first address sits in bytes 4-5 and the values follow as n × 4 bytes
for *consecutive* addresses, with no id in front of each. Confusing the two formats shifts every
value by one — plausible and wrong. `/reglages` is the page; `GET/POST /api/settings` and
`POST /api/settings/write`.

Three guards that are the point of the feature, not decoration: **the same data also exists as Ayla
properties** (`d281`…`d284`, two name families as usual) and we ask for both, since neither is
guaranteed on a given model; **a bitfield write re-reads the current byte and flips one bit**, and
*refuses* (409, `needsRead`) when that byte was never read — writing it from an assumed state would
switch the other four settings off; and **only addresses in `REGLAGES` are ever written**, and only
when the model's own flag declares the setting. Those flags now travel in `machine-catalogs.json`
(`water_hardness_settings` and friends, extracted verbatim from the APK — a renamed copy would be a
second table to keep in sync, and the APK's is the one that must win). **An undeclared flag means
not supported, never "supported by default"**: `0x90` writes four bytes to an arbitrary address in a
real appliance's configuration, and the known table covers six addresses out of an unknown space.

**The three name/order writes — `0xA5`, `0xAB`, `0xAD` — live on `/profils`**, beside the reads they
mirror (`0xA4` / `0xAA` / `0xA8`). Only **one entry** is ever written (`first = last = index`), which
is what the app itself does: rewriting the whole block would make a rename depend on the freshness of
the cache, and a name that had not been re-read would be overwritten with a stale value. The icon
travels in the same 21-byte entry as the name, so the form asks for both and the endpoint **refuses**
rather than defaulting to 0. The Striker 22-byte stride is deliberately not ported — writing a block
at the wrong stride shifts every following name. Favourites are a **fixed** 19-byte frame, hence
exactly 12 slots, padded with zeros; every id is checked against the model's catalog first.

**That icon byte is an INDEX 0-19 into a list frozen in the app** — not a resource id, not a
beverage id. Established without writing anything to the appliance, which is the point: `J()`
marks the picker cell whose **position** equals `gVar.n()`; `Q6.g.n()` returns `f6459b`, which the
class's own `toString` names `recipeImageIndex`; `m0()`'s `SET_NAME_ICON` case calls
`f0(beverageId, name, gVar2.n())`; `DeLonghiWifiConnectService.f0` logs it as `iconIndex:` and
hands it to `p097j6.d.f0`, which sets `bArr[2] = 0xAB` and drops it at offset 20 of the entry. The
note that stood here for a while — "plausible, unverified, confirm by renaming a recipe on the
machine" — planned a persistent write for something a read settles. Same rule as the `0x37`
constant: **when the signal hypothesis is refutable by reading, read before you write to an
appliance.** The list is in `beverage-images.json` (`choixRecettePerso`) and `doc/commandes-cafe.md`
§ 8.1; its **order is the data**, and entries 12 and 18 are deliberately the same image
(`hot_water`) because de-duplicating would shift every index after them.

**Choosing that image lives on `/`, inside the opened card — not in the recipe editor.** The
editor is titled "for profile N" and its write targets a profile; the image belongs to the
**slot** and all five profiles share it, so putting the picker under that heading would have
asserted something false. ⚠️ **Name and icon travel in the same 21-byte entry**, so an icon write
necessarily rewrites the name: the confirmation says so and sends back the name exactly as read.
Renaming stays `/profils`' gesture — it has the form for it, and duplicating it here would make
two places for one act. The picker is a `radiogroup` and every cell carries the **name** of its
drawing: twenty unlabelled thumbnails would leave the selection itself unannounced. Those names
live in their own `beverageImage` namespace, keyed by the app's resource names, which are **not**
our catalog slugs (`due_x_espresso_coffee` here is `2x_espresso` there) — serving them from
`beverage` would fold two identifier spaces into one. The slot number comes from the server
(`customSlot` on `/api/beverages`); the 229 that ties it to the beverage id is a protocol constant
and has exactly one home.

**`0x60` / `0x70` are probes, not features.** `getByteMonitorMode` builds three frames; the app's
Wi-Fi service only ever sends `0x75`. `POST /api/monitormode` sends the other two and logs the raw
answer with **no decoder** — inventing a structure for bytes never observed would produce plausible
fields. The buttons sit on `/systeme`, under "État machine": it is the page that describes the
protocol, and the result is the raw `lastDataResponse` line right above them. That is the one
exception to "`/systeme` is read-only" — it sends a read frame, writes nothing, and is a measurement
rather than a routine gesture.

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

**Monitor bytes 5–6 are the sensor bitfield, not a "progress" value** (byte = `5 + group`).
`/api/*` exposes it as `switchBits`; nothing emits `progress`. **Bits 1.0 and 1.1 BOTH mean "milk
carafe fitted"; what separates them is the carafe's KNOB position** — measured three times, one
variable at a time: carafe removed → byte 6 `0b00000000`; fitted, knob on **clean** → `0b00000010`
(bit 1.1 `CIOCCO_TANK`); fitted, knob **anywhere else** → `0b00000001` (bit 1.0 `IFD_CARAFFE`).
**The detector knows exactly one boundary — clean or not clean.** Three non-clean positions were
measured (froth as found, froth at minimum, and the "insert" graduation) and all give the *same
frame, byte for byte, CRC included*; neither the froth level nor "insert" is reported anywhere in
`0x75`. The first label written here said "knob on froth", which over-read a single measurement —
the position the knob happened to be in. Never both bits at once, which is what the four recorded
preparations already showed unexplained: **three of the four carry `IFD_CARAFFE`** (the espresso,
the macchiato and the hot milk) and **the fourth carries `CIOCCO_TANK`** (the second espresso). So
it is not milk that raises the bit — a plain espresso raises it too — it is the knob:
`espresso-veille` is the only capture recorded with the knob on clean. **The UI label deliberately
reads "carafe à lait (mousse)", shorter than the fact** — the normal service position rather than
the exact predicate; the precise "anywhere but clean" lives in the docs and in `monitor.mjs`. Do
not "correct" the label back, and do not infer from it that "insert" raises a different bit: it
raises this one. `verif-monitor.mjs` pins both labels to the captured frames. The enum names come from the app and mislead: `CIOCCO_TANK` names no chocolate tank
here, this model has no chocolate beverage at all. Keep the names, they are protocol; the *labels*
say the knob position, and `verif-monitor.mjs` asserts both the frames and the labels
(`scripts/captures/carafe-molette.json`). This supersedes the earlier correction in this file, which
had the carafe fitted with its knob on clean and therefore concluded 1.1 alone tracked presence. The `/systeme` page still read `lastMonitor.progress` long
after the rename and printed "progress undefined" — if you rename a monitor field, grep the pages.
The alarm bitfield is `byte 7 | 8<<8 | 12<<16 | 13<<24`, and byte 13 must be **multiplied** by
`0x1000000`, not shifted: `0x80 << 24` is negative in JS and published a signed bitfield.

**The real progress lives in bytes 9, 10 and 11** — `fonction`, `etape`, `pourcent`, decoded in
`src/lib/monitor.mjs` and published by `/api/status`. Measured on three real preparations
(`doc/commandes-cafe.md` § 11.5); three things fall out of that measurement and none of them was
guessable from the decompiled code:
- **`fonction` is the PHASE, not the drink.** A macchiato runs at 10 (milk) then switches to 7
  (coffee) mid-preparation. Read it once and you are wrong halfway through.
- **`pourcent` spans the WHOLE beverage and never resets**: the milk takes it to 38, the coffee
  resumes at 40. One bar, no stitching.
- ⚠️ **100 % is not guaranteed.** A hot milk stopped at 90 % and dropped straight back to idle. The
  only reliable completion signal is the return to idle (`auRepos`) — verified on all three drinks,
  including the one that never left `f=10`. A bar that waits for `pourcent === 100` hangs.
  `verif-monitor.mjs` asserts exactly this, so the trap cannot come back silently.
- ⚠️ **Idle is `e == 0` ALONE, not the app's `f == 7 && e == 0`.** Established by physically
  unplugging the milk carafe (`scripts/captures/carafe.json`): at rest **with the carafe fitted the
  frame reads `f=12, e=0`** — a function absent from all four recorded preparations — and removing
  the carafe brings it back to `f=7, e=0`. Under the app's predicate, an idle machine with its
  carafe on was read as "preparing, 0 %", so the bar showed permanently. The invariant that makes
  `e == 0` safe is asserted over every capture: step 0 never appears mid-preparation.

**A frozen bar is worse than no bar, so the progression has its OWN freshness threshold** —
`AGE_PROGRESSION` (20 s) in `machineState.ts`, not the 90 s `AGE_PERIME`. Observed live: the machine
left the network 13 s after a command was sent, and `/` kept "Mouture — 0 %" on screen, motionless,
asserting a preparation was progressing when contact had been lost. During a brew the machine pushes
a frame every 1–3 s (median 2.6 s, worst gap ever measured 7.6 s across the three captures), so a
twenty-second-old percentage does not mean "it is going slowly", it means "we lost the link".
`verif-monitor.mjs` asserts the constant stays **above** the captures' worst gap and **below**
`AGE_PERIME` — tightening it under the real cadence would make the bar flicker.

**`/pilotage` uses that same threshold, and it did not for a long time.** Its raw progression row
was gated on `auRepos === false` alone, so it announced "Préparation en cours · 100 %" from a frame
**94 seconds old**, long after the cup was drunk — reported from real use. `/` had the fix,
`/pilotage` never received it, and two pages dating the same reading differently is exactly the
divergence this file warns about elsewhere. The treatment differs by page on purpose: `/` **hides**
the bar, because someone waiting for coffee is served by nothing rather than by a lie; `/pilotage`
**keeps the three raw bytes** — they are what one comes to that page to read — and stops presenting
them as current, replacing the step name with a dated-reading pill. Related: `stepLabel(null)`
returns "Préparation en cours", word for word the row's own `dt` label, so an unnamed step printed
the same sentence twice. The step is named only when it *has* a name.

**A preparation can run entirely under state byte `0x04`, the one documented as "standby."**
Measured: a complete espresso — grind, infusion, pour to 100 % — across **49 frames all reporting
`0x04`**, with no power-on command ever sent through us; the same drink had been recorded at `0x02`
throughout earlier the same day (`scripts/captures/espresso-veille.json`). Byte 4 describes the
machine's *interface* state, not its activity, so **the progression outranks it**: `/`'s `isOn` ORs
in `auRepos === false`, or the toggle reads "off" directly above a bar saying "Écoulement du café —
84 %". `/` also shows **no success message after a dispense** any more — `commande()` accepts an
empty `ok()` and renders nothing. "Commande envoyée, see the journal" pointed elsewhere while the
bar was about to narrate the whole thing; failures, including the unheard `local_reg`, still show.

Five step values were observed that nothing names — the app keeps its previous illustration there.
`etapeCle` is `null` for them and the UI says "préparation en cours"; do not invent names.
**No duration exists anywhere in the protocol**, so `/`'s "depuis N s" is measured by the client
and is labelled as ours. `/` renders the bar in a permanently-mounted `role="status"` with
**`aria-atomic="false"`** (same rule as the Activité card) and the elapsed seconds are
`aria-hidden` — they tick every second, and atomic would re-read the whole region that often.

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

## Application multiplexer — lan-server plays the MACHINE

**Measured 2026-08-22, and it is the premise of the whole feature: the machine keeps exactly ONE
local peer.** Open the official De'Longhi app on the same network and our tasks start failing —
`0 sur 2`, folded `×4`, motive "sans réponse". Our `local_reg` is still answered 202; the machine
simply stops coming to us. Close the app and, after a delay, lan-server takes the slot back on its
own. Full write-up in `doc/analyse-connexion-wifi.md` §7ter and `doc/spec-proxy-multi-app.md` §7.1.

Two consequences beyond the feature itself. **The eviction is silent**, so "an app took the slot"
and "the machine is off" produce the identical symptom — which is why `taskMuteHint` now names
this third cause. And **the recovery is automatic**: nothing to restart.

The multiplexer is the answer: since the slot is unique, someone must hold it for everyone. We
already are that someone.

**Off by default — `PROXY_APPS=1` turns it on**, and without it `/regtoken.json` and
`/local_reg.json` do not exist on this server. Impersonating an appliance to third-party software
is a deliberate gesture, not a side effect of an upgrade; it also guarantees an existing install
behaves identically on this version.

**Port 80 is not negotiable.** The SDK builds `http://<ip>/…` with **no port**, so an app looks
for the appliance on 80 and nowhere else. Boot warns when `SERVER_PORT` is anything else, because
the alternative is a long hunt for why nothing ever connects.

**`src/lib/lansession.mjs` holds BOTH roles in one implementation** — it runs, `server.mjs`
imports it. The key exchange derives four keys; `role` ("client" / "device") only picks which set
encrypts outbound. Writing that derivation a second time for the proxy would have been the most
predictable fault available. `makeSession()` in `server.mjs` is now a thin `role: "client"`
wrapper, and the refactor was proven byte-for-byte neutral against the old inline code before
being kept.

**Getting the direction wrong raises NO error** — decryption yields plausible, unreadable bytes and
the symptom is a session that "stops answering". Hence `scripts/verif-lansession.mjs`, whose
central assertion is that *two sessions of the same role do not understand each other*.

**The proxy terminates both sides; it never tunnels bytes.** Each session owns a persistent
AES-CBC stream, so a ciphertext is meaningful only inside the stream it was produced in.
Everything crossing is decrypted and re-encrypted, once per application — which is exactly what
makes N independent applications possible where the machine allows one.

- `src/lib/appregistry.mjs` — **pure**, no I/O, instant always a parameter (same discipline as
  `tasks.mjs`, same reason: `scripts/verif-apps.mjs` runs in CI). An application's identity is its
  **`ip:port`**, because that is all `local_reg` carries. `nouvelle` is what triggers a key
  exchange and **a `PUT` must never trigger one** — that would replace the AES stream the app is
  mid-read on, and look like a phone that "drops" every few seconds.
  **An app's listening port is ephemeral** — the official app took a new one on relaunch, so the
  registry legitimately held two entries for one phone, the older showing "session établie" on a
  port that was already refusing connections. Silence and refusal are not the same information:
  a locked phone goes quiet, a closed port answers no. `echouer()` counts **consecutive** failed
  contacts (`SEUIL_ECHECS`, 3) and the entry is dropped in about a dozen seconds instead of the
  90 s silence delay; any success resets it. ⚠️ **Never evict on the address alone** — several apps
  on one phone, and the two demo clients on `127.0.0.1`, differ only by port, and telling them
  apart is precisely what this multiplexer exists to do. Unreachability removes an entry, never
  the arrival of a neighbour.
- `src/lib/appproxy.mjs` — transport (`node:http`, explicit `Content-Length`, same lesson as
  `local_reg`) plus `analyserCommandes()`, the pure part. The two payload shapes are **read out of
  the APK**: `{"cmds":[{"cmd":{…}}]}` for a read or `delete_session`, `{"properties":[{"property":
  {…}}]}` for a datapoint write. A property's `id` field **is** the ack request — its presence is
  the only signal, and not answering leaves the app waiting then concluding failure.
- ⚠️⚠️ **`206 Partial Content` is a NORMAL command response — dropping it is what stopped the
  official app from turning the machine on.** `AylaLanModule.getResponseCode()` returns
  `_pendingLanCommands.size() > 0 ? PARTIAL_CONTENT : OK`: the status does not qualify the body,
  it announces **what comes next**. `206` means "I have more queued", `200` means "that was the
  last one", and both carry the same valid encrypted payload. A `rep.status !== 200` guard
  therefore discards precisely the responses that carry a command, keeping only the last of a
  batch — and the loss is irreparable twice over (the SDK already dropped the command when it
  encrypted it; our stream is left a message behind). Measured: the app queues `0x84` and, one
  millisecond later, a whole alarms batch, so the turn-on came back as `206` and went in the bin
  with no journal line. `porteUneCharge`-style checks must accept **200 and 206**. And `206` must
  be re-polled immediately, inside the existing probe lock — a ten-command batch served at probe
  cadence takes twenty seconds to arrive, and the user just pressed a button.
- ⚠️ **A "bloc illisible" means "exactly one message vanished just before" — not "the stream is
  broken".** This file and `doc/` both claimed a one-message CBC offset "ne se rattrape pas". That
  is false and it sent the investigation to the wrong place. In CBC, block *n* of a message chains
  from ciphertext *n−1* of the **same** message; only the very first block depends on what came
  before. So a skipped message dirties the **16 first bytes** of the next message read and nothing
  else — the stream re-aligns by itself, whether one message was skipped or nine. That is the
  `…a":{}}` signature: garbage stops dead at the first block, the JSON tail is intact.
  `verif-lansession.mjs` pins both facts. The consequence that matters: a single unreadable block
  is not a benign isolated glitch, it is the only visible trace of a command that evaporated —
  look **upstream** for what ate the message, never at the block itself. The re-key behind it
  repairs nothing that was lost; it only avoids the next dirtied block.
- ⚠️ **An app's LAN command queue is AT-MOST-ONCE, and the app cannot tell.**
  `AylaLanModule.handleLanCommandRequest` removes the command from `_pendingLanCommands` the
  instant it **encrypts** it into the HTTP response — not when it is received, and there is no
  retry. One lost response therefore produces both symptoms at once, which is what made them
  impossible to connect: the command is gone for good, **and** the app's outbound AES stream has
  advanced by a message we never consumed, so everything after it is unreadable (`…ta":{}}`,
  leading block only). Measured end to end: the official app logged `AylaDatapoint sent to SDK:
  0d 07 84 0f 02 01` (turn on) then `onCreateDatapointOk`, while our side recorded
  `commandes = 0` and, twenty seconds later, one unreadable block — and the appliance, read
  minutes afterwards, had not moved, so it had not gone via the cloud either.
  **`onCreateDatapointOk` proves nothing about delivery**: the app says "delivered" on the
  strength of its own queue, which it emptied by encrypting.
- **The poll itself is journalled, on CHANGE only.** Fourteen probes in twenty-eight seconds used
  to write not one line, so one could not tell whether the loop was even running, what the app was
  answering, or where a block went missing. `noterSondage()` logs a transition — HTTP status, body
  size, and the shape of the intentions parsed — so an empty queue says so once and goes quiet.
  Logging every probe would drown the journal: it beats every 2 s. The early return that skips
  decryption (non-200, empty body) goes through it too — it is one of the places a message can
  vanish without a trace.
- **The Ayla SDK is silent in logcat.** A full process capture contains no `LanModule`,
  `CreateDPCommand` or `AylaLog` tag; what is observable phone-side stops at De'Longhi's own
  service. Everything below that has to be instrumented here.
- ⚠️ **An app's property READ is not resolved by the HTTP response — it is resolved by a datapoint
  WE post, and only if that POST carries `?cmd_id=<n>` in its URL.** `AylaLanModule.getCommand()`
  reads `session.getParms().get("cmd_id")` and nothing else; without it the command dies on
  `defaultNetworkTimeoutMs` — **5 s**, measured — as `Timed out waiting for command response:
  LanCmd[1]=property.json?name=d302_monitor`. The app then retries forever, which is what
  `lecture d302_monitor (×72)` in the journal actually was: one request, retried, not 72.
  **And the datapoint itself is a BARE object** — `new JSONObject(payload.data).getString("name")`
  — so our `{properties:[{property:…}]}` wrapper raised a `JSONException` and the app answered
  `400 Bad message JSON`: the multiplexer's whole point, one real read for N recipients, had been
  pushing messages nobody could read, while the journal truthfully said "état rediffusé".
  `paquetDatapoint()` and `cheminAvecCmd()` in `appproxy.mjs` hold both rules, `verif-apps.mjs`
  pins them, and `faux-app.mjs` now reports the read's verdict in three branches (appariée / sans
  cmd_id / jamais répondue).
- ⚠️ **5 s is shorter than a round trip to the appliance**, which takes one command per visit every
  2.5 s — so waiting for the machine before answering IS not answering. `m.dernieresValeurs` keeps
  the last **raw** value per property (kept before any decoding: a value we cannot decode must
  still be servable), the read is answered from it immediately, and a refresh is queued only when
  that value is older than `FRAICHEUR_LECTURE_APP` (10 s). When we hold nothing, the `cmd_id` is
  parked in `app.lectures` and consumed by the machine's eventual push — so the pairing happens on
  both paths. **`d302_monitor` is read with `0x75`, not as an Ayla property**, and an app's request
  therefore joins the very task `/pilotage`'s "Lire l'état" queues, merging on `cle: "presence"`:
  the button, `/`, and every connected phone watch that one value — one real read, N recipients.
- ⚠️⚠️ **A datapoint ack has THREE things to get right, and each one alone makes the app call the
  command failed while the appliance actually did it.** Symptom seen live: the machine turns on
  for real, the phone says the connection failed. From `AylaLanModule.handleDatapointAck`:
  **(1) the URI decides** — `PropertyUpdateHandler.post()` does `endsWith("ack.json") ?
  handleDatapointAck(…) : handlePropertyUpdateRequest(…)`, so an ack posted to
  `/property/datapoint.json` is read as a property write, nothing is resolved, and the app's
  `_ackTimeout` (10 s) fires `TimeoutError`; **(2) the payload is the BARE object**, not
  `{properties:[{property:…}]}` — the SDK does `fromJson(payload.data, CreateDatapointAck.class)`,
  so a wrapped ack yields `id = null`, matches no command, and raises `PreconditionError`;
  **(3) `ack_status` must be `200`**, an HTTP code reused as an application status —
  `if (ack.ack_status == Status.OK.getRequestStatus())` succeeds, anything else becomes
  `ServerError(…, "Datapoint NAK")`, so `0` is read as an explicit refusal. `CHEMIN_ACK` and
  `paquetAck()` in `appproxy.mjs` hold all three, `verif-apps.mjs` pins them, and `faux-app.mjs`
  now routes on the URI like the real SDK — it used to accept an ack on `datapoint.json`, so it
  was blind to exactly this.
- ⚠️ **The ack is owed to any property carrying an `id`, INCLUDING one we do not relay.** It says
  "received", not "executed" — it is a transport ack, and treating it as a business validation is
  what broke the real app. Measured: the official app opens **every** session by writing
  `device_connected`, a property we have no reason to relay to the appliance — and the ignore
  branch `return`ed without acking. From the phone's side the machine it had just introduced
  itself to did not answer, so it went no further and **not one command was ever sent**. The
  registry showed it and nobody could read it: session established, datapoints received,
  `commandes = 0` for the whole life of the entry. `accuserSiDemande()` now handles both paths
  and the journal line says `· accusée`, because "ignorée" alone reads as "unanswered" when the
  opposite is what happens. `faux-app.mjs` opens its session the same way and prints whether the
  ack came back, so the bench can fail on this rule; `verif-apps.mjs` pins it on the pure side.
- **A timed-out poll invalidates the session, because a response we never read may have been
  produced.** `commands.json` is polled with a 4 s deadline; if the request reached the phone, the
  phone encrypted its answer and **its outbound stream advanced while ours did not** — nothing
  recovers from that. It used to surface two polls later as an unreadable block, with no line
  linking it to the expiry that caused it. `ETIMEDOUT` now re-keys immediately, behind the same
  15 s debounce; a key exchange never touches the appliance. Same treatment when `decapsulate`
  itself refuses (bad padding) — that path logged and went back to polling a stream that would
  never become readable again.
- **`relancerSessionApp` logs the MOTIVE, not just the verdict**, and the unreadable block is kept
  verbatim. "Désynchronisé" was observed three times a session for days with no line saying what
  had caused it, which left the cause at the rank of a hypothesis. The CBC signature is readable
  by eye — a wrong chaining value dirties only the leading block, hence garbage ending cleanly in
  `…a":{}}`.
- `POST /local_reg.json` carries **`?dsn=`** on the first registration only (`!_isActive` branch).
  It is the one moment the protocol says out loud which appliance the app believes it is talking
  to, hence the only chance to refuse a request that is not ours. A `PUT` carries none, but always
  follows a `POST`.
- ⚠️ **A relayed command carried NO merge key, so an app piled up.** Reported from real use: six
  identical `sélection de profil (0xa9) · profil 1` tasks waiting in the queue, each one about to
  tell the machine what the one before it had just told it — the official app asserts its current
  profile at every session open, and it opens several. `cleFusion()` in `ecam-args.mjs` now
  supplies the key, and it lives there because **idempotence is a property of the protocol, not a
  policy of the caller**: `0xA9` (re-asserting a profile) and any frame whose `ECAM_OPS` nature is
  `lecture` (asking twice is asking once) get one; `0x75` deliberately returns the `"presence"`
  key the queue already uses everywhere, so an app's state request and `/pilotage`'s "Lire l'état"
  are one task. **Everything else returns `null`, and that is a decision rather than an omission** —
  asking for two coffees is not asking for one, so a dispense, a stop and an on/off each keep their
  own line, and so does a command absent from the table (a frame we cannot name is a frame whose
  effect we do not know; merging it would delete a command on a guess). Both emitters read the same
  rule — the relay and `/api/command` — or the same frame would merge on one path and not the other.
  Two limits worth knowing: the other *named* read keys (`checksums`, `bean:n`, `reglages95:…`) are
  unchanged, so the same read asked by an app and by a page still makes two tasks; and merging never
  takes the **running** task, only waiting ones, so the worst case is two copies, not N. The merge
  is on the TASK and never on the ack — `accuserSiDemande` still fires once per request, which is
  correct: the ack carries transport, not execution.
- **App commands go through the same queue as everything else**, rank `COMMANDE`. An app request
  is worth a UI request, no more; and the scheduler guarantees they do not collide — which the
  machine's single slot emphatically does not. ⚠️ **A relayed write reaches a real appliance**: it
  can start a preparation or persist a recipe. That is the point, and it is why every relay is
  logged and why `/pilotage` lists who is connected.
- Only `m.send` is relayed. An app writing anything else is **logged and ignored**, never guessed.
- **A relayed frame that targets a profile sets `m.activeProfile`**, exactly as `/api/command`
  does. This is not hypothetical: the *very first* command a real De'Longhi app relayed to us was
  `0D 06 A9 F0 01` — a profile select. The app asserts its own current profile at session open,
  taken from a phone-side preference defaulting to 1. Without it, a phone connecting silently moves
  the appliance's active profile while our pages keep showing the old one — the failure this file's
  "any new command that targets a profile must also set `m.activeProfile`" rule exists to prevent.
  `profilVise()` reads it from both layouts: `0xA9` carries it plainly at byte 4, `0x83` encodes it
  as `(profile << 2) | action` in the last byte before the CRC. The change is logged, because a
  profile switch decided by a third party is precisely what one needs to be able to trace.

**`/pilotage` gained an "Applications branchées" panel**, rendered **even when the multiplexer is
off**: hiding it would make the feature invisible to anyone not reading the docs, and "no
applications" is not the same information as "we are not looking". It lists connections *and*
refusals (`dsnInconnu`, `sansCle`, `echecEchange`…), because that is the impersonation-monitoring
half — without it, someone trying their luck on the LAN leaves no visible trace. Refusals fold on
consecutive identical entries with a `×N` count, same rule as the journal. **No session ever
leaves `vueApps()`**: a session is derived from the LAN key, so "no endpoint returns the key"
applies to what descends from it.

**There are TWO journals, and the boundary is the point: the main one keeps what REACHES the
appliance, `LOG_APPS` keeps the conversation with the phones.** A connected app is chatty — it
re-announces, it polls, and every state the machine pushes is re-broadcast to each of them; poured
into the main journal that traffic drives off screen, in seconds, the very lines one opens the page
for, namely what the coffee machine answered. `LA()` is `L()`'s twin (same folding of consecutive
identical lines — never drop the `repetitions` count when rendering — same `sseTouch()`, without
which the page would not know there is anything new), with one difference: the app id is a
**column**, not a message prefix, which is what lets you follow one phone among three. It accepts a
registry entry *or* a bare address, because refusals happen before an entry exists — and those are
the ones you most want to see. It travels on `GET /api/apps`, which `/pilotage` already polls, so
tracing costs no extra request.

**It renders as its own full-width section, the twin of the machine journal** — same `pleine`, same
`card log`, same line rendering — and sits immediately *above* it. Two chronologies of equal rank:
what the coffee machine answered on one side, what the phones asked on the other, and reading them
side by side is exactly what one does when an app command does not go through. As a sub-heading
inside the "Applications branchées" card it read as an appendix to the list; it is that list's
counterpart. It comes first because the phone's conversation is upstream — it is what triggers
whatever the machine ends up answering. Unlike the panel above it, it is rendered **only when the
multiplexer is active**: that panel has to be able to say "we are not looking", which no journal
line can say, and once that sentence is on screen an empty journal would only repeat it, less
clearly.

One line is deliberately written to **both**: `app aN a imposé le profil P`. The active profile is
a state of the *appliance*, so it belongs to the machine's chronology; and a third party decided
it, so it belongs to the apps' one too. A relayed command therefore appears on both sides under two
angles — "a1 asked for this" here, "the task leaves for the machine" there — which is not a
duplicate: the first says who wanted it, the second says what became of it.

Writing that journal is also what finally made the **state re-broadcast** visible: the very heart of
the multiplexer — one real read, N recipients — was logged nowhere, surviving only as a cumulative
counter. It is also the only trace of what an application RECEIVED from us.

**`src/lib/ecam-args.mjs` is THE ECAM referential** — pure, proven by `scripts/verif-args.mjs` in
CI (20 assertions). It holds the operation table (`ECAM_OPS`), the reading of a frame going **out**
(`opTrame`, and `natureTrame` / `describeFrame` / `profilVise` over it), the reading of one coming
**in** (`opReponse`), the 16-bit parameter table (`TWO`), and the argument decoder. Everything in
`server.mjs` that names a command reads that one table: the two journals, the task labels, and the
**scheduler** — `natureTrame` is what decides whether a step waits for a response or for a presence
window, so the table is not decoration, it changes behaviour.

It was assembled out of three places that each held a copy. `TWO` existed **three** times
(`server.mjs`, `beverages.mjs` as `TWO_BYTE`, and the decoder); `ECAM_OPS` and `opTrame` lived in
`server.mjs` where only that file could reach them. A duplicated protocol table diverges at the
first addition **without raising anything** — you get plausible, wrong values, which in a journal
used to decide whether a real appliance just poured a coffee or overwrote a recipe is the worst
possible outcome. `beverages.mjs` now re-exports `TWO` under its old name rather than declaring it.

**The decoder is the inverse of this file's frame builders**, each case naming the one it mirrors.
What is not protocol is **injected** (a beverage's name for this machine, a setting's name), so the
module knows neither a model's catalog nor the names typed on the appliance. Arguments are inserted
**before** the hex, because that is the order one reads them in; the bytes never disappear.
`describeFrame(f, { octets: false })` drops them for a **task label** — the Activité panel says what
is going to the machine, it is not a byte dumper, and both journals carry the bytes anyway.

⚠️ **Never guess, and say so loudly when you cannot.** An unhandled command returns `null` from the
argument decoder and keeps its raw bytes; an operation absent from `ECAM_OPS` renders as **`commande
NON IDENTIFIÉE (0x..)`**, in capitals, **and keeps its bytes even in the short form** — a short label
for a frame nobody recognises would say nothing at all. That is not an error path, it is the
discovery path: see the reverse-engineering section below.

**The three places a relayed command is now readable.** `App a2 · commande` said nothing about what
was reaching the appliance, and it was the only line the Activité panel showed — one could watch a
task go by without being able to tell a coffee from a recipe being overwritten. The decoded
description now travels as a **parameter** of the `appWrite` message (`App {app} · {commande}`), and
it stays French from the server for the same reason journal lines do: it is the same text, produced
by the same table, and two wordings for one frame would contradict each other at the first protocol
change. `startProgram`'s journal line gained the arguments too, so the machine journal and the app
journal describe one frame the same way.

**Rebroadcast states are named, both halves of them.** The app journal used to print `état rediffusé
· d263_3_rec_priority` — a property name and nothing else, unreadable to anyone who does not know
the table by heart, and silent about what the value contained. `libelleEtat()` names the **property**
(via `nomPropriete()`, which inverts the catalog's own `boundsProp` / `profileProp` builders rather
than copying a second table of names, plus `profilePropInfo`, `REGLAGE_PROPS` and the bean-slot
pattern) **and the command its frame carries** (via `opReponse`, same `ECAM_OPS`). Two deliberate
limits: the **monitor prints only its state byte and idle/running** — adding the percentage would
break `LA()`'s folding of identical lines during a preparation, where the machine pushes every 1–3 s
and every push goes to every app, drowning the journal in a progression the machine journal already
shows; and **bytes are attached only to the unknown**, since elsewhere they would repeat, worse, what
the machine journal decodes.

**The same guard was missing on the OUTGOING side, where it matters more — the value gets relayed
to a real appliance.** Seen live in the app journal: `commande NON IDENTIFIÉE (0x37) · trame 45 da
37 88 …`, while an ECAM frame starts `0x0D` and that one starts `0x45`. It was not an unknown
command, it was **not a frame at all**, and `0x37` was merely the byte that happened to sit there.
`opTrame` decoded base64 with no shape or header check — the same `Buffer.from(x, "base64")` trap
fixed months earlier on the incoming side and never carried across. The filter now lives once, in
`octetsEcam()`, and both directions read it; `describeFrame()` answers `valeur non-trame` with the
bytes **unstripped** (the 4 trailing bytes are timestamps only inside a frame) plus the original
base64. The stake is the discovery signal itself: a mislabelled value **manufactures a finding that
does not exist** and hides the one true fact, that this is not a frame. That value has since been
identified — `p097j6.d.s0()`, a constant hardcoded in the app (`doc/commandes-cafe.md` § 14.5), sent
once per Wi-Fi session; it is **named, not decoded**, and deliberately kept OUT of `ECAM_OPS`, since
`0x37` is not a command byte.
**The wrong hypothesis it produced is worth keeping, because it was the reasonable one.** Twelve
bytes shown, four stripped: sixteen, exactly one AES block — this file's own signature for a
dirtied leading block — and a probe timeout was indeed recorded on that same session. "Not
application bytes at all, look upstream" was a sound reading, and it was false. Three independent
proofs killed it: the phone logs the bytes **before encryption** (a dirtied CBC block cannot appear
in the sender's own log), their CRC-CCITT/`0x1D0F` over bytes 0-9 equals bytes 10-11, and they sit
verbatim in the binary, identical across three sessions. The method rule to carry forward: **when
"it is noise" and "it is signal" compete, the signal hypothesis is the one that is refutable
cheaply — test it first.** Verifying a CRC on the bytes in hand costs three lines; hunting a
journal for what might have gone missing upstream can run for hours and conclude nothing. The
stripping, incidentally, turned into the confirmation: the CRC only lands if the split was right,
so the four removed bytes were the timestamp `Y1()` appends to **every** value (`finalPacket size :
16` = 12 + 4). It was right by coincidence — it assumed an ECAM frame where there was none — and
not stripping what you cannot read remains the rule.
**A property whose value is not a frame no longer gets one invented — and that was misrouting, not
just a bad label.** `handleProperty` read its command byte with `Buffer.from(value, "base64")[2]`,
and that call **never throws**: it ignores what is not base64 and returns bytes that look like
something. Visible half: `device_connected = 1787407876`, a plain unix timestamp the real app writes
to us, was journalled as `commande 0x3b non décodée — d7 bf 3b e3 4e fc ef` — seven invented bytes
where the value was readable as it stood. Invisible half, and the worse one: that fabricated byte is
what **dispatches** the decoding, so any value whose third byte happened to be `0xA2` went to
`decodeParameters` and filed imaginary counters in the database. Dispatch now goes through
`opReponse`, which checks the base64 shape *then* the ECAM header (`0xD0` or `0x0D`) and returns
`null` otherwise, sending the value cleanly to `default` where it is kept verbatim.

**Treat it as a reverse-engineering instrument, not just a status panel.** The official app is the
only emitter in the world that produces frames we have never seen, and it does not replay them — so
whatever is not captured as it goes past is lost. Two consequences already in the code. A write to a
property we do not relay is ignored *for the appliance* but **not for the journal**: its payload is
recorded verbatim by `chargeBrute()`, where the line used to name the property and drop the bytes —
and a property we do not relay is by definition protocol we do not yet know, i.e. exactly what one
comes here for. And `chargeBrute()` deliberately does **no** interpretation, unlike `describeFrame()`
which strips the 4 trailing timestamp bytes: stripping is right when you know what you are looking
at and wrong the moment you do not, because a tool that has already decided what to discard can no
longer teach you anything (same lesson as `/regtoken.json`, where rebuilding the "obvious" response
meant betting on a field list nobody knew). It prints both hex — to compare against the tables in
`doc/commandes-cafe.md` — and the original base64, which pastes straight into a test or a replay,
with the truncation **stated** rather than silent. For the same reason an unrecognised request is
logged at 400 characters, not 160: a request truncated to 160 cannot be analysed. The other half of
the round trip — what the machine answered — stays in the machine journal by the boundary above; the
two sections sit one under the other precisely so the correlation is a glance.

**That is what the decoding is FOR: finding what is not in the referential yet.** Naming what we
already know is only half of it — the other half is that everything we do *not* know now stands out
instead of blending in. Three markers, all in capitals so they survive a scroll: `commande NON
IDENTIFIÉE (0x..)` for an operation absent from `ECAM_OPS`, `PROPRIÉTÉ NON IDENTIFIÉE` for an Ayla
property `nomPropriete()` cannot name, and `valeur non-trame` for a value that is not ECAM at all.
Each keeps its bytes, in both hex (to compare against `doc/commandes-cafe.md`) and base64 (to paste
into a test). The corollary is a rule about the table itself: **an entry missing from `ECAM_OPS` for
a response the server decodes perfectly would produce a false discovery signal**, so
`verif-args.mjs` asserts that every command byte `handleProperty` routes has an entry
(`0xA1 0xA2 0xA3 0xA4 0xA6 0xA8 0xAA 0xB0 0xBA 0x95`). Adding a decoder means adding its line to the
table in the same breath.

⚠️ **`scripts/faux-app.mjs` must stay faithful on the response bodies, and one line proves why.** It
used to answer `datapoint.json` with an `encapsulate("{}")`, where the real SDK returns an **empty**
body (`AylaLanModule.handlePropertyUpdateRequest` → `newFixedLengthResponse(getResponseCode(),
MIME_JSON, "")`). That advanced the fake app's outbound AES stream by one message the server never
decrypted — it discards that POST's body, as the protocol allows — so the server's inbound stream
stayed one message behind and the **first block** of the next `commands.json` came out as garbage
while the rest read perfectly: in CBC a wrong chaining value only dirties the leading block, the
following ones re-align on the ciphertext preceding them inside the same message. Hence the very
recognisable `…a":{}}` tail after unreadable bytes — **the exact signature seen with the real app,
but from a completely different cause** (two concurrent polls, fixed since). A bench that is
unfaithful on precisely one point manufactures the symptom it exists to catch; that is the worst
service it can render. When a demo run shows a desync, check for a stray `faux-app.mjs` from an
earlier run first — a process holding port 8888 from before an edit runs the OLD code, and the new
one dies on `EADDRINUSE` while the old one keeps answering.

**Two scripts prove the chain without hardware**, and they are the pattern to follow:
`scripts/faux-app.mjs` plays a client, `scripts/fausse-machine.mjs` plays the appliance. Run
together against a `PROXY_APPS=1` server they demonstrate the central claim — **one datapoint from
the machine, two applications served, each in its own stream** (verified). `faux-app` is
deliberately read-only: it cannot build an ECAM frame and never will.

**The central claim is now PROVEN with real clients, on 2026-08-22 at 19:38.** Two official
De'Longhi apps — a Pixel 7 Pro (`a1`) and a Galaxy Tab (`a2`), different Android versions —
held simultaneous sessions against one appliance whose local-peer slot fits exactly one. Every
state read once off the machine left twice, each in its own AES stream, both readable, with no
unreadable block and no key-exchange loop:

```
19:38:55  OUT a1  état rediffusé · sélection de profil (0xa9)
19:38:55  OUT a2  état rediffusé · sélection de profil (0xa9)
19:38:56  OUT a1  état rediffusé · réponse ECAM · sélection de profil (0xa9)
19:38:56  OUT a2  état rediffusé · réponse ECAM · sélection de profil (0xa9)
```

That is the inference this file and `doc/spec-proxy-multi-app.md` both flagged as unclosable by
any local test — a real app might check what `faux-app.mjs` does not. It does not.

**What is still NOT proven**: the mDNS responder (spec step 1) is unwritten, so an app cannot
find us by itself — both apps above reached us through a **binat** rewriting the appliance's
`ip:80` to the server. That is a deployment answer, not a protocol one, and it is the remaining
gap. Worth recording from the same session: the SDK's own startup errors are transient and
identified — `404 No device found` (15 B) and `404 No LAN module found` (19 B) from
`CommandHandler.get()`, and a `500` of 60 B that is **not** an `AylaLanModule` error body but
NanoHTTPD's router catching an exception (`"Error: " + class + " : " + message`, plaintext).
None of them carries an encrypted payload, so `porteUneCharge()` correctly leaves the stream
untouched — at the cost of discarding a body that was readable as it stood.

## Internationalisation

**next-intl**, French only for now. `messages/fr.json` is the single catalog; `src/i18n/request.ts`
returns the locale and messages, wired via `createNextIntlPlugin` in `next.config.mjs`; the root
layout wraps the (client) pages in `NextIntlClientProvider`.

**No locale segment in the URL** — deliberately. `server.mjs` intercepts `/api/*` and `/local_lan/*`
before Next, and a `[locale]` segment would move every page for no benefit while there is one
language. The extension point for a second language is `src/i18n/request.ts` (cookie or
`Accept-Language`), which leaves the pages untouched.

**A missing translation key is invisible to `tsc` and to the build**, because every next-intl
translator has the same type and the key is only resolved at render — it surfaces as
`MISSING_MESSAGE` in the browser console, i.e. only if someone opens that page *and* looks. It
happened: `fmtAge` was handed the `dashboard` translator when `ageSeconds`/`ageMinutes`/`ageHours`
live in `power`. `scripts/verif-messages.mjs` now runs in CI over every literal `t("key")` — 741 of
them. Two things to know about its reach, because a check trusted beyond its scope is worse than no
check: it accepts a key found in **any** namespace the name is bound to in that file (`page.tsx`
binds `t` to both `power` and `editor`, and without scope analysis nothing says which applies), and
it **cannot see the failure that motivated it** — a key requested inside a helper the translator was
passed to. For that class, the guard is the comment on `fmtAge` naming the namespace it needs.

**A third class it cannot see: a key that resolves but is handed the wrong *parameters*.** Reported
from real use — `task.saveToProfile` ("Enregistrer {boisson} dans le profil {profil}") was built as
`{ k, p: { profil }, ...bevRef(m, bev) }`, and `bevRef` returns **either** `{p}` **or** `{refs}`, so
the spread silently wiped the whole `p` and with it `profil`. next-intl then threw
`FORMATTING_ERROR` at render. What makes it nasty is that it fires **only on machines where a
recipe was renamed**: everywhere else `bevRef` takes the `refs` branch and there is no collision, so
it is invisible in testing. `taskLabel`'s catch keeps the page alive by falling back to the server
label, which is exactly why it went unnoticed. Merge explicitly — `p: { …, ...(r.p ?? {}) },
refs: r.refs` — the `dispense` branch already did it correctly and was the model for the fix.

**Never put `<...>` in a message string.** next-intl reads angle brackets as rich-text tags, so a
message like `0D 08 A2 0F <id> <qty>` fails to parse and the UI prints the raw key
(`stats.protocolNote`) instead of the text. Use brackets or backticks for protocol placeholders.

**Nothing translatable crosses the API.** The server sends **protocol identifiers** — `slug` for a
beverage, `name` (the ECAM enum) for a parameter — and the client translates them via
`src/i18n/labels.ts` (`useBeverageLabel`, `useParamLabel`, `useUnitLabel`, `useCategoryLabel`),
each falling back to the server label when a key is missing. **Monitor sensors and alarms follow the
same rule**: alarms already did (the `alarm` namespace, keyed by ECAM enum name), sensors did not —
`/` and `/pilotage` rendered `sw.label`, the server's French, straight into the UI. They now go
through the `sensor` namespace via `sensorLabel()` in `machineState.ts`, same fallback. The `label`
still in `MONITOR_SWITCHES` is for the **terminal log only**. `verif-monitor.mjs` asserts every
entry of `MONITOR_SWITCHES` and `MONITOR_ALARMS` has a catalogue key — a table extended on one side
only shows a raw identifier, and only when that sensor happens to fire. A **name typed on the machine**
(`machineName`: "Lacteso", "Malongo") is user data and is **never** translated.

The French labels still in `beverages.mjs` / `profiles.mjs` are for the **terminal log only**; UI
text comes from the catalog.

**Task labels now travel as a key, not a sentence.** They were the last thing the server sent in
French *for display*, and `/pilotage`'s "Activité" panel rendered all three of its blocks raw. A task
carries `i18n: { k, p, refs }` — `k` in the `task` namespace, `p` plain parameters — while `label`
stays as the terminal-log text and the client's fallback. **`refs` is the part worth understanding**:
a task label sometimes embeds an identifier that already has a translation elsewhere (a beverage
slug, a setting key, the family an import read), so it is passed as a reference and dereferenced
client-side by `taskLabel(tache, t, deref)` in `machineState.ts`. It is a separate field rather than
a prefix inside the value on purpose: a name **typed on the machine** ("Lacteso") is a plain
parameter, and nothing may mistake it for an identifier to translate. A task queued without a key
renders exactly as before — the fallback is the point, not an oversight. `verif-tasks.mjs` asserts
the key survives `vue()`; without that, a dropped field would degrade silently back to server French.

**`/api/profiles` order entries carry `slug` + `machineName`, not just a French `label`.** That one
was not only a translation gap: emitting the catalog label meant those entries **bypassed
`machineBeverageNames`**, so a custom slot renamed on the machine showed under its factory name —
the exact divergence `/api/beverages` had already fixed ("Recette perso 1" on one page, "Lacteso" on
the other), reproduced on `/profils`, which was also the only page not using `useBeverageLabel`.

What is still French from the server, deliberately: the **journal** lines (`e.msg`) and the
cancellation motives, which are stored rather than rendered. If a motive ever reaches the UI it
joins the rule above. The 22 `iced`/`mug` slugs with no `beverage` key are all `unaddressable` on
STRIKER_BEST only — a documented limit, not a gap.

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
