// Converts local unit/memory character art into optimized WebP thumbnails
// keyed by definitionId, for DefinitionImage's imageMap (see
// apps/ui/src/features/catalog-selection/definition-image-map.ts).
//
// Source images live outside the repo (personal Documents folder) and the
// output directories are gitignored — this script is a local dev tool, not
// part of the build or CI. Run it manually whenever character art changes:
//
//   mise exec -- pnpm --filter @muvluvgg/ui run assets:sync
//
// Override source directories with UNIT_IMAGE_SRC_DIR / MEMORY_IMAGE_SRC_DIR
// env vars if they differ from the defaults below.

import { readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(uiRoot, "..", "..");

const UNIT_IMAGE_SRC_DIR =
  process.env["UNIT_IMAGE_SRC_DIR"] ?? "/Users/komei/Documents/ユニット画像";
const MEMORY_IMAGE_SRC_DIR =
  process.env["MEMORY_IMAGE_SRC_DIR"] ?? "/Users/komei/Documents/メモリー画像";

const UNIT_OUT_DIR = path.join(uiRoot, "src/assets/units");
const MEMORY_OUT_DIR = path.join(uiRoot, "src/assets/memories");

const UNITS_JSON = path.join(repoRoot, "apps/api/catalog/units.json");
const MEMORIES_JSON = path.join(repoRoot, "apps/api/catalog/memories.json");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Known filename mismatches that don't survive whitespace-normalized exact
// matching (e.g. a missing leading "【" in the source filename). Add entries
// here rather than renaming source files, since those live outside the repo.
const UNIT_FILENAME_OVERRIDES = {
  UNIT_LUNA_HUNGRY: "博識なハングリーガール】 ルナ・メロウ.png",
};

function normalize(name) {
  return name.normalize("NFC").replace(/\s+/g, "");
}

async function loadDefinitions(jsonPath) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(jsonPath, "utf8");
  return JSON.parse(raw);
}

async function buildFileIndex(srcDir) {
  if (!existsSync(srcDir)) {
    return undefined;
  }
  const entries = await readdir(srcDir, { withFileTypes: true });
  const index = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      continue;
    }
    const base = entry.name.slice(0, -ext.length);
    index.set(normalize(base), entry.name);
  }
  return index;
}

// Source art (both units and memories) is landscape — roughly 16:9. Thumbnails
// are generated at that same ratio so `fit: cover` crops next to nothing, and
// the UI displays them in matching 16:9 boxes (DefinitionImage.module.css).
// Cropping to a square/portrait box instead lopped off ~40% of each image.
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 270;

async function convert(inputPath, outputPath) {
  await sharp(inputPath)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "cover", position: "attention" })
    .webp({ quality: 80 })
    .toFile(outputPath);
}

async function syncUnits() {
  const fileIndex = await buildFileIndex(UNIT_IMAGE_SRC_DIR);
  if (fileIndex === undefined) {
    console.warn(`[units] source dir not found, skipping: ${UNIT_IMAGE_SRC_DIR}`);
    return;
  }
  await mkdir(UNIT_OUT_DIR, { recursive: true });

  const units = await loadDefinitions(UNITS_JSON);
  let matched = 0;
  const unmatched = [];

  for (const unit of units) {
    const definitionId = unit.unitDefinitionId;
    const displayName = unit.metadata?.displayName ?? "";
    const overrideFilename = UNIT_FILENAME_OVERRIDES[definitionId];
    const filename = overrideFilename ?? fileIndex.get(normalize(displayName));

    if (filename === undefined) {
      unmatched.push(`${definitionId} (${displayName})`);
      continue;
    }

    await convert(
      path.join(UNIT_IMAGE_SRC_DIR, filename),
      path.join(UNIT_OUT_DIR, `${definitionId}.webp`),
    );
    matched += 1;
  }

  console.log(`[units] converted ${matched}/${units.length}`);
  if (unmatched.length > 0) {
    console.warn(`[units] unmatched (${unmatched.length}):`);
    for (const line of unmatched) {
      console.warn(`  - ${line}`);
    }
  }
}

async function syncMemories() {
  const fileIndex = await buildFileIndex(MEMORY_IMAGE_SRC_DIR);
  if (fileIndex === undefined) {
    console.warn(`[memories] source dir not found, skipping: ${MEMORY_IMAGE_SRC_DIR}`);
    return;
  }
  await mkdir(MEMORY_OUT_DIR, { recursive: true });

  const memories = await loadDefinitions(MEMORIES_JSON);
  let matched = 0;
  const unmatched = [];

  for (const memory of memories) {
    const definitionId = memory.memoryDefinitionId;
    const displayName = memory.metadata?.displayName ?? "";
    const filename = fileIndex.get(normalize(displayName));

    if (filename === undefined) {
      unmatched.push(`${definitionId} (${displayName})`);
      continue;
    }

    await convert(
      path.join(MEMORY_IMAGE_SRC_DIR, filename),
      path.join(MEMORY_OUT_DIR, `${definitionId}.webp`),
    );
    matched += 1;
  }

  console.log(`[memories] converted ${matched}/${memories.length}`);
  if (unmatched.length > 0) {
    console.warn(`[memories] unmatched (${unmatched.length}):`);
    for (const line of unmatched) {
      console.warn(`  - ${line}`);
    }
  }
}

await syncUnits();
await syncMemories();
