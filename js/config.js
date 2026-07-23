// ============================================
// Partner Portal Configuration
// ============================================
//
// SETUP INSTRUCTIONS:
// 1. Go to https://console.cloud.google.com/
// 2. Create a new project (or select existing)
// 3. Enable "Google Sheets API"
// 4. Go to Credentials → Create Credentials → API Key
// 5. Restrict the API key to your GitHub Pages domain
// 6. Create a Google Spreadsheet with 3 sheets: "Partners", "Opportunities", "Events"
// 7. Share the spreadsheet as "Anyone with the link can edit"
// 8. Copy the spreadsheet ID from the URL:
//    https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit
// 9. Paste values below
//
// ADMIN GOOGLE SSO (OAuth client) SETUP:
// Admin sign-in uses a full-page Google OAuth redirect (works on iPhone/iOS,
// where the popup-based "Sign in with Google" button silently fails to load).
// For the redirect to come back to this site you MUST register the site URL
// under the OAuth client's "Authorized redirect URIs" (Credentials → your
// OAuth 2.0 Client ID → Authorized redirect URIs):
//   https://<your-github-pages-domain>/<repo>/
//   e.g. https://aadsit7.github.io/Partner-Portal/
// Keep the same URL under "Authorized JavaScript origins" too. The exact value
// to register is logged to the browser console on the login screen.

const RUNTIME_CONFIG_KEY = 'pp_runtime_config';

/**
 * Get a runtime config value (localStorage override → hardcoded fallback).
 */
export function getRuntimeConfig(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(RUNTIME_CONFIG_KEY) || '{}');
    if (key in stored) return stored[key];
  } catch { /* ignore */ }
  return CONFIG[key] || '';
}

/**
 * Set a runtime config value in localStorage.
 */
export function setRuntimeConfig(key, value) {
  try {
    const stored = JSON.parse(localStorage.getItem(RUNTIME_CONFIG_KEY) || '{}');
    stored[key] = value;
    localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(stored));
  } catch { /* ignore */ }
}

export const CONFIG = {
  // Google Sheets API
  API_KEY: 'AIzaSyDp93FQBEQjWsyLkGrQ0YFusnY94DVzDWw',
  SPREADSHEET_ID: '18Yhe3Yiq9_eI7kBxtFOzdu6Pb0_VUx730TYjq1xPjzI',
  SHEETS_BASE_URL: 'https://sheets.googleapis.com/v4/spreadsheets',

  // Apps Script Web App for file uploads to Google Drive.
  // Separate from the Sheets API above — handles listFiles / uploadFile / deleteFile.
  FILE_API_URL: 'https://script.google.com/macros/s/AKfycbwFURmpvnwu6Ge5Pyt2zJVMwwV4jcRIR8Q9BmUwQJyRM3l5Aq9PsFjdA-ysoDL1jQeK/exec',

  // Google OAuth (for Admin SSO login) — "Adsit CRM" client, whose
  // authorized redirect URI is https://aadsit7.github.io/Adsit-CRM/
  GOOGLE_CLIENT_ID: '206815760499-manavdgrggafbtp0l7q77ekh6n3f1gnq.apps.googleusercontent.com',

  // OAuth scope for Google Sheets read/write access (used by the silent
  // token-refresh client).
  OAUTH_SCOPES: 'https://www.googleapis.com/auth/spreadsheets',

  // Scopes requested by the admin sign-in redirect. Identity (openid/email/
  // profile) authorizes the account against ADMIN_EMAILS; the spreadsheets
  // scope returns a Sheets write token in the same sign-in, so one redirect
  // covers both logging in and saving.
  OAUTH_LOGIN_SCOPES: 'openid email profile https://www.googleapis.com/auth/spreadsheets',

  // Allowed admin email(s) — only these Google accounts can log in as admin
  ADMIN_EMAILS: ['aadsit7@gmail.com', 'adsitvideo@gmail.com'],

  // Anthropic API (for AI Assistant) — key stored in browser localStorage via runtime config
  ANTHROPIC_API_KEY: '',

  // Sheet names (must match your Google Spreadsheet tab names)
  SHEET_PARTNERS: 'Partners',
  SHEET_OPPORTUNITIES: 'Opportunities',
  SHEET_EVENTS: 'Events',
  SHEET_TRANSCRIPTS: 'Transcripts',
  SHEET_OPP_DESCRIPTIONS: 'Opportunity_Descriptions',
  SHEET_EVENT_DESCRIPTIONS: 'Event_Descriptions',
  SHEET_EVENT_CONTACTS: 'Event_Contacts',
  // Contacts extracted from a partner's description notes and attachments
  // (see js/utils/partner-contacts.js for the row contract).
  SHEET_PARTNER_CONTACTS: 'Partner_Contacts',
  // Saved partner-event playbook state, one row per event. Written by the
  // standalone Event Workspace (savePlaybook Apps Script action) and read by
  // the Event Analyzer as an optional evidence source. See apps-script/Code.gs
  // and apps-script/README.md for the row contract.
  SHEET_EVENT_PLAYBOOK: 'Event_Playbook',
  SHEET_MEETING_INDEX: 'Meeting_Index',
  SHEET_AI_CONVERSATIONS: 'AI_Conversations',
  SHEET_PARTNER_DOCUMENTS: 'Partner_Documents',
  SHEET_CUSTOM_PROMPTS: 'Custom_Prompts',

  // Support & Resources iframe URL
  SUPPORT_URL: 'https://partnerprogram.github.io/Application-Workspace/',

  // App info
  APP_NAME: 'Partner Portal',
  APP_VERSION: '1.0.0',

  // Session key
  SESSION_KEY: 'pp_user',

  // Default password for new partners (SHA-256 hash of "Portal2026")
  DEFAULT_PASSWORD: 'Portal2026',

  // Content visibility defaults (false = hidden, true = shown)
  SHOW_INACTIVE_PARTNERS: false,
  SHOW_PAST_EVENTS: true,
  SHOW_CANCELLED_EVENTS: false,
  SHOW_CLOSED_LOST_OPPS: false,
};
