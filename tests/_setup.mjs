// Minimal browser-env shims so we can import ai.js / config.js under Node.
// These modules touch localStorage and document.createElement but only to
// support runtime config reads and stripHtml() — trivial to stub.

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

if (!globalThis.document) {
  globalThis.document = {
    createElement: () => {
      const el = {
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
        get textContent() {
          // Minimal HTML → text: strip tags, decode the handful of
          // entities stripHtml() consumers care about.
          return String(this._html)
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        },
        get innerText() { return this.textContent; },
      };
      return el;
    },
  };
}
