// Offline tests: node test/test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { load } = require("./harness");

const FIX = path.join(__dirname, "fixtures");
const PAGE = path.join(FIX, "optionstrat-VyVKgVWgCwG7.html");
const NOV = path.join(FIX, "nasdaq-MSFT-2026-11-20.json");
const JUN = path.join(FIX, "nasdaq-MSFT-2027-06-17.json");
const QUOTE = path.join(FIX, "cboe-quote-MSFT.json");
const QUOTE_TIME = Date.parse("2026-10-31T03:33:09Z");
const NOW = Date.parse("2026-11-01T06:00:00Z");
const ONLINE = { "optionstrat.com/": PAGE, "fromdate=2026-11-20": NOV, "fromdate=2027-06-17": JUN, "quotes/MSFT.json": QUOTE };
const texts = w => w.items.filter(i => !i.spacer).map(i => i.text);
const rows = f => JSON.parse(fs.readFileSync(f, "utf8")).data.table.rows;
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("parseCode accepts links and bare codes", async () => {
  const { lib } = await load();
  for (const s of ["VyVKgVWgCwG7", "https://optionstrat.com/VyVKgVWgCwG7", "optionstrat.com/VyVKgVWgCwG7/", " https://www.optionstrat.com/VyVKgVWgCwG7?utm=x "]) {
    assert.strictEqual(lib.parseCode(s), "VyVKgVWgCwG7", s);
  }
  assert.strictEqual(lib.parseCode(""), null);
  assert.strictEqual(lib.parseCode(null), null);
  assert.strictEqual(lib.parseCode("https://example.com/foo/bar"), null);
});

test("OptionStrat leg symbols map to OCC symbols", async () => {
  const { lib } = await load();
  assert.strictEqual(lib.occSymbol(lib.parseLegSymbol(".MSFT261120C542.5")), "MSFT261120C00542500");
  assert.strictEqual(lib.occSymbol(lib.parseLegSymbol(".MSFT270617C450")), "MSFT270617C00450000");
  assert.strictEqual(lib.occSymbol(lib.parseLegSymbol(".SPXW261120P5800")), "SPXW261120P05800000");
  assert.deepStrictEqual(lib.parseLegSymbol("MSFT"), { isOption: false, root: "MSFT" });
});

test("parseStrategy reads legs from the share page", async () => {
  const { lib } = await load();
  const s = lib.parseStrategy(fs.readFileSync(PAGE, "utf8"), "VyVKgVWgCwG7");
  assert.strictEqual(s.underlying, "MSFT");
  assert.deepStrictEqual(s.legs.map(l => [l.symbol, l.qty, l.basis]), [
    [".MSFT261120C542.5", -1, 6.93],
    [".MSFT270617C450", 1, 102.36],
  ]);
});

test("findNasdaqQuote reads call and put columns from the strike's row", async () => {
  const { lib } = await load();
  const leg = s => lib.parseLegSymbol(s);
  assert.deepStrictEqual(lib.findNasdaqQuote(rows(NOV), leg(".MSFT261120C542.5")), { bid: 6.05, ask: 6.6 });
  assert.deepStrictEqual(lib.findNasdaqQuote(rows(NOV), leg(".MSFT261120P542.5")), { bid: 25.45, ask: 27.95 });
  assert.deepStrictEqual(lib.findNasdaqQuote(rows(NOV), leg(".MSFT261120P200")), { bid: null, ask: 0.04 }); // "--" bid
  assert.strictEqual(lib.findNasdaqQuote(rows(NOV), leg(".MSFT261120C999")), null);
});

test("parseCboeQuote", async () => {
  const { lib } = await load();
  assert.deepStrictEqual(lib.parseCboeQuote(fs.readFileSync(QUOTE, "utf8")), { price: 522.992, bid: 522.88, ask: 523, quoteTime: QUOTE_TIME });
  assert.throws(() => lib.parseCboeQuote("<Error>AccessDenied</Error>"));
});

test("computePL uses natural prices: longs at bid, shorts at ask", async () => {
  const { lib } = await load();
  const s = lib.parseStrategy(fs.readFileSync(PAGE, "utf8"), "VyVKgVWgCwG7");
  const quotes = { MSFT261120C00542500: { bid: 6.05, ask: 6.6 }, MSFT270617C00450000: { bid: 99.65, ask: 102 } };
  const r = lib.computePL(s, quotes, { price: 522.992, quoteTime: QUOTE_TIME }, NOW);
  approx(r.pl, -238);
  assert.deepStrictEqual(r.legs.map(l => [l.price, l.src]), [[6.6, "ask"], [99.65, "bid"]]);
  assert.strictEqual(r.quoteTime, QUOTE_TIME);
});

