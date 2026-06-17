/**
 * Backtest environment guard — MUST be imported before any server/bot module.
 *
 * paperState.ts persists by default to .data/bot-state.json (the LIVE paper
 * ledger). The backtest reuses that same paperState module and calls
 * resetPaperState(), so without this guard a backtest run would WIPE today's
 * live paper trades and replace them with simulated ones.
 *
 * STATE_FILE in paperState.ts is resolved once at module-load time from
 * process.env.BOT_PAPER_STATE_FILE. ES module imports are hoisted and evaluated
 * before any inline top-level code, so setting the env var inline at the top of
 * backtest-bot.ts would run too late. Importing this side-effect module FIRST
 * guarantees the env var is set before paperState (transitively imported by a
 * later import) is ever evaluated.
 *
 * Default to "none" (in-memory only) so a backtest can never clobber the live
 * ledger. An operator who explicitly WANTS a persisted backtest ledger can still
 * set BOT_PAPER_STATE_FILE to a real path before running — we only fill in the
 * safe default when it is unset.
 */
if (process.env.BOT_PAPER_STATE_FILE === undefined) {
  process.env.BOT_PAPER_STATE_FILE = "none";
}
