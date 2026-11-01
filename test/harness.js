// Loads OptionsPL.js under Node with minimal stand-ins for the Scriptable APIs it uses.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = path.join(__dirname, "..", "OptionsPL.js");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// fetchMap: optional { urlSubstring: fixturePath | { text } | Error } to serve requests offline; first matching key wins.
function makeEnv({ widgetParameter = null, runsInWidget = true, fetchMap = null, docsDir } = {}) {
  docsDir = docsDir || fs.mkdtempSync(path.join(os.tmpdir(), "optionspl-"));
  const requests = [];

  class Request {
    constructor(url) { this.url = url; this.headers = {}; this.response = null; }
    async loadString() {
      requests.push(this.url);
      if (fetchMap) {
        const key = Object.keys(fetchMap).find(k => this.url.includes(k));
        const v = key ? fetchMap[key] : new Error(`offline: ${this.url}`);
        if (v instanceof Error) throw v;
        this.response = { statusCode: 200 };
        return typeof v === "string" ? fs.readFileSync(v, "utf8") : v.text;
      }
      const res = await fetch(this.url, { headers: this.headers, signal: AbortSignal.timeout((this.timeoutInterval || 60) * 1000) });
      this.response = { statusCode: res.status };
      return res.text();
    }
  }

  const FileManager = {
    local: () => ({
      documentsDirectory: () => docsDir,
      joinPath: (a, b) => path.join(a, b),
      fileExists: p => fs.existsSync(p),
      createDirectory: (p, rec) => fs.mkdirSync(p, { recursive: !!rec }),
      readString: p => fs.readFileSync(p, "utf8"),
      writeString: (p, s) => fs.writeFileSync(p, s),
    }),
  };

  class ListWidget {
    constructor() { this.items = []; }
    addSpacer() { this.items.push({ spacer: true }); }
    addText(text) {
      const t = { text, centerAlignText() { this.align = "center"; } };
      this.items.push(t);
      return t;
    }
    async presentAccessoryCircular() { console.log(render(this)); }
  }

  const Font = new Proxy({}, { get: (_, name) => size => ({ name, size }) });
  const Color = { white: () => "white" };
  const Script = { name: () => "OptionsPL", setWidget: w => console.log(render(w)), complete: () => {} };
  const config = { runsInWidget, widgetFamily: runsInWidget ? "accessoryCircular" : null };

  return {
    docsDir,
    requests,
    globals: { args: { widgetParameter }, config, Request, FileManager, ListWidget, Script, Font, Color },
  };
}

function render(w) {
  const lines = w.items.filter(i => !i.spacer).map(i => i.text);
  const width = Math.max(9, ...lines.map(l => l.length + 2));
  const pad = s => {
    const left = Math.floor((width - s.length) / 2);
    return " ".repeat(left) + s + " ".repeat(width - s.length - left);
  };
  return [` ╭${"─".repeat(width)}╮`, ...lines.map(l => ` │${pad(l)}│`), ` ╰${"─".repeat(width)}╯`, `  tap: ${w.url || "(none)"}`].join("\n");
}

// mode "module": returns the script's exported functions; mode "main": runs the script like Scriptable would.
async function load(envOpts = {}, mode = "module") {
  const env = makeEnv(envOpts);
  const names = Object.keys(env.globals);
  const testHook = mode === "module" ? { exports: null } : undefined;
  const params = mode === "module" ? [...names, "__TEST__"] : names;
  const values = names.map(n => env.globals[n]);
  if (mode === "module") values.push(testHook);
  await new AsyncFunction(...params, fs.readFileSync(SRC, "utf8"))(...values);
  return { lib: testHook?.exports, env };
}

module.exports = { load, render };

// CLI: node test/harness.js [optionstrat link or code]  — runs the widget live against the network.
if (require.main === module) {
  load({ widgetParameter: process.argv[2] || "VyVKgVWgCwG7" }, "main").catch(e => {
    console.error(e);
    process.exit(1);
  });
}
