// ============================================
// HTML Sanitizer — shared allowlist-style pass
// ============================================
//
// One sanitizer for every place the portal renders HTML it did not build
// itself: AI "response-container" replies (the AI Assistant chat and Randy),
// AI document-analysis output stored in description/transcript rows, and any
// other sheet-stored rich text. All of that is untrusted — model output is
// steered by whatever the spreadsheet holds, and the spreadsheet is shared —
// so it must never reach innerHTML unfiltered.
//
// Built on the browser's own parser rather than regex: DOMParser hands back
// attribute values entity-decoded, so the checks below see exactly what the
// browser would act on. The regex blacklists this replaces were bypassable
// (`<svg/onload=…>` carries no whitespace before the handler; an
// entity-encoded `javascript:` href survived a literal replace).
//
// Styling survives on purpose — class names, inline styles, tables, <style>
// blocks — because the sanitized HTML is the product (formatted AI replies,
// Quill-authored notes). Only what can execute, load, or capture input is
// stripped.

// Elements that execute, load a subresource, or capture input — never part
// of a styled text response.
const FORBIDDEN_ELEMENTS =
  'script,iframe,frame,frameset,object,embed,link,meta,base,form,input,textarea,select,button,img,svg,math,template,video,audio,source,track';

/**
 * Sanitize an HTML string for innerHTML rendering. Returns HTML with
 * script-capable elements/attributes removed; in a non-browser context
 * (tests) it fails closed to fully escaped text.
 */
export function sanitizeHtml(html) {
  const raw = String(html ?? '');
  if (typeof DOMParser === 'undefined') {
    return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html');

  doc.body.querySelectorAll(FORBIDDEN_ELEMENTS).forEach(n => n.remove());

  // <style> blocks stay (AI response-container replies use them, and CSS
  // cannot run script) unless they reach for the network via @import/url().
  doc.body.querySelectorAll('style').forEach(s => {
    if (/@import|url\s*\(/i.test(s.textContent)) s.remove();
  });

  for (const node of doc.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'background') {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'data') {
        if (!isSafeUrl(attr.value)) node.removeAttribute(attr.name);
      }
      if (name === 'style' && /url\s*\(|expression\s*\(/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === 'A' && node.hasAttribute('target')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return doc.body.innerHTML;
}

/**
 * Whether a URL is safe to use as a link/src target. Browsers strip control
 * characters and whitespace before scheme detection — do the same, then
 * refuse the schemes that execute. Relative URLs, fragments, http(s),
 * mailto and tel all pass.
 */
export function isSafeUrl(url) {
  const v = String(url ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return !/^(javascript|data|vbscript):/.test(v);
}

/**
 * A URL made safe for an href attribute: the URL itself when isSafeUrl
 * accepts it, '#' otherwise. For links whose destination comes from model
 * output (research sources, LeadCheck reports, bio links).
 */
export function safeUrl(url) {
  return isSafeUrl(url) ? String(url ?? '') : '#';
}
