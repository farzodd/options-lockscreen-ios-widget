// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: chart-line;

// Options P/L — lock screen (accessoryCircular) widget for one OptionStrat trade.
// Widget Parameter: an OptionStrat share link or code, e.g. https://optionstrat.com/VyVKgVWgCwG7
// See REQUIREMENTS.md for the full spec.

// ---- Config ----
// Tap action: opens the OptionStrat app (no known deep link to a specific trade; use Saved in the app).
// Alternatives: code => `microsoft-edge-https://optionstrat.com/${code}` (Edge), code => `https://optionstrat.com/${code}` (Safari).
const TAP_URL = code => "optionstrat://";
const PREVIEW_CODE = "VyVKgVWgCwG7"; // used when run from inside the app with no parameter
const REFRESH_MS = 15 * 60 * 1000; // requested refresh; iOS decides the real cadence
const STRATEGY_TTL_MS = 60 * 60 * 1000; // re-read the OptionStrat page this often
const STALE_MS = 60 * 60 * 1000; // quotes older than this during market hours are stale
const TIMEOUT_S = 20;
const CACHE_DIR = "optionsPL";
// Nasdaq's API rejects non-browser user agents.
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ASSET_CLASSES = ["stocks", "etf", "index"]; // Nasdaq needs the right one per ticker (e.g. SPY is "etf")

// ---- Log ----
// Widget runs can't show a console, so they save their log; running the script in the app prints it.

const LOG = [];

function log(msg) {
  console.log(msg);
  LOG.push(`${new Date().toISOString()} ${msg}`);
  if (config.runsInWidget) {
    try {
      FileManager.local().writeString(logPath(), LOG.join("\n"));
    } catch (e) {}
  }
}

// ---- Parsing ----

