/**
 * OCC option symbol parsing + 0DTE (same-day) enforcement helpers.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The bot trades SPY 0DTE only. Earlier it could fall back to later-dated weekly
 * expiries (e.g. SPY260605...) because the unusual-options feed seeded a future
 * Friday and the selector accepted it when no same-day contract was present.
 * These helpers parse the canonical OCC symbol so expiry is derived from the
 * symbol itself (the source of truth that gets sent to the broker), not from a
 * separate, possibly-stale `expiry` field, and enforce that expiry == today's
 * SPY market date before any contract can be selected or ordered.
 *
 * OCC symbol layout (21 chars max): ROOT(≤6, padded) + YYMMDD + C|P + STRIKE(8,
 * price*1000). Example: SPY   260602C00758000  → SPY, 2026-06-02, Call, 758.0.
 * In practice this app uses the un-padded form `SPY260602C00758000`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ParsedOcc {
  root: string;
  /** Expiration as YYYY-MM-DD */
  expiry: string;
  side: "Call" | "Put";
  strike: number;
}

/**
 * Parse an OCC-style option symbol into root / expiry / side / strike.
 * Returns null if the symbol does not match the OCC layout.
 *
 * Accepts the padded 21-char form and the compact `SPY260602C00758000` form.
 */
export function parseOccSymbol(symbol: string): ParsedOcc | null {
  if (!symbol) return null;
  const s = symbol.trim().toUpperCase();
  // root = leading letters (1-6); then 6 digits date; then C/P; then 8 digits strike.
  const m = s.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;

  const [, root, yymmdd, cp, strikeRaw] = m;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // OCC years are two-digit; treat as 2000-2099 (valid through 2099).
  const fullYear = 2000 + yy;
  const expiry = `${fullYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const strike = Number(strikeRaw) / 1000;

  return {
    root,
    expiry,
    side: cp === "C" ? "Call" : "Put",
    strike,
  };
}

/**
 * Today's SPY market date as YYYY-MM-DD.
 *
 * SPY options trade on US equity-market sessions, so the "trading date" is the
 * New York calendar date. We use America/New_York to derive the date so a
 * server in any timezone (e.g. UTC on Render) computes the correct market day,
 * and so the early-morning hours before the open still resolve to the current
 * NY date rather than rolling a day early/late.
 */
export function marketDateNY(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Is the given OCC symbol a same-day (0DTE) contract for today's NY market date?
 * Expiry is parsed from the symbol itself, never trusted from a sibling field.
 */
export function isZeroDteSymbol(symbol: string, now: Date = new Date()): boolean {
  const parsed = parseOccSymbol(symbol);
  if (!parsed) return false;
  return parsed.expiry === marketDateNY(now);
}

/**
 * Resolve the expiration date (YYYY-MM-DD) for a contract, preferring the
 * expiry encoded in the OCC symbol over any supplied `expiry` field. If the
 * symbol cannot be parsed, fall back to the supplied field (may be empty).
 */
export function resolveExpiry(symbol: string, fallback?: string): string {
  const parsed = parseOccSymbol(symbol);
  if (parsed) return parsed.expiry;
  return fallback ?? "";
}
