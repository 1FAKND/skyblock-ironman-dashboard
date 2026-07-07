# SkyBlock Ironman Dashboard

A local, no-install-hassle dashboard for your Hypixel SkyBlock **Ironman** profile.
Run one script, get a browser dashboard with your full profile analyzed and a
**prioritized, Ironman-friendly to-do list**.

No API key needed. No account. No server. Everything runs on your own machine.

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
  Ironman-obtainable accessories you're missing, each with its source
- **Pets & Minions** — full pet list, minion slot progress

## Requirements

- [Node.js](https://nodejs.org) (any recent version - the free LTS installer is fine)
- A Hypixel SkyBlock profile with API settings enabled
  (in game: **SkyBlock Menu → Settings → Personal → API Settings → enable everything**)

## Setup (one time)

1. Download this repository (green **Code** button → *Download ZIP*) and unzip it,
   or `git clone` it.
2. Copy `config.example.json` to `config.json`.
3. Open `config.json` in any text editor and put your Minecraft username in it:

   ```json
   {
     "username": "YourNameHere",
     "profileName": ""
   }
   ```

   Leave `profileName` empty to auto-pick your Ironman profile, or set it to a
   specific profile's fruit name (e.g. `"Apple"`).

## Daily use

**Windows:** double-click `Refresh Dashboard.bat`. It fetches your latest data and
opens the dashboard in your browser.

**Mac/Linux:** run `node fetch-data.js`, then open `dashboard.html` in a browser.

Re-run whenever you want fresh data. The analysis rebuilds itself from scratch each
time, so completed recommendations disappear automatically.

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
