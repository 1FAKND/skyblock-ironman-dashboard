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
  crafts, minion slots, and more)
- **Skills, Slayers, Dungeons** — levels with progress bars, class levels, secrets
- **Gear** — worn armor & equipment with full in-game tooltips on hover
- **Gear by Activity** — every set found across your wardrobe, ender chest,
  backpacks and museum, grouped by purpose (mining / farming / fishing / combat /
  foraging), plus a "housekeeping" list of free wins (duplicate accessories,
  complete sets buried in storage, unused pet upgrade stones…)
- **Accessory Tracker** — upgrade chains you already qualify for, and notable
  Ironman-obtainable accessories you're missing, each with its source and its
  unlock requirement checked against your profile
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

## Portable / USB-stick mode

The whole dashboard is self-contained - copy the folder to a USB stick and your
config and data travel with it. Viewing the dashboard works **offline** (it
renders your last refresh); you only need internet to refresh.

To make it run on computers that don't have Node.js installed: download the
Windows Binary (.zip) from [nodejs.org/en/download](https://nodejs.org/en/download),
unzip it, and copy just the `node.exe` file into the dashboard folder. The
refresh script automatically uses a `node.exe` sitting next to it before looking
for an installed one.

## How it works

- `fetch-data.js` pulls your profile from the community-run
  [Elite API](https://api.elitebot.dev) (free, no key, data sourced from the
  official Hypixel API), analyzes it, and writes `data.js`.
- `dashboard.html` is a single self-contained page that renders `data.js`.
  It works offline once data is fetched.
- Your data never leaves your machine - the only network request is fetching your
  own (already public) profile.

Note: the dashboard works for normal profiles too, but the recommendations assume
Ironman rules (no Auction House / Bazaar).

## Disclaimer

Not affiliated with Hypixel or Mojang. Data comes from the public Elite API
(elitebot.dev). Game knowledge (accessory chains, armor ladders) is curated by
hand in `fetch-data.js` - PRs welcome if something is outdated.
