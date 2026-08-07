// ============================================
// Tier System Utilities
// ============================================

const TIER_SLUGS = {
  'premier/strategic': 'premier-strategic',
  'value/preferred': 'value-preferred',
  'registered': 'tier-registered',
};

export function tierSlug(tierName) {
  if (!tierName) return 'tier-registered';
  return TIER_SLUGS[tierName.toLowerCase()] || 'tier-registered';
}

export const TIER_OPTIONS = ['Premier/Strategic', 'Value/Preferred', 'Registered'];

// Recast brand: Primary Blue → Accent Cyan → neutral gray.
// Keep in step with --color-tier-* in css/variables.css.
export const TIER_COLORS = {
  'premier-strategic': '#0000CC',
  'value-preferred':   '#00BFFF',
  'tier-registered':   '#9B9A9B',
};

export const TIER_ICONS = {
  'premier-strategic': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.76 3.57 3.94.57-2.85 2.78.67 3.93L7 10.07l-3.52 1.78.67-3.93L1.3 5.14l3.94-.57L7 1z" fill="currentColor"/></svg>',
  'value-preferred': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.5 7.5L6.5 9.5L10 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/></svg>',
  'tier-registered': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>',
};
