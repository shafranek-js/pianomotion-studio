/**
 * GitHub Pages cannot send `frame-ancestors`/X-Frame-Options. Refuse to run
 * the studio inside another page so clickjacking does not get an interactive
 * UI just because the header-only defence is unavailable.
 */
export function isFramed(top: unknown, self: unknown): boolean {
  return top !== self;
}
