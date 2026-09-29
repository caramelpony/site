// 88x31 badge pipeline. Drop originals in badges/ (png, gif, webp, jpg); the build:
//  - tries a few encodings per badge and keeps the smallest (static: palette PNG,
//    lossless PNG, lossless WebP; animated: GIF, lossless WebP),
//  - shrinks oversized badges to 88x31 when that can be done cleanly (see fitTo88x31),
//  - saves a still first frame for animated badges (served on prefers-reduced-motion),
//  - names outputs by content hash so they can be cached forever,
//  - fails the build if a badge or the whole wall goes over budget.
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, basename, join } from "node:path";

const SRC = "badges";
const URL_BASE = "/badges"; // served from dist/badges/, cached forever (see public/_headers)
const MAX_BADGE = 4 * 1024; // bytes, per encoded badge (animated + still)
const MAX_WALL = 96 * 1024; // bytes, all badges together
const INPUTS = new Set([".png", ".gif", ".webp", ".jpg", ".jpeg"]);

const W = 88, H = 31;
const MAX_ASPECT_DRIFT = 0.02; // how far from 88:31 an oversized badge may be and still be resized

// Decide how to get a badge to 88x31:
//  - exactly 88x31: use as-is,
//  - an exact whole multiple (176x62, ...): nearest-neighbour, pixel-perfect,
//  - larger with nearly the same aspect ratio (e.g. 100x35): smooth Lanczos resize,
//  - smaller, or a clearly different shape: refuse (upscaling/squashing looks broken).
function fitTo88x31(width, height) {
  if (width === W && height === H) return { resize: null };
  const k = width / W;
  if (Number.isInteger(k) && height === H * k) return { resize: { kernel: "nearest" }, note: `${k}x multiple, nearest-neighbour` };
  const drift = Math.abs(width / height / (W / H) - 1);
  if (width >= W && height >= H && drift <= MAX_ASPECT_DRIFT) {
    return { resize: { kernel: "lanczos3" }, note: `resized from ${width}x${height} (aspect off by ${(drift * 100).toFixed(1)}%)` };
  }
  return { error: `is ${width}x${height}; needs to be 88x31, a whole multiple of it, or larger with a matching aspect ratio` };
}

async function smallest(candidates) {
  const out = await Promise.all(candidates.map(async ([ext, make]) => ({ ext, buf: await make() })));
  return out.reduce((a, b) => (b.buf.length < a.buf.length ? b : a));
}

const fit = (pipeline, resize) => (resize ? pipeline.resize(W, H, { fit: "fill", kernel: resize.kernel }) : pipeline);

// A resized badge is already lossy, so it may also use a 16-colour (4-bit) palette PNG,
// often less than half the size. Kept only if it stays visually identical: mean
// per-channel error at most MAX_MEAN_ERROR out of 255.
const MAX_MEAN_ERROR = 3;
async function meanError(buf, ref) {
  const px = await sharp(buf).ensureAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < px.length; i++) sum += Math.abs(px[i] - ref[i]);
  return sum / px.length;
}

async function encodeStatic(input, resize) {
  const img = () => fit(sharp(input, { pages: 1 }), resize);
  const candidates = [
    ["png", () => img().png({ palette: true, colours: 256, dither: 0, effort: 10, compressionLevel: 9 }).toBuffer()],
    ["png", () => img().png({ compressionLevel: 9, effort: 10 }).toBuffer()],
    ["webp", () => img().webp({ lossless: true, effort: 6 }).toBuffer()],
  ];
  if (resize) {
    const ref = await img().ensureAlpha().raw().toBuffer();
    const buf = await img().png({ palette: true, colours: 16, dither: 0, effort: 10, compressionLevel: 9 }).toBuffer();
    if ((await meanError(buf, ref)) <= MAX_MEAN_ERROR) candidates.push(["png", async () => buf]);
  }
  return smallest(candidates);
}

function encodeAnimated(input, resize) {
  const img = () => fit(sharp(input, { animated: true }), resize);
  return smallest([
    ["gif", () => img().gif({ effort: 10, dither: 0, reuse: true }).toBuffer()],
    ["webp", () => img().webp({ lossless: true, effort: 6 }).toBuffer()],
  ]);
}

function emit(outDir, name, { ext, buf }) {
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.${ext}`;
  writeFileSync(join(outDir, file), buf);
  const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/webp";
  return { url: `${URL_BASE}/${file}`, dataUri: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length };
}

/** Build every badge into `<distDir>/badges/`. Returns { [name]: badge }. */
export async function buildBadges(distDir) {
  const outDir = join(distDir, URL_BASE);
  mkdirSync(outDir, { recursive: true });
  const badges = {};
  const errors = [];
  let wall = 0;

  for (const f of readdirSync(SRC).sort()) {
    if (!INPUTS.has(extname(f).toLowerCase())) continue;
    const name = basename(f, extname(f));
    const input = readFileSync(join(SRC, f));
    const meta = await sharp(input).metadata();
    const plan = fitTo88x31(meta.width, meta.pageHeight ?? meta.height);
    if (plan.error) {
      errors.push(`${f}: ${plan.error}`);
      continue;
    }
    if (plan.note) console.warn(`badge ${name}: ${plan.note}`);

    const animated = (meta.pages ?? 1) > 1;
    const main = emit(outDir, name, animated ? await encodeAnimated(input, plan.resize) : await encodeStatic(input, plan.resize));
    const still = animated ? emit(outDir, `${name}-still`, await encodeStatic(input, plan.resize)) : null;
    const bytes = main.bytes + (still?.bytes ?? 0);
    wall += bytes;
    if (bytes > MAX_BADGE) errors.push(`${f}: ${bytes} B after compression, budget is ${MAX_BADGE} B`);

    badges[name] = { name, src: main.url, data: main.dataUri, still: still?.url ?? "", stillData: still?.dataUri ?? "" };
    console.log(`badge ${name.padEnd(20)} ${String(input.length).padStart(6)} B -> ${String(bytes).padStart(5)} B  ${main.url}`);
  }
  if (wall > MAX_WALL) errors.push(`badges total ${wall} B, budget is ${MAX_WALL} B`);
  if (errors.length) throw new Error("badge errors:\n  " + errors.join("\n  "));
  return badges;
}
