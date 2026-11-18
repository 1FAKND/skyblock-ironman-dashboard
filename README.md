# SkyBlock Ironman Dashboard

A local, no-install-hassle dashboard for your Hypixel SkyBlock **Ironman** profile.
Run one script, get a browser dashboard with your full profile analyzed and a
**prioritized, Ironman-friendly to-do list**.

Nothing to sign up for: it fetches your (already public) profile data over the
internet from the free [Elite API](https://api.elitebot.dev) - no API key, no
account, no registration. The dashboard itself is a plain local file; you don't
host or run any server. You just need an internet connection when you refresh.

## ⬇ Download

**[Download the dashboard (ZIP)](https://github.com/1FAKND/skyblock-ironman-dashboard/archive/refs/heads/main.zip)**

1. Click the link above - a single ZIP file downloads.
2. Right-click the ZIP → **Extract All** → put the folder anywhere (Desktop is fine).
3. Install [Node.js](https://nodejs.org) if you don't have it (free LTS installer,
   just click Next).
4. Open the folder and double-click **`Refresh Dashboard.bat`**. It asks for your
   Minecraft username once, then opens your dashboard.

That's the whole install. If Windows shows a "protected your PC" warning the
first time (normal for downloaded scripts), click **More info → Run anyway**.

## What it shows

- **Prioritized To-Do List** — High/Medium/Low recommendations tuned for Ironman
  (skills to push, slayers that gate your progression, dungeon targets, accessory
  crafts, minion slots, and more). Live events go to the top; low-priority items
  fold into a dropdown
- **Skills, Slayers, Dungeons** — levels with progress bars, class levels, secrets;
  locked slayers show what unlocks them
- **Slayer Loadouts** — the best weapon, armor, equipment and pet you own for each
  slayer, with the reason for each pick, plus a recipe roadmap ranked by priority
  (stats, materials you have vs need, per-piece armor progress, wiki links)
- **Skill Loadouts** — the same for Mining, Farming, Fishing and Foraging, with
  best-pet-by-zone tables and in-place upgrades (empty gem slots, drill parts)
- **Events** — live mayor and calendar status, plus a step-by-step progression path
  for Diana (Mythological Ritual, with the full event item list and Hephaestus
  upgrades), Jacob's contests, Hoppity's Hunt, Spooky Festival, Season of Jerry,
  Fishing Festival and Mining Fiesta. Completed steps fold away
- **Gear** — worn armor & equipment with full in-game tooltips on hover
- **Gear by Activity** — every set found across your wardrobe, ender chest,
  backpacks and museum, grouped by purpose (mining / farming / fishing / combat /
  foraging), plus a "housekeeping" list of free wins (duplicate accessories,
  complete sets buried in storage, unused pet upgrade stones…)
- **Accessory Tracker** — upgrade chains you already qualify for, with the
  materials you have vs need, event-only warnings, and notable Ironman-obtainable
  accessories you're missing
- **Accessory Collection** — every upgradable accessory family as a stage chain
  showing which stages you own and what each missing stage requires
- **What to Craft First** — craft targets gate-checked against your actual
  slayer levels, collection tiers and sack contents (✓/✗ per requirement),
  grouped into craft-now / gather-materials / locked-behind-a-bottleneck,
  with reasoning when two crafts compete for the same resource
- **Pets & Minions** — full pet list, minion slot progress

## Requirements

- [Node.js](https://nodejs.org) (any recent version - the free LTS installer is fine)
- A Hypixel SkyBlock profile with API settings enabled
  (in game: **SkyBlock Menu → Settings → Personal → API Settings → enable everything**)

## Setup (one time)

1. Download this repository (green **Code** button → *Download ZIP*) and unzip it,
   or `git clone` it.
2. Run it (see *Daily use* below). **On first run it asks for your Minecraft
   username** in the console window and remembers it - that's the whole setup.

If you'd rather set it by hand (or change it later), edit `config.json`:

```json
{
  "username": "YourNameHere",
  "profileName": ""
}
```

**Multiple profiles?** The dashboard automatically picks your Ironman profile
(if you have several, the one you currently have selected in game). To force a
specific profile, put its fruit name in `profileName` (e.g. `"Apple"`). If you
have no Ironman profile it falls back to your active profile and says so.

## Daily use

**Windows:** double-click `Refresh Dashboard.bat`. It fetches your latest data and
opens the dashboard in your browser.

**Mac/Linux:** run `node fetch-data.js`, then open `dashboard.html` in a browser.

Re-run whenever you want fresh data. The analysis rebuilds itself from scratch each
time, so completed recommendations disappear automatically.

## Updates

Every refresh quietly checks this repository for a newer version. When one
exists, the dashboard shows a green banner with a download link. To update:
download the ZIP, extract it, and copy the files over your existing folder -
your `config.json` (username) and `data.js` (your data) are not part of the
download, so they're kept.

## Portable / USB-stick mode

The whole dashboard is self-contained - copy the folder to a USB stick and your
config and data travel with it. Viewing the dashboard works **offline** (it
renders your last refresh); you only need internet to refresh.

To make it run on computers that don't have Node.js installed: download the
Windows Binary (.zip) from [nodejs.org/en/download](https://nodejs.org/en/download),
unzip it, and copy just the `node.exe` file into the dashboard folder. The
refresh script automatically uses a `node.exe` sitting next to it before looking
for an installed one.

## On an LG TV (webOS)

You can put the dashboard on an LG smart TV as its own app. The TV just shows
it; your PC fetches the data and sends it over your home network.

**One time, on the TV:**

1. Create a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com)
   (Sign In → Create Account) and confirm the email LG sends you.
2. On the TV, install **Developer Mode** from the LG Content Store, open it and
   sign in with that account.
3. Switch **Dev Mode Status** ON (the TV restarts), open the app again and
   switch **Key Server** ON. Leave this screen up - it shows the TV's
   **IP address** and **Passphrase**.

**On your PC** (same Wi-Fi/network as the TV): double-click
**`Install on TV.bat`**. The first time it downloads LG's tools and asks for the
IP address and passphrase. It then refreshes your data, installs
**SkyBlock Dashboard** on the TV and opens it.

- Run `Install on TV.bat` again whenever you want fresh data on the TV.
- On the TV: use the Magic Remote pointer to click and hover. The up/down arrows
  scroll, and left/right or channel up/down move a page at a time.
- LG switches Developer Mode off after about 50 hours and removes the app.
  Open the Developer Mode app every day or two and press **Extend** to keep it.
- If the TV's IP address changes, or pairing stops working, run
  `Install on TV.bat --setup` from a command prompt, or just follow the retry
  prompt it shows.

## How it works

- `fetch-data.js` pulls your profile from the community-run
  [Elite API](https://api.elitebot.dev) (free, no key, data sourced from the
  official Hypixel API), analyzes it, and writes `data.js`.
- `dashboard.html` is a single self-contained page that renders `data.js`.
  It works offline once data is fetched.
- Your data never leaves your machine. Each refresh makes three requests: your
  (already public) profile from the Elite API - the only one that includes your
  username - plus the current mayor from Hypixel's public election endpoint and a
  version check against this repository. Neither of those two sends anything about you.
- `accessory-db.json` is generated from the NotEnoughUpdates item repository. To
  rebuild it after a game update: download
  [`constants/misc.json`](https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/constants/misc.json)
  and run `node gen-accessory-db.js misc.json accessory-db.json`.

Note: the dashboard works for normal profiles too, but the recommendations assume
Ironman rules (no Auction House / Bazaar).

## Disclaimer

Not affiliated with Hypixel or Mojang. Data comes from the public Elite API
(elitebot.dev). Game knowledge (accessory chains, armor ladders) is curated by
hand in `fetch-data.js` - PRs welcome if something is outdated.
