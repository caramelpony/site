// Static site generator: compile WebUI templates once, render each page to plain HTML.
import { build, Protocol } from "@microsoft/webui";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildBadges } from "./badges.mjs";

const OUT = "dist";
const now = new Date();

// Age from DoB, as of build time. Rebuild (e.g. daily) to keep it current.
// Only the computed age is rendered; the DoB itself never reaches the page.
function ageOn(dob, date) {
  const [y, m, d] = dob.split("-").map(Number);
  const hadBirthday = date.getUTCMonth() + 1 > m || (date.getUTCMonth() + 1 === m && date.getUTCDate() >= d);
  return date.getUTCFullYear() - y - (hadBirthday ? 0 : 1);
}

// Commit id: CI env var first, then local git, else "dev".
function commitId() {
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("public", OUT, { recursive: true });
const badges = await buildBadges(OUT);

// Tokens in site.json text: {age}, any text field of "site" ({pronouns}, {gender},
// ...), and {badge-<name>} (that badge's hashed URL). Unknown tokens fail the build
// so typos don't ship. The DoB is only used for {age}; it never reaches a page.
const raw = readFileSync("data/site.json", "utf8");
const { dob, ...siteFields } = JSON.parse(raw).site;
const tokens = { age: String(ageOn(dob, now)) };
for (const [k, v] of Object.entries(siteFields)) if (typeof v === "string") tokens[k] = v;
for (const b of Object.values(badges)) tokens[`badge-${b.name}`] = b.src;
const unknown = new Set();
const site = JSON.parse(raw.replace(/\{([\w-]+)\}/g, (m, k) => (k in tokens ? JSON.stringify(tokens[k]).slice(1, -1) : (unknown.add(m), m))));
if (unknown.size) throw new Error(`unknown token(s) in data/site.json: ${[...unknown].join(", ")}`);
delete site.site.dob;
site.age = tokens.age;
site.build = { date: now.toISOString().slice(0, 16).replace("T", " ") + " UTC", commit: commitId() };
// Uptime: a service without `hours` renders as a skeleton bar. Once real data from
// status.caramel.dog is wired in, give each service 24 entries, oldest first:
// { label: "14:00 UTC", state: "up" | "degraded" | "down" }.

// Home badges: exactly 3 slots, images inlined as data URIs so the home page makes
// no extra requests. Empty slots render as skeletons.
const badgeByUrl = Object.fromEntries(Object.values(badges).map((b) => [b.src, b]));
site.home.badgeSlots = Array.from({ length: 3 }, (_, i) => {
  const url = site.home.badges[i];
  if (url === undefined) return { skeleton: true };
  const b = badgeByUrl[url];
  if (!b) throw new Error(`home.badges[${i}] is not a badge: ${url} (use {badge-<name>})`);
  return { alt: b.name, src: b.data, still: b.stillData };
});
if (site.home.badges.length > 3) console.warn(`home.badges: only the first 3 of ${site.home.badges.length} are shown`);

// 88x31 wall: every badge in badges/, as hashed files (lazy-loaded, cached forever).
// Optional per-badge extras in site.json: "buttons": [{ "badge": "<name>", "href": "...", "alt": "..." }].
const extras = Object.fromEntries((site.buttons ?? []).map((b) => [b.badge, b]));
site.buttons = Object.values(badges).map((b) => ({ alt: b.name, href: "", ...extras[b.name], src: b.src, still: b.still }));

// Email obfuscation, no JS: the halves are rendered in separate elements joined by
// an entity (&#64;), so no "x@y.z" string exists in the page source for scrapers to
// match. People see, select and copy the real address.
[site.contact.emailUser, site.contact.emailDomain] = site.contact.email.split("@");
delete site.contact.email;
site.contact.allLinks = [...site.socials, ...site.contact.links];

const pages = [
  { page: "home", title: "Home", out: "index.html" },
  { page: "about", title: "About", out: "about/index.html" },
  { page: "projects", title: "Projects", out: "projects/index.html" },
  { page: "cv", title: "CV", out: "cv/index.html" },
  { page: "contact", title: "Contact", out: "contact/index.html" },
  { page: "404", title: "Not found", out: "404.html" },
  // Unlisted: not in the nav, only reachable from "see more" on the home badges.
  { page: "88x31", title: "88x31", out: "88x31/index.html", noindex: true },
];

execFileSync("npx", ["@tailwindcss/cli", "-i", "src/styles/site.css", "-o", join(OUT, "site.css"), "--minify"], { stdio: "inherit" });

// No `plugin: "webui"`: that plugin adds hydration data + scripts. These pages have
// nothing to hydrate, so the output is plain HTML with zero client JS.
// Add it back (plus an index.ts) only if a page grows an interactive island.
const result = build({ appDir: "src", entry: "index.html", dom: "light" });
for (const w of result.warnings ?? []) console.warn("webui:", w);
const protocol = new Protocol(result.protocol);

// Drop source-formatting whitespace (a newline plus indentation between tags).
// Whitespace inside a line is left alone, so inline spacing is unchanged.
const minify = (html) => html.replace(/>\s*\n\s*</g, "><").replace(/\n\s*/g, " ");

const css = readFileSync(join(OUT, "site.css"));
const kb = (n) => (n / 1024).toFixed(1);
const gz = (buf) => gzipSync(buf, { level: 9 }).length;

// Each page's footer shows what loading that page costs: its HTML plus the
// stylesheet, raw and gzipped. Printing the number changes the size, so render,
// measure and re-render until it stops moving (2-3 passes).
let total = { raw: css.length, gz: gz(css) };
for (const p of pages) {
  let weight = { raw: "?", gz: "?" };
  let html;
  for (let pass = 0; pass < 5; pass++) {
    html = Buffer.from(minify(protocol.render({ ...site, page: p.page, pageTitle: p.title, noindex: p.noindex, weight }).toString("utf8")));
    const next = { raw: kb(html.length + css.length), gz: kb(gz(html) + gz(css)) };
    if (next.raw === weight.raw && next.gz === weight.gz) break;
    weight = next;
  }
  const file = join(OUT, p.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  total.raw += html.length;
  total.gz += gz(html);
  console.log(`${file.padEnd(26)} page+css ${weight.raw} kB, ${weight.gz} kB gz`);
}
console.log(`site total: ${kb(total.raw)} kB (${kb(total.gz)} kB gz)`);
