// ============================================
// Password Hashing (SHA-256 via SubtleCrypto)
// ============================================

/**
 * Hash a string with SHA-256 and return hex.
 * @param {string} message
 * @returns {Promise<string>} hex hash
 */
export async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
