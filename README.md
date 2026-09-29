# Caramel's Personal Site
### caramel.dog & caramel.horse

This is a personal site powered by [WebUI](https://github.com/microsoft/WebUI).

## Develop

```bash
npm install
npm run build   # renders every page to static HTML in dist/
npm run preview # build and serve locally with Cloudflare's runtime (wrangler dev)
```

- Content lives in `data/site.json`: text, links, projects and jobs.
- Templates live in `src/` (WebUI components, light DOM); styles are Tailwind v4 in `src/styles/site.css`.
- `build.mjs` compiles the templates once and renders each page (`/`, `/about/`, `/projects/`, `/cv/`, `/contact/`, `404.html`). Output ships **zero client-side JavaScript**.
- To add an interactive island later: give that component a `.ts` file and switch the build to `plugin: "webui"` with a client entry (see the [WebUI docs](https://microsoft.github.io/webui/)).
- `dist/` is plain static files and can be served by any static host; it's deployed to Cloudflare Workers (see below).

### Tokens in `data/site.json`

- `{age}` is computed from `site.dob`; the date of birth itself is never rendered.
- `{pronouns}`, `{gender}`, or any other text field under `site`, is inserted as-is.
- `{badge-<name>}` is the hashed URL of `badges/<name>.*`.
- An unknown token fails the build.

### 88x31 badges

Drop 88×31 originals (png, gif, webp or jpg) into `badges/`. The build (`badges.mjs`):

- tries several encodings and keeps the smallest: palette PNG, lossless PNG or lossless WebP for static badges; GIF or animated WebP for animated ones;
- saves a still first frame for animated badges, served to visitors with reduced motion turned on;
- writes `dist/badges/<name>.<hash>.<ext>`, so files can be cached forever;
- shrinks oversized badges to 88×31 when that can be done cleanly:
  - exact whole multiples (176×62, …) are shrunk pixel-perfectly (nearest-neighbour);
  - badges larger than 88×31 with nearly the same shape (within 2%, e.g. 100×35) are shrunk smoothly (Lanczos). The build logs a warning, and may use a 16-colour PNG if it's visually identical;
- fails if a badge is over 5 kB after compression, the whole wall is over 96 kB, or a badge is smaller than 88×31 or a different shape.

Home shows up to 3 badges from `home.badges` (e.g. `"{badge-mspaint}"`), inlined into the HTML so there are no extra requests; empty slots show as skeletons. `/88x31/` (unlisted, noindex) lists every badge, lazy-loaded. To add a link or alt text, add `"buttons": [{ "badge": "mspaint", "href": "https://…", "alt": "…" }]`.

## Deploy (Cloudflare Workers)

`wrangler.jsonc` deploys `dist/` as a static-assets-only Worker; there is no Worker script.

- `npm run deploy` builds the site and deploys it (`wrangler deploy`; run `npx wrangler login` once first).
- Missing pages get `404.html` with a 404 status, and `/about` redirects to `/about/`.
- `public/_headers` sets security headers on every response and caches `/badges/*` forever (the files are content-hashed). Everything else revalidates on each request.
- Custom domains: `caramel.dog` and `caramel.horse`. Both zones must be on the same Cloudflare account.

To deploy on every push with Cloudflare Workers Builds, connect the GitHub repo in the dashboard and set:

- Build command: *(leave empty; `wrangler deploy` runs the build itself)*
- Deploy command: `npx wrangler deploy`
- Non-production branch deploy command: `npx wrangler versions upload`

Node 22 comes from `.node-version`, and the footer's commit id from `WORKERS_CI_COMMIT_SHA`.

