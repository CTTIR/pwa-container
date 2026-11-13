# pwa-container

A self-hosted Docker container for small web apps, mainly **anonymous surveys**, each on its own
subdomain:

- **Surveys** are described in a JSON file. Participants open them from a link or QR code on their
  phone. No account or app installation is needed. The page keeps working on a weak connection:
  answers stay on the device until the server confirms them.
- **Single-use access codes per course** (optional per survey):
  - Organisers create a course, generate codes and print them as slips. Each slip has its own QR
    code that already contains the code. The print layout is either ten slips per A4 page to cut
    out or one large code per page; every printed page is a fixed-size block, so a page break never
    cuts through a slip.
  - A response needs an unused code and is linked only to the course, never to the code.
  - Results and exports can be filtered by course.
  - Courses and codes are stored in the database. In the administration codes can be listed,
    reprinted, blocked or unblocked, and courses renamed.
- **Other web apps / PWAs** (any folder of static files with an `index.html`) can be uploaded
  through the administration page and are served unchanged on their own subdomain.
  - If switched on per app, they can send **data records** to the container (`POST /api/records`,
    or the offline-capable helper `/_pwa/records.js`).
  - The administration shows the collections and offers downloads as XLSX, CSV and JSON.
- An **administration page** lists all apps and handles the everyday tasks:
  - Open, close, enable or disable an app.
  - Set or randomise its subdomain, and show or download its QR code.
  - View survey results and export them as XLSX, CSV or JSON.
  - Work with all single responses of a survey in its "Datenbank" section: filters by course,
    version and field, table, charts, per-course comparison, and downloads as CSV, XLSX, JSON or
    RDS (R data frame with labels) with a codebook.
  - See every app's own database in the "Datenbanken" overview (global administration).
  - Upload new surveys and apps, and delete test responses.

Survey responses are anonymous by construction:
- **What is stored:** the answers, the survey version and, for coded surveys, the course. There is
  **no date or time of any kind**, no IP address, user agent, cookie or participant code, and the
  server writes no request logs.
- **One database per app:** each app has its own `db/<app>/answers.sqlite` and
  `db/<app>/codes.sqlite`; `apps.sqlite` is only the register. A survey's administration reaches
  its own database and nothing else.
- **Codes kept apart from answers:** a single-use code only gets a "used" mark in `codes.sqlite`.
  The response is written separately to `answers.sqlite` under a fresh random id, never in the
  same transaction.
- **No logs or order on disk:** the databases use a rollback journal that is deleted after every
  commit, with `secure_delete`. `answers.sqlite` is rewritten in random-id order after responses
  arrive (VACUUM), and the other files hourly. No log and no page layout reveals which code went
  with which answer, or the order of submissions.
- **Results page: only closed groups of five.** The summaries on the results page are released
  when the group is closed (the course for coded surveys, otherwise the survey) and has at least 5
  responses.
  - Free texts are only shown there separately from ratings, shuffled per question.
  - Nobody can see which individual code was used.
  - Exception: a survey with `liveResults: true` (see Settings) shows its results at once, with
    exact counts while it is open, so single answers can be watched as they arrive.
- **Full data for the survey's own administration:** the global administration and the survey's
  own credentials can read every stored single response of that survey, including free texts,
  version and course, at any time through the "Datenbank" section
  (`/admin/api/results/<id>/data`). Rows come in random order and without any date, but whoever
  holds these credentials can watch the number of responses grow and may recognise people in small
  courses. State this in the survey's privacy notice.
