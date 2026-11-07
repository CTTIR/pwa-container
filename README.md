# pwa-container

A self-hosted Docker container for small web apps, mainly **anonymous surveys**, each on its own
subdomain:

- **Surveys** are described in a JSON file. Participants open them from a link or QR code on their
  phone. No account or app installation is needed. The page keeps working on a weak connection:
  answers stay on the device until the server confirms them.
- **Other web apps / PWAs** (any folder of static files with an `index.html`) can be uploaded
  through the administration page and are served unchanged on their own subdomain.
- An **administration page** lists all apps and handles the everyday tasks:
  - Open, close, enable or disable an app.
  - Set or randomise its subdomain, and show or download its QR code.
  - View survey results and export them as XLSX, CSV or JSON.
  - Upload new surveys and apps, and delete test responses.

Survey responses are anonymous by construction:
- The server stores only the answers, the survey version and the **calendar day** of submission.
- It never stores times, IP addresses, user agents, cookies or participant codes, and it writes no
  request logs.
- Rows have random keys and are exported in random order, so the order of submission cannot be
  reconstructed.

## How it works

| Part | Technology |
|---|---|
| Server | Node.js 24 (`node:http`, `node:sqlite`), no runtime dependencies, runs TypeScript directly |
| Participant app | React 18 + Vite, installable PWA (Workbox service worker), offline outbox with automatic resend |
| Administration | Second page of the same build, served only after HTTP Basic authentication |
| Storage | One SQLite file in `/data`; uploaded apps in `/data/apps/<id>/` |
| Routing | `<label>.APP_DOMAIN` per app; Traefik routes are written to a file-provider file |

```
https://ADMIN_HOST/admin                 administration (global admin)
https://ADMIN_HOST/admin/results/<id>    results of one survey (global admin or that survey's credentials)
https://<label>.APP_DOMAIN/              a survey or uploaded web app
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
- **Content:** sections with optional descriptions and scale legend, intro and privacy text, a
  thank-you text, and `**bold**` emphasis in texts.
- **Settings:**
  - `opensAt` / `closesAt` and `maxResponses`. The administration can also open or close a survey
    by hand.
  - `subdomain`: the preferred label when the survey is first installed; otherwise a random one is
    assigned.
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

## Administration access

Credentials live in a JSON file mounted at `/config/admins.json` and are never stored in the image:

```json
{
  "global": [{ "user": "admin", "hash": "scrypt$…" }],
  "surveys": { "<surveyId>": [{ "user": "course-lead", "hash": "scrypt$…" }] }
}
```

Create a hash with `printf '%s' 'long password' | docker exec -i pwa-container node server/cli.ts hash-password`.
Global users manage everything; survey users only see that survey's results. The file is re-read on
every request, so changes apply without a restart.

## Deployment behind Traefik

See [`compose.example.yaml`](compose.example.yaml).

1. Create a wildcard DNS record `*.APP_DOMAIN` pointing to the server, plus `ADMIN_HOST`.
2. Pre-create `pwa-container.yml` (owned by uid 1000) in Traefik's file-provider directory and mount
   it at `/traefik/pwa-container.yml`. The container writes one router per app host into it.
   Traefik then obtains a certificate for every new subdomain through its HTTP challenge.
3. Put the reserved subdomains of the domain's other services into `RESERVED_SUBDOMAINS`.
4. Start the container, sign in at `https://ADMIN_HOST/admin`, test the survey, then delete the test
   responses (administration → "Weitere Aktionen", or `node server/cli.ts purge <id> --yes`).

Uploaded web apps are trusted administrator content. Each runs on its own subdomain, so it is
isolated from the administration and from other apps by the browser's same-origin rules.

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
