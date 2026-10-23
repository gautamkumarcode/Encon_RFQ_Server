/**
 * Canonical party-name normalization for the Client master.
 *
 * nameKey is the de-duplication key used to decide "is this the same client we
 * already have?". We only normalize presentation noise here — case, punctuation
 * and repeated whitespace — NOT suffix words (PVT/LTD/etc.), so genuinely
 * different parties are never merged. Suffix-insensitive matching is a UI
 * concern (the order form's "did you mean" guard), kept away from the stored key.
 */
export const normalizeNameKey = (name: string): string =>
  (name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
