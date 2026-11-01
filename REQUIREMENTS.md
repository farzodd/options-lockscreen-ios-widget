# Options Lock Screen Widget — Requirements

## Platform
- **Scriptable** (iOS) script, written in JavaScript on Linux, synced to the phone via iCloud Drive.
- **Lock screen, circular family** (`accessoryCircular`) — the single small slot under the clock.
- Monochrome rendering (iOS tints lock screen widgets), so direction is shown by the sign, not color.

## Input
- One trade per widget. The widget's **Parameter** field holds an OptionStrat share link or bare code
  (e.g. `https://optionstrat.com/VyVKgVWgCwG7` or `VyVKgVWgCwG7`).
- Trade definition is read from the share page's embedded `__NEXT_DATA__` JSON:
  `props.pageProps.savedStrategy.strategy`
  - `symbol` — underlying ticker
  - `items[]` — legs: `symbol` (e.g. `.MSFT261120C542.5`), `quantity` (signed; negative = short),
    `basis` (per-share entry price), `close` (per-share exit price if the leg was closed, else null),
    `enabled`
- Trade definition is cached after first successful fetch; re-fetched periodically (e.g. hourly) so edits
  on OptionStrat (rolls, added legs) are picked up.

## Quotes
Lock screen widgets have a tight memory limit. CBOE's full chain (`delayed_quotes/options/<TICKER>.json`,
1.7 MB for MSFT, 12 MB for SPX) left the widget blank on the phone, so v1 uses small per-request sources:
- **Options: Nasdaq, one expiry per request** (~50 KB), delayed:
  `https://api.nasdaq.com/api/quote/<TICKER>/option-chain?assetclass=<stocks|etf|index>&fromdate=<YYYY-MM-DD>&todate=<same>&excode=oprac&callput=callput&money=all&type=all&limit=1000`
  - Needs a browser User-Agent. Wrong asset class returns `"data": null`; try stocks → etf → index and
    remember the one that works.
  - One row per strike with `c_Bid/c_Ask/p_Bid/p_Ask` (strings, `--` = none); `drillDownURL` ends in the
    call's OCC symbol (`msft--261120c00542500`).
  - Bid/ask matched CBOE's exactly when checked (same OPRA feed).
- **Underlying: CBOE quote** (~0.5 KB): `https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/<TICKER>.json`
  (`_<TICKER>` for indexes). `timestamp` is UTC. Used for stock legs, expired legs, and the stale check.
- Contract symbol mapping: OptionStrat `.MSFT261120C542.5` → OCC `MSFT261120C00542500`
  (root + YYMMDD + C/P + strike × 1000 zero-padded to 8 digits).

## Valuation — natural / close-out, dollars only
- Open long leg (qty > 0): value at **bid**. Open short leg (qty < 0): value at **ask**.
- Closed leg (`close` not null): use `close` instead of a live quote.
- Disabled legs are ignored.
- Options multiplier 100; stock legs (no leading `.`) multiplier 1.
- `P/L = Σ qty × mult × (exitPrice − basis)` — works for both debit and credit trades.
- Example (MSFT diagonal, Oct 30 close): long 450C bid 99.65 vs 102.36, short 542.5C ask 6.60 vs 6.93
  → (99.65 − 102.36)·100 − (6.60 − 6.93)·100 = **−$238**.

## Display
- Large: **P/L in dollars** with sign (e.g. `−$238`, `+$1,240`). Auto-shrink to fit; abbreviate
  ≥ $10k as `+$12.3k`.
- Small: **ticker** (e.g. `MSFT`).
- No percent.

## Extras
- **Tap action**: open the OptionStrat app via `optionstrat://` (confirmed working). No deep link to a
  specific trade is known (`optionstrat://optionstrat.com/<code>`, `optionstrat://<code>` and
  `optionstrat:///<code>` only open the app, and the site has no universal links), so the user taps Saved.
  Alternatives if needed: Edge `microsoft-edge-https://optionstrat.com/<code>`, Safari `https://optionstrat.com/<code>`.
- **Stale marker**: small indicator when shown data is from cache because a fetch failed, or quotes are
  older than ~1 hour during regular market hours (9:30–16:00 ET, weekdays).
- **Offline cache**: last good result stored in Scriptable's local FileManager; widget never goes blank.

## Refresh
- Request refresh every ~15 min (`refreshAfterDate`); iOS decides actual cadence. Fast refresh not needed.

## Edge cases
- Bad/missing parameter → show a short "set link" message.
- Leg missing from CBOE chain (e.g. expired) → value at intrinsic from underlying price.
- Network/parse failure with no cache → show `—` with stale marker.
- Unexpected error → show "Error / Open app"; tap runs the script in Scriptable, which prints the log.
- Long leg with no bid → valued at 0. Short leg with no ask → error (can't price the buy-back).

## Diagnostics
- Widget runs write their log to `optionsPL/last-widget-run.log` (Scriptable local storage); running the
  script in the app prints that log first.

## Later
- Deep link straight to the trade in the OptionStrat app.