- **Closing:** a survey with courses is closed course by course ("Umfrage für diesen Kurs
  schließen"): that course takes no more answers and its codes expire, while the other courses go
  on. Closing the whole survey (every course at once) is left to the global administration. A
  survey without courses is closed as a whole, also from its organiser entry.

## How it works

| Part | Technology |
|---|---|
| Server | Node.js 24 (`node:http`, `node:sqlite`), no runtime dependencies, runs TypeScript directly |
| Participant app | React 18 + Vite, installable PWA (Workbox service worker), offline outbox with automatic resend |
| Administration | Second page of the same build, served only after HTTP Basic authentication |
| Storage | `apps.sqlite` (register) and one database per app in `/data/db/<id>/` (`answers.sqlite`, `codes.sqlite`); uploaded apps in `/data/apps/<id>/`. Data of the former shared `codes.sqlite` / `answers.sqlite` is moved there on start. |
| Routing | `<label>.APP_DOMAIN` per app; either a label list for a host-side renderer (`ROUTES_JSON_FILE`, recommended) or a Traefik file-provider file (`TRAEFIK_DYNAMIC_FILE`) |

```
https://ADMIN_HOST/admin                 administration of all apps (global admin)
https://ADMIN_HOST/admin/results/<id>    results, courses and codes of one survey
https://ADMIN_HOST/admin/records/<id>    data records of one app
https://<label>.APP_DOMAIN/              a survey or uploaded web app (participants)
https://<label>.APP_DOMAIN/admin         organiser entry of a survey (global admin or that survey's credentials)
https://<label>.APP_DOMAIN/#code=XXXX-XXXX   survey link with a single-use code (as printed on the slips)
https://ADMIN_HOST/s/<surveyId>          path-based survey link (also works without subdomains)
```

Without `APP_DOMAIN` (e.g. local use) surveys are reachable at `/s/<surveyId>` and uploaded apps
at `/a/<id>/`. Build those apps with that base path.

## Surveys

A survey is one `survey.json`. See
[`examples/surveys/example-course-feedback`](examples/surveys/example-course-feedback/survey.json).

- **Item types:**
  - `scale`: a scale with optional "not applicable" value
  - `matrix`: one row rated in several columns, e.g. before / after; stored as `<id>_<column>`
  - `text`: single or multi-line, with `maxLength`
  - `choice`: single or multiple choice
  - `photo`: up to `max` photos (1–10, default 3)
- **Scales:** `display` is `"buttons"` (default) or `"slider"`. A slider needs consecutive
  ascending integer values (e.g. 1 … 5) and shows a track from the low to the high end with every
  value marked; it has no value until it is touched. With `step` (only on sliders, must divide 1,
  e.g. `0.1`) it is continuous: every multiple of `step` between the first and last value is an
  answer (e.g. `4.7`), and summaries count each value towards the nearest marked option. Matrix
  rows on a slider scale are sliders too.
- **Scale items** may also have:
  - `anchors` (`min`, `max`): the words at the two ends of a slider, instead of the first and
    last option labels
  - `comment` (`label`, optional `id`, `maxLength` up to 20000): a free-text remark under the
    item, stored as its own text field (default key `<id>_txt`)
  - `photos` (optional `id`, `max` 1–10 with default 3, `label`): photos to the item, stored as
    their own field (default key `<id>_foto`)

  These three are only allowed on `scale` items.
- **Photos:** taken or chosen on the device, scaled down and sent as JPEG (at most 3 MB each). The
  server keeps only well-formed JPEGs, removes their metadata (EXIF incl. location, XMP, comments)
  and sets file times to the epoch, so neither content nor files tell when anyone took part. They
  are stored per app next to the answers database, not inside the answers; the answers only hold
  their random ids.
- **Content:** sections with optional descriptions and scale legend, intro and privacy text, a
  thank-you text, and `**bold**` emphasis in texts. A section may carry a short `label` (1–8
  characters, e.g. `"IV"`) shown instead of its number; `sectionNav: true` adds a menu to jump
  between sections.
- **Notice:** an optional `notice` (`heading`, `paragraphs`, `confirm`) is shown at the top of the
  start page, e.g. for a test version. The start button stays disabled until its checkbox is
  ticked, and the server refuses answers without that confirmation (`notice_not_confirmed`).
- **Settings:**
  - `opensAt` / `closesAt` and `maxResponses`. The administration can also open or close a survey
    by hand.
  - `subdomain`: the preferred label when the survey is first installed; otherwise a random one is
    assigned.
  - `accessCodes`: `"required"` or `"optional"` switches on single-use codes per course. Drafts
    then stay only in the browser tab, for shared devices.
  - `gated: true` (needs `accessCodes: "required"`): the survey link alone shows only a code
    entry; the questionnaire, photos and answer details are served only with a valid unused code,
    and the survey's pages address it by a neutral alias instead of its id.
  - `personalDevices: true` (needs `accessCodes`): drafts with their code are kept on the device
    across tabs, for surveys answered on people's own phones.
  - `liveResults: true`: the administration sees the results at any time, without the minimum
    group of five and without closing first; counts are exact while the survey is open, and
    closing a course stays reversible. This gives up the protection of the results page, so use it
    only where participants are not anonymous towards the organisers anyway (e.g. named
    observers), and say so in the survey's privacy notice.
  - `theme`: the name of a folder in `/themes` with a `theme.css` that overrides the CSS variables
    in [`src/styles.css`](src/styles.css).
- **Versions:** once a version has responses, its content cannot change without increasing
  `version`. The server refuses to load such a file, and every response records the version it was
  given with.

Surveys come from two places:

1. **Provisioned**: folders `/surveys/<id>/survey.json` mounted read-only from a deployment
   repository. `docker kill -s HUP pwa-container` reloads them.
2. **Uploaded** through the administration page and stored in `/data/apps/<id>/`.

Validate a file with `node server/cli.ts validate path/to/survey.json`.

**Paper version:** a survey folder may also hold `paper.pdf`, a printable questionnaire for people
who cannot take part online. The administration page of the survey then offers it for download
("Fragebogen als PDF (Papierversion)"), to the global and the survey's own credentials. Completed
forms are typed into the survey afterwards; with access codes, one unused code of the course per
form. The container only serves the file (up to 20 MB, must be a PDF); keeping it in step with
`survey.json` is up to the deployment repository.

**Manual:** a survey folder may likewise hold `manual.pdf`, a guide to the survey's administration
page. It is offered first on that page ("Anleitung zur Verwaltung (PDF)"), to the same credentials
and under the same limits as `paper.pdf`.

## Data records from web apps

An uploaded app sends records to its own host. Collecting is off until it is switched on for that
app in the administration:

```html
<script src="/_pwa/records.js"></script>
<script>
  pwaRecords.submit({ score: 7, answers: ['a', 'b'] }, { collection: 'sessions' });
</script>
```

- **Helper script:** records wait in `localStorage` while offline and are resent automatically.
- **Without the helper:** `POST /api/records` with `{"collection": "sessions", "data": {…}}`
  answers 201.
- **Storage:** the server keeps the record and its collection, in random order, without any date.
  A client record id de-duplicates resends.
- **Limits per app:** at most 50,000 records and 25 MB in total, 256 KB per record. Records nested
  deeper than 32 levels or with more than 20,000 values are refused.
- **Exports** are streamed.
- **Downloads:**
  - JSON with the original structure.
  - CSV and XLSX with nested fields flattened to dotted columns, one sheet per collection.

## Administration access

Credentials live in a JSON file mounted at `/config/admins.json` and are never stored in the image:

```json
{
  "global": [{ "user": "admin", "hash": "scrypt$…" }],
  "surveys": { "<surveyId>": [{ "user": "course-lead", "hash": "scrypt$…" }] }
}
```

Brute-force protection:
- **Per client** (IPv4 address or IPv6 /64, including the shared overflow bucket): at most two
  password checks at a time, and a short, growing delay after each failure.
- **Cooldown:** after 10 failures within 15 minutes the client cools down (10 seconds, doubling up
  to 5 minutes).
- **Narrow lanes:**
  - Password checks of cooling-down clients go through a shared penalty lane.
  - While more than 200 failures happened in the last five minutes, the penalty lane also takes
    every client with failures of its own. Clean clients that never signed in successfully use a
    separate lane, so failing attackers cannot fill it.
  - Clients that signed in successfully for that page keep the normal path. They are remembered
    in memory only, as keyed hashes, for 30 days or until a restart.
  - Each lane runs one check at a time and at most one every two seconds, so guessing is
    limited to about one attempt per second overall.
  - Correct credentials are never refused outright; under load the answer may be "try again".
- **Passwords:** at least 16 characters. `node server/cli.ts new-password` prints a random
  24-character password with its hash.

Client addresses are needed for this, so the server keeps them for this one purpose only. They are
held only in memory, as keyed hashes whose secret changes on every restart, and they are never
written to disk or logs. Participant requests are never looked at.
Behind Traefik set `TRUST_PROXY=1` so the address set by Traefik is used. The server logs a warning
if requests arrive through a proxy without it.

Create a random password and its hash with `docker exec pwa-container node server/cli.ts new-password`,
or hash your own (16 characters or more) with
`printf '%s' 'long password' | docker exec -i pwa-container node server/cli.ts hash-password`.
Global users manage everything. Survey (or app) users see only that survey's results, courses,
codes and single responses (the "Datenbank" section), or that app's records. Survey users may
delete a small course together with its responses (after typing the course name, e.g. a test
course); released courses and courses with 5 or more responses, and purging all responses of a
survey, are reserved for the global administration, so those evaluated cannot remove their
evaluation. Signed-in
administrators can change their own password on their page; the new hash goes to
`admin-passwords.json` in the data volume (`PASSWORD_OVERRIDES_FILE`), the credentials file stays
read-only, and a new hash set there by the operator takes precedence. Survey users sign in at `<label>.APP_DOMAIN/admin` or
`ADMIN_HOST/admin/results/<id>`. The file is re-read on
every request, so changes apply without a restart.

## Deployment behind Traefik

See [`compose.example.yaml`](compose.example.yaml).

1. Create a wildcard DNS record `*.APP_DOMAIN` pointing to the server, plus `ADMIN_HOST`.
2. Routes, recommended way: set `ROUTES_JSON_FILE`. The container then writes only
   `{"labels": […]}` to a directory it owns.
   - A small root-owned script on the host validates the labels and renders the Traefik
     file-provider YAML, so a compromised container cannot route other hosts.
   - The simpler `TRAEFIK_DYNAMIC_FILE` mode makes the container write that YAML itself.
   - Every router disables access logs (`observability.accessLogs: false`), and Traefik obtains a
     certificate for every new subdomain through its HTTP challenge.
3. Put the reserved subdomains of the domain's other services into `RESERVED_SUBDOMAINS`.
4. Start the container, sign in at `https://ADMIN_HOST/admin`, test the survey, then delete the test
   responses (administration → "Weitere Aktionen", or `node server/cli.ts purge <id> --yes`).

Uploaded web apps are trusted administrator content. Each runs on its own subdomain, so it is
isolated from the administration and from other apps by the browser's same-origin rules.

## Limits

- **Requests:**
  - Request bodies: 64 KB per response, 256 KB per record. Bodies over the limit are answered at
    once and not buffered.
  - At most 512 connections.
- **Surveys:** at most 5,000 responses (or `maxResponses`) and 20 MB per survey. Surveys without
  codes accept at most 120 responses per minute.
- **Codes:** unknown codes are answered at most 30 times per minute and survey, so codes cannot be
  found by guessing.
- **Web-app records:** at most 50,000 records and 25 MB per app.

## Residual risks

These limits are inherent; deployments should state them.

- **Organisers hold the codes.** Whoever has the code list could answer with unused codes and so
  isolate a real participant in a small course.
  - Hand out slips at random, keep no list of who got which slip, and block slips that were not
    handed out.
  - The survey's own administration can read every single response, including free texts, at
    any time. Give these credentials only to people who may see all answers, and say so in the
    privacy notice.
- **Operator access.** Root on the server, or the hosting provider, can read the databases and
  the traffic between the reverse proxy and the container while the process runs. Use an
  encrypted volume and encrypted backups, and do not back up while a course is open.
- **Subdomain labels are not secret.** Every certificate appears in public certificate-
  transparency logs.
- **Shared devices.** Drafts of coded surveys live only in the browser tab, and pending
  submissions are kept per person. A link with a code can still remain in the browser history.
- **Basic authentication** has no logout. Organisers should sign in only on their own devices
  and close the browser afterwards.

## Develop

```bash
npm ci
npm run build            # participant app + administration in dist/
npm test                 # schema, API, access rules, subdomain routing
DATA_DIR=./data SURVEYS_DIR=examples/surveys THEMES_DIR=examples/themes \
  ADMIN_CREDENTIALS_FILE=./admins.json PORT=8080 npm start
```

With `APP_DOMAIN=localhost` and `ADMIN_HOST=pwa.localhost`, Chromium resolves
`http://<label>.localhost:8080/` locally, so subdomain routing can be tested without DNS.

## Licence

No licence has been chosen yet. Public visibility alone does not grant permission to reuse the code.