test("closed, expired, stock, no-bid, and missing legs", async () => {
  const { lib } = await load();
  const leg = (symbol, qty, basis, close = null) => ({ symbol, qty, basis, close, ...lib.parseLegSymbol(symbol) });
  const pl = (legs, quotes = {}, und = { price: 522.992, bid: 522.88, ask: 523 }) => lib.computePL({ underlying: "MSFT", legs }, quotes, und, NOW).pl;
  approx(pl([leg(".MSFT261120C542.5", -1, 6.93, 2.0)]), 493); // closed: uses close price
  approx(pl([leg(".MSFT261016C500", 1, 10)]), (22.992 - 10) * 100); // expired: intrinsic
  approx(pl([leg("MSFT", 10, 500)]), (522.88 - 500) * 10); // stock: bid, multiplier 1
  approx(pl([leg(".MSFT261120P200", 1, 0.5)], { MSFT261120P00200000: { bid: null, ask: 0.04 } }), -50); // no bid: worth 0
  assert.throws(() => pl([leg(".MSFT271217C999", 1, 1)]), /No quote/); // unexpired and unquoted: error, not zero
  assert.throws(() => pl([leg("MSFT", 10, 500)], {}, {}), /No quote/);
});

test("formatPL", async () => {
  const { lib } = await load();
  assert.strictEqual(lib.formatPL(-238), "−$238");
  assert.strictEqual(lib.formatPL(1240.4), "+$1,240");
  assert.strictEqual(lib.formatPL(12345), "+$12.3k");
  assert.strictEqual(lib.formatPL(-2500000), "−$2.5M");
  assert.strictEqual(lib.formatPL(0.3), "$0");
});

test("market hours and staleness", async () => {
  const { lib } = await load();
  const t = s => Date.parse(s);
  assert.strictEqual(lib.isMarketHours(t("2026-11-02T15:00:00Z")), true); // Mon 10:00 EST
  assert.strictEqual(lib.isMarketHours(t("2026-11-02T14:00:00Z")), false); // Mon 09:00 EST
  assert.strictEqual(lib.isMarketHours(t("2026-10-30T19:59:00Z")), true); // Fri 15:59 EDT
  assert.strictEqual(lib.isMarketHours(t("2026-10-31T15:00:00Z")), false); // Saturday
  const r = { quoteTime: t("2026-11-02T15:00:00Z") };
  assert.strictEqual(lib.isStale(r, false, t("2026-11-02T15:30:00Z")), false);
  assert.strictEqual(lib.isStale(r, false, t("2026-11-02T16:30:00Z")), true);
  assert.strictEqual(lib.isStale(r, false, t("2026-11-07T16:30:00Z")), false); // weekend: old quotes are expected
  assert.strictEqual(lib.isStale(r, true, t("2026-11-07T16:30:00Z")), true); // fetch failed: always marked
});

test("run(): renders, logs, caches, and falls back to cache when offline", async () => {
  const first = await load({ widgetParameter: "https://optionstrat.com/VyVKgVWgCwG7", fetchMap: ONLINE });
  const w1 = await first.lib.run();
  assert.strictEqual(texts(w1)[1], "−$238");
  assert.match(texts(w1)[0], /^MSFT/);
  assert.strictEqual(w1.url, "optionstrat://");
  assert.ok(w1.items.filter(i => i.text).every(i => i.textColor === "white"));
  const logFile = fs.readFileSync(path.join(first.env.docsDir, "optionsPL", "last-widget-run.log"), "utf8");
  assert.match(logFile, /run VyVKgVWgCwG7 in widget \(accessoryCircular\)/);
  assert.match(logFile, /total -238\.00/);
  // Only small requests: the page, one CBOE quote, one Nasdaq chain per expiry.
  assert.strictEqual(first.env.requests.length, 4);
  assert.ok(first.env.requests.every(u => !u.includes("delayed_quotes/options/")));

  const offline = await load({ widgetParameter: "VyVKgVWgCwG7", fetchMap: {}, docsDir: first.env.docsDir });
  assert.deepStrictEqual(texts(await offline.lib.run()), ["MSFT*", "−$238"]);
});

test("run(): finds and remembers the Nasdaq asset class (e.g. ETFs)", async () => {
  const etfOnly = { "assetclass=stocks": { text: '{"data":null}' }, ...ONLINE };
  const first = await load({ widgetParameter: "VyVKgVWgCwG7", fetchMap: etfOnly });
  assert.strictEqual(texts(await first.lib.run())[1], "−$238");
  const cache = JSON.parse(fs.readFileSync(path.join(first.env.docsDir, "optionsPL", "VyVKgVWgCwG7.json"), "utf8"));
  assert.strictEqual(cache.assetClass, "etf");

  const second = await load({ widgetParameter: "VyVKgVWgCwG7", fetchMap: etfOnly, docsDir: first.env.docsDir });
  await second.lib.run();
  assert.ok(second.env.requests.every(u => !u.includes("assetclass=stocks")));
});

test("run(): no parameter and no cache", async () => {
  const noParam = await load({ widgetParameter: null, runsInWidget: true, fetchMap: {} });
  assert.deepStrictEqual(texts(await noParam.lib.run()), ["Options", "Set link"]);
  const offline = await load({ widgetParameter: "VyVKgVWgCwG7", fetchMap: {} });
  assert.deepStrictEqual(texts(await offline.lib.run()), ["Options*", "—"]);
});

test("safeRun(): unexpected errors show on the widget and tap opens the script", async () => {
  const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "optionspl-")), "file");
  fs.writeFileSync(notADir, "");
  const broken = await load({ widgetParameter: "VyVKgVWgCwG7", fetchMap: ONLINE, docsDir: notADir });
  const w = await broken.lib.safeRun();
  assert.deepStrictEqual(texts(w), ["Error", "Open app"]);
  assert.strictEqual(w.url, "scriptable:///run/OptionsPL");
});
