#!/usr/bin/env node
/**
 * Puts the SkyBlock dashboard on an LG (webOS) TV.
 *
 *   1. refreshes your data (runs ../fetch-data.js)
 *   2. packages dashboard.html + data.js as a TV app (.ipk)
 *   3. installs it on the TV over your home network and opens it
 *
 * Run:  node tv/install-tv.js            (or double-click "Install on TV.bat")
 *       node tv/install-tv.js --setup    re-enter the TV's IP address / passphrase
 *       node tv/install-tv.js --no-refresh   skip the data refresh
 *
 * The TV must have LG's "Developer Mode" app switched ON, and be on the same
 * network as this computer.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TV = __dirname;
const ROOT = path.dirname(TV);
const BUILD = path.join(TV, "build");
const APP = path.join(BUILD, "app");
const DEVICE_FILE = path.join(TV, "tv-device.json");
const DEVICE = "skyblock-tv";
const APPINFO = JSON.parse(fs.readFileSync(path.join(TV, "appinfo.json"), "utf8"));
const CLI = path.join(TV, "node_modules", "@webos-tools", "cli", "bin");

const args = new Set(process.argv.slice(2));

function step(msg) { console.log(`\n== ${msg}`); }
function fail(msg) { console.error(`\n[!] ${msg}\n`); process.exit(1); }

async function ask(question) {
  if (!process.stdin.isTTY) fail("This needs a console window to ask for the TV details. Run it from \"Install on TV.bat\".");
  const readline = require("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}

/** Runs one of the webOS CLI tools (ares-*). Returns { ok, out }. */
function ares(tool, toolArgs, { quiet = false } = {}) {
  const r = spawnSync(process.execPath, [path.join(CLI, `${tool}.js`), ...toolArgs], {
    cwd: TV, encoding: "utf8", stdio: quiet ? "pipe" : ["inherit", "pipe", "pipe"],
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (!quiet && out.trim()) console.log(out.trim());
  const errored = /\[?error\]?|ERR!|Failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Unable/i.test(out);
  return { ok: r.status === 0 && !errored, out };
}

function ensureCli() {
  if (fs.existsSync(path.join(CLI, "ares-package.js"))) return;
  step("First run: downloading LG's webOS TV tools (one time, ~1 minute)");
  const r = spawnSync("npm install --no-audit --no-fund --loglevel=error", { cwd: TV, stdio: "inherit", shell: true });
  if (r.status !== 0 || !fs.existsSync(path.join(CLI, "ares-package.js"))) {
    fail("Could not download the webOS tools. Check your internet connection and try again.");
  }
}

function refreshData() {
  if (args.has("--no-refresh")) return;
  step("Refreshing your SkyBlock data");
  const r = spawnSync(process.execPath, [path.join(ROOT, "fetch-data.js")], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) console.log("(Data refresh reported a problem - the TV app will show the details.)");
}

function buildApp() {
  step("Building the TV app");
  const dataFile = path.join(ROOT, "data.js");
  if (!fs.existsSync(dataFile)) fail("data.js is missing - the data refresh did not produce anything. Run \"Refresh Dashboard.bat\" once and check for errors.");

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });

  let html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
  html = html.replace(/<\/body>/i, '<script src="tv.js"></script>\n</body>');
  fs.writeFileSync(path.join(APP, "index.html"), html, "utf8");
  for (const f of ["appinfo.json", "icon.png", "largeIcon.png", "tv.js"]) fs.copyFileSync(path.join(TV, f), path.join(APP, f));
  fs.copyFileSync(dataFile, path.join(APP, "data.js"));

  const r = ares("ares-package", [APP, "--outdir", BUILD, "--no-minify"]);
  const ipk = fs.readdirSync(BUILD).find((f) => f.endsWith(".ipk"));
  if (!r.ok || !ipk) fail("Packaging the TV app failed (see the message above).");
  return path.join(BUILD, ipk);
}

async function setupDevice() {
  console.log(`
On the TV, open the "Developer Mode" app. With Dev Mode Status ON it shows
an IP address (like 192.168.1.23) and a Passphrase (6 letters/numbers).
Make sure "Key Server" is also switched ON.`);
  let host = "";
  while (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) host = await ask("\n  TV IP address: ");
  let pass = "";
  while (!pass) pass = (await ask("  Passphrase (case-sensitive): ")).replace(/\s+/g, "");

  const known = ares("ares-setup-device", ["--list"], { quiet: true }).out.includes(DEVICE);
  const info = ["-i", `host=${host}`, "-i", "port=9922", "-i", "username=prisoner", "-i", "default=true"];
  ares("ares-setup-device", known ? ["-m", DEVICE, ...info] : ["-a", DEVICE, ...info], { quiet: true });

  step("Pairing with the TV");
  const k = ares("ares-novacom", ["--device", DEVICE, "--getkey", "--passphrase", pass]);
  if (!k.ok) return false;
  fs.writeFileSync(DEVICE_FILE, JSON.stringify({ host }, null, 2) + "\n", "utf8");
  console.log("  Paired. You won't need the passphrase again unless Developer Mode is reset.");
  return true;
}

async function installOnTv(ipk) {
  let needSetup = args.has("--setup") || !fs.existsSync(DEVICE_FILE);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (needSetup && !(await setupDevice())) {
      console.log(`
  Couldn't pair with the TV. Check that:
   - the TV and this computer are on the same Wi-Fi / network
   - Dev Mode Status AND Key Server are ON in the Developer Mode app
   - the IP address and passphrase match what the TV shows right now`);
      if (attempt < 3 && /^y/i.test(await ask("\n  Try again? (y/n): "))) continue;
      fail("Not installed.");
    }
    step("Installing on the TV");
    if (ares("ares-install", ["--device", DEVICE, ipk]).ok) {
      ares("ares-launch", ["--device", DEVICE, APPINFO.id], { quiet: true });
      return;
    }
    console.log(`
  Install failed. Common causes: the TV is off or asleep, its IP address changed,
  or the Developer Mode session expired (open the app on the TV and check).`);
    if (attempt < 3 && /^y/i.test(await ask("\n  Re-enter the TV's IP address and passphrase and try again? (y/n): "))) {
      needSetup = true;
      continue;
    }
    fail(`Not installed. The app file is ready at ${ipk} if you want to try later.`);
  }
}

(async () => {
  ensureCli();
  refreshData();
  const ipk = buildApp();
  if (args.has("--build-only")) { console.log(`\nBuilt ${ipk}`); return; }
  await installOnTv(ipk);
  console.log(`
Done! "${APPINFO.title}" is open on your TV and is in the app list.

 - Run "Install on TV.bat" again any time to refresh the data on the TV.
 - Developer Mode turns itself off after ~50 hours and LG removes the app.
   Open the Developer Mode app on the TV every day or two and press EXTEND.
`);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
