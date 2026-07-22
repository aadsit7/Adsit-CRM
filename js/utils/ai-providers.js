// ============================================================
// AI Providers — shared, dependency-free constants
// ============================================================
// A single source of truth for the AI backends a preset can run on.
// Kept free of any imports so every layer can use it without pulling in
// DOM, sheet, or config code:
//   • sheets.js        — normalize the provider column on load/save
//   • ai.js            — route callClaudeStream to the right backend
//   • admin-setup.js   — render the per-preset provider slider
//   • randy.js         — carry the active preset's provider into activeMode
//
// Anthropic (Claude) is the default and preserves the app's existing
// direct-from-browser streaming path. Kimi (Moonshot AI) is proxied
// through the Apps Script web app — see callKimiStream in ai.js.

export const DEFAULT_AI_PROVIDER = 'anthropic';

// Order here is the order the slider renders its options in.
export const AI_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude (default)' },
  { id: 'kimi',      label: 'Kimi',      hint: 'Moonshot AI' },
];

const VALID_IDS = new Set(AI_PROVIDERS.map(p => p.id));

/**
 * Coerce any stored/loose provider value to a known provider id.
 * Unknown, empty, or legacy (pre-column) values fall back to the default
 * so old presets keep behaving exactly as they did before this feature.
 */
export function normalizeProvider(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return VALID_IDS.has(v) ? v : DEFAULT_AI_PROVIDER;
}

/** Human-readable label for a provider id (for UI + toasts). */
export function providerLabel(value) {
  const id = normalizeProvider(value);
  const match = AI_PROVIDERS.find(p => p.id === id);
  return match ? match.label : id;
}
