/**
 * Normalize sslmode to verify-full to suppress pg v9 deprecation warning.
 * Railway/Neon URLs use sslmode=require which pg now warns about.
 */
export function normalizeSslMode(url: string): string {
  return url.replace(/sslmode=(prefer|require|verify-ca)\b/, "sslmode=verify-full");
}