function parseCode(param) {
  const s = String(param || "").trim().split(/[?#]/)[0].replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:optionstrat\.com\/)?([A-Za-z0-9]{6,})$/);
  return m ? m[1] : null;
}

// OptionStrat leg symbol: ".MSFT261120C542.5" (option) or "MSFT" (stock)
function parseLegSymbol(symbol) {
  const m = symbol.match(/^\.([A-Z0-9]+?)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) {
    if (/^[A-Z][A-Z0-9.]*$/.test(symbol)) return { isOption: false, root: symbol };
    throw new Error(`Unrecognized leg symbol ${symbol}`);
  }
  return { isOption: true, root: m[1], expiry: m[2], type: m[3], strike: parseFloat(m[4]) };
}

const occStrike = strike => String(Math.round(strike * 1000)).padStart(8, "0");

// OCC-style contract symbol, e.g. MSFT261120C00542500
function occSymbol(p) {
  return p.root + p.expiry + p.type + occStrike(p.strike);
}

function isoDate(yymmdd) {
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

function parseStrategy(html, code) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("No __NEXT_DATA__ on OptionStrat page");
  const saved = JSON.parse(m[1]).props?.pageProps?.savedStrategy;
  const strat = saved?.strategy;
  if (!strat?.symbol || !Array.isArray(strat.items)) throw new Error("No strategy in OptionStrat page");
  const legs = strat.items
    .filter(it => it.enabled !== false)
    .map(it => {
      if (typeof it.basis !== "number") throw new Error(`Leg ${it.symbol} has no entry price`);
      return { symbol: it.symbol, qty: it.quantity, basis: it.basis, close: it.close ?? null, ...parseLegSymbol(it.symbol) };
    });
  return { code, name: saved.name, underlying: strat.symbol, legs };
}

// Nasdaq numbers are strings like "1,234.50", or "--" when there's no market.
function nasdaqNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Each Nasdaq row holds the call and put for one strike; drillDownURL ends in the call's OCC symbol
// (e.g. ".../msft--261120c00542500"), so match on expiry + strike and read the c_ or p_ columns.
function findNasdaqQuote(rows, leg) {
  const tail = `${leg.expiry}[cp]${occStrike(leg.strike)}$`;
  const withRoot = new RegExp(`/${leg.root}-*${tail}`, "i");
  const anyRoot = new RegExp(tail, "i");
  const row = rows.find(r => withRoot.test(r.drillDownURL || "")) || rows.find(r => anyRoot.test(r.drillDownURL || ""));
  if (!row) return null;
  const p = leg.type === "C" ? "c_" : "p_";
  return { bid: nasdaqNum(row[p + "Bid"]), ask: nasdaqNum(row[p + "Ask"]) };
}

function parseCboeQuote(text) {
  const j = JSON.parse(text);
  if (!j.data) throw new Error("No data in CBOE quote");
  return {
    price: j.data.current_price ?? null,
    bid: j.data.bid ?? null,
    ask: j.data.ask ?? null,
    quoteTime: j.timestamp ? Date.parse(j.timestamp.replace(" ", "T") + "Z") : null, // CBOE timestamp is UTC
  };
}

// ---- Valuation ----

// Option expiry as 16:00 ET on the expiry date (approximated as 21:00 UTC; close enough for "has it expired").
function expiryTime(yymmdd) {
  return Date.UTC(2000 + +yymmdd.slice(0, 2), +yymmdd.slice(2, 4) - 1, +yymmdd.slice(4, 6), 21);
}

// Natural / close-out price: sell longs at the bid, buy back shorts at the ask.
function exitPrice(leg, quotes, und, now) {
  if (leg.close != null) return { price: leg.close, src: "closed" };
  if (!leg.isOption) {
    const price = leg.qty > 0 ? und.bid : und.ask;
    if (price == null) throw new Error(`No quote for ${leg.symbol}`);
    return { price, src: "stock" };
  }
  const q = quotes[occSymbol(leg)];
  if (q && leg.qty > 0) return { price: q.bid ?? 0, src: "bid" }; // no bid: worth nothing to sell
  if (q && q.ask != null) return { price: q.ask, src: "ask" };
  if (now >= expiryTime(leg.expiry) && und.price != null) {
    const intrinsic = leg.type === "C" ? und.price - leg.strike : leg.strike - und.price;
    return { price: Math.max(0, intrinsic), src: "intrinsic" };
  }
  throw new Error(`No quote for ${occSymbol(leg)}`);
}

function computePL(strategy, quotes, und, now) {
  let pl = 0;
  const legs = strategy.legs.map(leg => {
    const { price, src } = exitPrice(leg, quotes, und, now);
    const mult = leg.isOption ? 100 : 1;
    const legPL = leg.qty * mult * (price - leg.basis);
    pl += legPL;
    return { symbol: leg.symbol, qty: leg.qty, basis: leg.basis, price, src, pl: legPL };
  });
  return { pl, ticker: strategy.underlying, underlyingPrice: und.price ?? null, quoteTime: und.quoteTime ?? null, computedAt: now, legs };
}

// ---- Display helpers ----

function formatPL(n) {
  const abs = Math.abs(n);
  const sign = Math.round(abs) === 0 ? "" : n > 0 ? "+" : "−";
  let body;
  if (abs >= 1e6) body = (abs / 1e6).toFixed(1) + "M";
  else if (abs >= 1e4) body = (abs / 1e3).toFixed(1) + "k";
  else body = Math.round(abs).toLocaleString("en-US");
  return `${sign}$${body}`;
}

// Regular session, weekdays 9:30–16:00 ET (holidays ignored).
function isMarketHours(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(now)).map(p => [p.type, p.value])
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const mins = +parts.hour * 60 + +parts.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function isStale(result, fromCache, now) {
  if (fromCache) return true;
  return isMarketHours(now) && result.quoteTime != null && now - result.quoteTime > STALE_MS;
}

// ---- Network ----

async function fetchText(url) {
  const req = new Request(url);
  req.timeoutInterval = TIMEOUT_S;
  req.headers = { "User-Agent": USER_AGENT, Accept: "application/json, text/html" };
  const text = await req.loadString();
  const status = req.response?.statusCode;
  if (status && status >= 400) throw new Error(`HTTP ${status} for ${url}`);
  return text;
}

// Underlying quote (~0.5 KB). Only needed for stock legs, expired legs, and the stale check, so failure is not fatal.
async function fetchUnderlying(ticker) {
  for (const name of [ticker, `_${ticker}`]) {
    try {
      return parseCboeQuote(await fetchText(`https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/${name}.json`));
    } catch (e) {
      log(`CBOE quote ${name}: ${e.message}`);
    }
  }
  return {};
}

// One expiry's chain from Nasdaq (~50 KB, vs. megabytes for CBOE's full chain, which crashes the widget).
async function fetchNasdaqRows(ticker, yymmdd, cache) {
  const d = isoDate(yymmdd);
  const classes = [cache.assetClass, ...ASSET_CLASSES.filter(c => c !== cache.assetClass)].filter(Boolean);
  for (const ac of classes) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/option-chain?assetclass=${ac}&fromdate=${d}&todate=${d}&excode=oprac&callput=callput&money=all&type=all&limit=1000`;
    const rows = JSON.parse(await fetchText(url)).data?.table?.rows;
    if (Array.isArray(rows)) {
      cache.assetClass = ac;
      return rows;
    }
  }
  throw new Error(`Nasdaq has no ${d} chain for ${ticker}`);
}

async function fetchQuotes(strategy, cache, now) {
  const open = strategy.legs.filter(l => l.isOption && l.close == null && now < expiryTime(l.expiry));
  const quotes = {};
  for (const exp of [...new Set(open.map(l => l.expiry))]) {
    const rows = await fetchNasdaqRows(strategy.underlying, exp, cache);
    for (const leg of open.filter(l => l.expiry === exp)) {
      const q = findNasdaqQuote(rows, leg);
      if (q) quotes[occSymbol(leg)] = q;
    }
    log(`Nasdaq ${isoDate(exp)}: ${rows.length} rows (${cache.assetClass})`);
  }
  return quotes;
}

// ---- Storage ----

function cacheDir() {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.documentsDirectory(), CACHE_DIR);
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  return dir;
}

const cachePath = code => FileManager.local().joinPath(cacheDir(), `${code}.json`);
const logPath = () => FileManager.local().joinPath(cacheDir(), "last-widget-run.log");

function loadCache(code) {
  const fm = FileManager.local();
  const path = cachePath(code);
  try {
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : {};
  } catch (e) {
    return {};
  }
}

function saveCache(code, cache) {
  FileManager.local().writeString(cachePath(code), JSON.stringify(cache));
}

function printLastWidgetLog() {
  try {
    const fm = FileManager.local();
    const path = logPath();
    console.log(`--- last widget run ---\n${fm.fileExists(path) ? fm.readString(path) : "(none yet)"}\n--- this run ---`);
  } catch (e) {}
}

// ---- Widget ----

function buildWidget({ top, main, url }) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MS);
  if (url) w.url = url;
  w.addSpacer();
  const t = w.addText(top);
  t.font = Font.semiboldSystemFont(10);
  t.textColor = Color.white();
  t.centerAlignText();
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  const m = w.addText(main);
  m.font = Font.boldRoundedSystemFont(17);
  m.textColor = Color.white();
  m.centerAlignText();
  m.lineLimit = 1;
  m.minimumScaleFactor = 0.4;
  w.addSpacer();
  return w;
}

async function run() {
  const now = Date.now();
  const code = parseCode(args.widgetParameter ?? (config.runsInWidget ? null : PREVIEW_CODE));
  if (!code) return buildWidget({ top: "Options", main: "Set link" });
  log(`run ${code} in ${config.runsInWidget ? `widget (${config.widgetFamily})` : "app"}`);

  const cache = loadCache(code);
  let strategy = cache.strategy;
  if (!strategy || now - (cache.strategyFetchedAt || 0) > STRATEGY_TTL_MS) {
    try {
      strategy = parseStrategy(await fetchText(`https://optionstrat.com/${code}`), code);
      cache.strategy = strategy;
      cache.strategyFetchedAt = now;
      log(`OptionStrat: ${strategy.name} (${strategy.legs.length} legs)`);
    } catch (e) {
      log(`OptionStrat fetch failed: ${e.message}`);
    }
  }

  let result = cache.result;
  let fromCache = true;
  if (strategy) {
    try {
      const und = await fetchUnderlying(strategy.underlying);
      const quotes = await fetchQuotes(strategy, cache, now);
      result = computePL(strategy, quotes, und, now);
      cache.result = result;
      fromCache = false;
    } catch (e) {
      log(`Quote/valuation failed: ${e.message}`);
    }
  }
  saveCache(code, cache);

  const url = TAP_URL(code);
  if (!result) return buildWidget({ top: (strategy?.underlying || "Options") + "*", main: "—", url });

  for (const l of result.legs) {
    log(`  ${l.symbol} x${l.qty} basis ${l.basis} exit ${l.price} (${l.src}) P/L ${l.pl.toFixed(2)}`);
  }
  const asOf = result.quoteTime ? new Date(result.quoteTime).toISOString() : "?";
  log(`  total ${result.pl.toFixed(2)}; underlying ${result.underlyingPrice}; as of ${asOf}${fromCache ? " [cached]" : ""}`);

  const stale = isStale(result, fromCache, now);
  return buildWidget({ top: result.ticker + (stale ? "*" : ""), main: formatPL(result.pl), url });
}

// Never leave the widget blank: on an unexpected error, show it and make a tap run the script in the app (which prints the log).
async function safeRun() {
  try {
    return await run();
  } catch (e) {
    log(`Error: ${e.stack || e.message}`);
    return buildWidget({ top: "Error", main: "Open app", url: `scriptable:///run/${encodeURIComponent(Script.name())}` });
  }
}

// ---- Entry point ----

if (typeof __TEST__ !== "undefined") {
  __TEST__.exports = { parseCode, parseLegSymbol, occSymbol, parseStrategy, findNasdaqQuote, parseCboeQuote, computePL, formatPL, isMarketHours, isStale, run, safeRun };
} else {
  if (!config.runsInWidget) printLastWidgetLog();
  const widget = await safeRun();
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentAccessoryCircular();
  Script.complete();
}
