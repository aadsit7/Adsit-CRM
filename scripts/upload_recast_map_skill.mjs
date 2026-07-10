#!/usr/bin/env node
// ============================================================
// DEPRECATED — do not run.
// ============================================================
// This script uploaded a Recast MAP PDF skill to Anthropic so the
// original V1 flow could invoke it via code_execution. That flow
// was abandoned because Anthropic's Files API blocks browser CORS
// even with the dangerous-direct-browser-access header, so a
// GitHub-Pages-hosted browser can't download the sandbox-generated
// PDF. Current flow: requestMapPdfJson() in js/utils/ai.js +
// buildMapPdf() in js/utils/map-pdf-builder.js.
//
// The file is kept so that if a future operator wants to revive a
// Skills-based path (e.g. with a server proxy in front of the
// Files API) they have the working uploader to build from. The
// skills/recast-map-pdf/ reference_map_pdf.py file is still the
// approved visual reference for the PDF output — just not executed.
//
// DO NOT invoke this from CI or docs — it will create a new skill
// in your Anthropic workspace that is never used by the portal.
// ============================================================
//
// Original usage (no longer supported):
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node scripts/upload_recast_map_skill.mjs
//
// Original behavior:
//   * First run  → creates the skill, writes skill_id to skills/.skill_id
//   * Subsequent → publishes a new version of the same skill
// ============================================================

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ───────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILL_DIR = resolve(
  REPO_ROOT,
  process.env.RECAST_MAP_SKILL_PATH || './skills/recast-map-pdf'
);
const SKILL_ID_FILE = resolve(REPO_ROOT, './skills/.skill_id');
const SKILL_FILES = ['SKILL.md', 'reference_map_pdf.py', 'example_output_reference.md'];

const BETA_HEADER = 'skills-2025-10-02';
const DISPLAY_TITLE = 'Recast MAP PDF';

// ── Pretty logging ──────────────────────────────────────────
function log(msg)  { console.log(`[upload-skill] ${msg}`); }
function fail(msg) { console.error(`[upload-skill] ERROR: ${msg}`); process.exit(1); }

// ── Guardrails ──────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  fail('ANTHROPIC_API_KEY is not set. Run: export ANTHROPIC_API_KEY=sk-ant-...');
}

async function pathExists(p) {
  try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

// ── Load SDK (deferred so the missing-dep error is friendly) ─
let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch (err) {
  fail(
    '@anthropic-ai/sdk is not installed. Run: npm install\n' +
    `(underlying error: ${err?.message || err})`
  );
}

// ── Locate and read skill files ─────────────────────────────
if (!(await pathExists(SKILL_DIR))) {
  fail(`Skill folder not found at ${SKILL_DIR}`);
}

log(`Reading skill files from ${SKILL_DIR}`);
const fileEntries = [];
for (const name of SKILL_FILES) {
  const full = join(SKILL_DIR, name);
  if (!(await pathExists(full))) {
    fail(`Expected skill file is missing: ${full}`);
  }
  const buf = await readFile(full);
  fileEntries.push({ name, buf });
  log(`  • ${name} (${buf.length} bytes)`);
}

// The SDK's beta.skills endpoints accept the same multipart file shape that
// the rest of the Files API uses. We pass each entry as a File-like object
// via the SDK's toFile helper so the SDK handles streaming correctly.
let toFile;
try {
  ({ toFile } = await import('@anthropic-ai/sdk'));
} catch {
  // Older SDK shapes expose it differently; try the default export.
  toFile = Anthropic.toFile;
}
if (typeof toFile !== 'function') {
  fail('Your @anthropic-ai/sdk version is missing toFile(). Try: npm install @anthropic-ai/sdk@latest');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (!client?.beta?.skills?.create || !client?.beta?.skills?.versions?.create) {
  fail(
    'Your @anthropic-ai/sdk version does not expose client.beta.skills.* — ' +
    'upgrade with: npm install @anthropic-ai/sdk@latest'
  );
}

// The API requires every file to live under a shared top-level
// directory, with SKILL.md at the root of that directory. Prefix each
// filename with the skill-folder name so the server sees a coherent
// structure like "recast-map-pdf/SKILL.md".
const SKILL_FOLDER_PREFIX = 'recast-map-pdf';
const files = await Promise.all(
  fileEntries.map(({ name, buf }) => toFile(buf, `${SKILL_FOLDER_PREFIX}/${name}`))
);

// ── Decide: create new, or publish new version? ─────────────
const hasExistingId = await pathExists(SKILL_ID_FILE);

try {
  if (!hasExistingId) {
    log('No existing skill ID found — creating a new skill.');
    const skill = await client.beta.skills.create(
      { display_title: DISPLAY_TITLE, files },
      { headers: { 'anthropic-beta': BETA_HEADER } }
    );
    if (!skill?.id) fail('API did not return a skill.id — payload was: ' + JSON.stringify(skill));
    await writeFile(SKILL_ID_FILE, skill.id + '\n', 'utf8');
    log(`Created skill: ${skill.id}`);
    log(`Wrote skill ID to ${SKILL_ID_FILE} (gitignored)`);
    console.log('');
    console.log('============================================================');
    console.log(`Paste this into js/config/skill_config.js: RECAST_MAP_SKILL_ID = '${skill.id}'`);
    console.log('============================================================');
  } else {
    const skillId = (await readFile(SKILL_ID_FILE, 'utf8')).trim();
    if (!skillId) fail(`${SKILL_ID_FILE} exists but is empty.`);
    log(`Existing skill ID: ${skillId}`);
    log('Publishing a new version…');
    const version = await client.beta.skills.versions.create(
      skillId,
      { files },
      { headers: { 'anthropic-beta': BETA_HEADER } }
    );
    log(`Published new version: ${version?.version || '(version field missing)'}`);
    console.log('');
    console.log('============================================================');
    console.log(`Skill ID unchanged — js/config/skill_config.js already points at '${skillId}'`);
    console.log('============================================================');
  }
} catch (err) {
  // Scrub anything that looks like an api key out of the error text before
  // printing, as a belt-and-braces guard.
  const raw = (err?.message || String(err));
  const safe = raw.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***REDACTED***');
  fail(`API call failed: ${safe}`);
}
