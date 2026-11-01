# Options P/L lock screen widget

A [Scriptable](https://scriptable.app) widget for the small circular lock screen slot. It shows the
close-out P/L in dollars for one OptionStrat trade, using delayed quotes from Nasdaq and CBOE. Spec: [REQUIREMENTS.md](REQUIREMENTS.md).

```
 ╭─────────╮
 │  MSFT   │   ticker; "*" = stale or cached data
 │  −$238  │   P/L if closed now (longs at bid, shorts at ask)
 ╰─────────╯
```

## Install on the iPhone
1. Install **Scriptable** from the App Store and open it once. This creates `iCloud Drive/Scriptable/`.
2. Copy `OptionsPL.js` into that folder. Two ways:
   - **icloud.com → Drive → Scriptable → upload**, from the Linux PC's browser.
   - Or in Scriptable, tap **+**, paste the file's contents, and name the script `OptionsPL`.
3. In Scriptable, tap the script to run it. It previews the circular widget using `PREVIEW_CODE`.
   The log shows the last widget run first, then this run's per-leg breakdown.
4. Long-press the lock screen → **Customize** → **Lock Screen** → tap the widget row → **Scriptable**
   → the small circular widget.
5. Tap the new widget, then set **Script** = `OptionsPL` and **Parameter** = your OptionStrat share link.

To switch trades, edit the widget's Parameter and paste a new link.

## Tap action
Tapping the widget opens the OptionStrat app (`optionstrat://`). From there, **Saved** gets you to the trade.
None of the deep-link formats we tried open a specific trade. To open the share page in a browser
instead, change `TAP_URL` at the top of the script; the alternatives are listed there.

## Troubleshooting
- **"Error / Open app"** on the widget: tap it. Scriptable runs the script and the log shows what failed.
- **Blank widget:** usually a crash, such as running out of memory. Run the script in the app; the
  "last widget run" section shows the last step the widget reached.
- **`*` after the ticker:** the numbers are cached because a fetch failed, or the quotes are over an hour old
  during market hours.

## Develop on Linux
Needs Node 18+ (`sudo apt install nodejs`).

```bash
node test/test.js
```

```bash
node test/harness.js https://optionstrat.com/VyVKgVWgCwG7
```

`test/test.js` runs offline against the fixtures. `test/harness.js` runs the real script against live
OptionStrat and CBOE data, using stand-ins for the Scriptable APIs, and prints an ASCII preview.

## Limits
- Quotes are delayed about 15 minutes, and iOS refreshes lock screen widgets on its own schedule (roughly every 15–60 min).
- Index options (SPX, NDX) haven't been tested; Nasdaq's `index` asset class is tried last.
- Market holidays aren't known, so stale detection may flag `*` on a holiday weekday.
