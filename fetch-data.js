/**
 * SkyBlock Ironman Dashboard - data fetcher & analyzer
 *
 * Fetches profile data from the Elite API (api.elitebot.dev - free, no key needed),
 * analyzes skills / slayers / dungeons / gear / accessories / pets / minions,
 * generates prioritized Ironman-friendly recommendations, and writes data.js
 * which dashboard.html reads.
 *
 * Run:  node fetch-data.js
 */

const fs = require("fs");
const path = require("path");

const VERSION = "1.16.0"; // bump on every meaningful release - the update check compares this
const REPO_URL = "https://github.com/1FAKND/skyblock-ironman-dashboard";
const REMOTE_SELF = "https://raw.githubusercontent.com/1FAKND/skyblock-ironman-dashboard/main/fetch-data.js";

const API = "https://api.elitebot.dev";
const HERE = __dirname;
const UA = `SkyBlock-Ironman-Dashboard/${VERSION} (personal local dashboard)`;

// ---------------------------------------------------------------- utilities

async function fetchJson(url, { optional = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 404 && optional) return null;
      if (res.status === 404) { const e = new Error("not found (HTTP 404)"); e.noRetry = true; throw e; }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      if (err.noRetry || attempt === 3) {
        if (optional) return null;
        throw err;
      }
      console.log(`  retry ${attempt + 1}/3 for ${url} (${err.message})`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// compares this copy's VERSION against the one published on GitHub;
// returns update info or null (silently, so a failed check never breaks a refresh)
async function checkForUpdate() {
  try {
    const res = await fetch(REMOTE_SELF, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const remote = (await res.text()).match(/const VERSION = "([\d.]+)"/)?.[1];
    if (!remote) return null;
    const a = VERSION.split(".").map(Number), b = remote.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((b[i] ?? 0) > (a[i] ?? 0)) return { current: VERSION, latest: remote, url: REPO_URL, zip: `${REPO_URL}/archive/refs/heads/main.zip` };
      if ((b[i] ?? 0) < (a[i] ?? 0)) return null;
    }
    return null;
  } catch {
    return null;
  }
}

function stripColors(s) {
  return (s || "").replace(/§./g, "");
}

// SkyBlock calendar: epoch = Early Spring 1, Year 1 (wiki: unix 1560275700);
// 1 SkyBlock day = 20 real minutes, 31 days/month, 12 months/year
const SB_EPOCH = 1560275700000;
const SB_DAY = 20 * 60 * 1000;
const SB_MONTH = 31 * SB_DAY;
const SB_YEAR = 12 * SB_MONTH;
const SB_MONTHS = ["Early Spring", "Spring", "Late Spring", "Early Summer", "Summer", "Late Summer", "Early Autumn", "Autumn", "Late Autumn", "Early Winter", "Winter", "Late Winter"];
function sbDate(t = Date.now()) {
  const inYear = (t - SB_EPOCH) % SB_YEAR;
  return { year: Math.floor((t - SB_EPOCH) / SB_YEAR) + 1, month: Math.floor(inYear / SB_MONTH), day: Math.floor((inYear % SB_MONTH) / SB_DAY) + 1 };
}
// yearly window starting at (month 0-11, day 1-31) lasting `days` SkyBlock days
function sbWindow(month, day, days, t = Date.now()) {
  const inYear = (t - SB_EPOCH) % SB_YEAR;
  const start = month * SB_MONTH + (day - 1) * SB_DAY;
  const end = start + days * SB_DAY;
  if (inYear >= start && inYear < end) return { active: true, ms: end - inYear };
  let until = start - inYear;
  if (until < 0) until += SB_YEAR;
  return { active: false, ms: until };
}
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const RARITIES = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC", "DIVINE", "SPECIAL", "VERY SPECIAL"];
function itemRarity(item) {
  if (!item || !Array.isArray(item.lore)) return null;
  for (let i = item.lore.length - 1; i >= Math.max(0, item.lore.length - 3); i--) {
    const line = stripColors(item.lore[i]).toUpperCase();
    if (line.includes("VERY SPECIAL")) return "VERY SPECIAL";
    for (const r of RARITIES) {
      if (r !== "SPECIAL" && r !== "VERY SPECIAL" && line.includes(r)) return r;
    }
    if (line.includes("SPECIAL")) return "SPECIAL";
  }
  return null;
}

function itemsOf(inv) {
  if (!inv || !inv.items) return [];
  return Object.values(inv.items).filter((it) => it && it.skyblockId);
}

// ------------------------------------------------------------------- main

async function main() {
  // ---- config
  const cfgPath = path.join(HERE, "config.json");
  if (!fs.existsSync(cfgPath)) {
    const example = path.join(HERE, "config.example.json");
    if (fs.existsSync(example)) fs.copyFileSync(example, cfgPath);
    else fs.writeFileSync(cfgPath, JSON.stringify({ username: "PUT_YOUR_MINECRAFT_NAME_HERE", profileName: "" }, null, 2));
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^﻿/, ""));
  let username = (cfg.username || "").trim();
  const warnings = [];

  if (!username || /PUT_YOUR/i.test(username)) {
    // first run: ask in the console window (only when one is attached)
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const readline = require("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log("Welcome! One-time setup:");
      const answer = (await rl.question("  Enter your Minecraft username: ")).trim();
      rl.close();
      if (answer) {
        username = answer;
        fs.writeFileSync(cfgPath, JSON.stringify({ username, profileName: cfg.profileName || "" }, null, 2) + "\n", "utf8");
        console.log(`  Saved to config.json - you won't be asked again.\n`);
      }
    }
  }
  if (!username || /PUT_YOUR/i.test(username)) {
    writeError(
      "No username set",
      'Open config.json (in the skyblock-dashboard folder) with Notepad and replace PUT_YOUR_MINECRAFT_NAME_HERE with your Minecraft username, then run "Refresh Dashboard.bat" again.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Fetching SkyBlock data for "${username}" ...`);
  const updatePromise = checkForUpdate(); // runs alongside the data fetch

  // ---- account + profile selection
  let account;
  try {
    account = await fetchJson(`${API}/account/${encodeURIComponent(username)}`);
  } catch (err) {
    const notFound = /404/.test(err.message);
    writeError(
      notFound ? `Player "${username}" not found` : `Could not fetch data for "${username}"`,
      notFound
        ? `No Minecraft player with that name was found. Check the spelling of "username" in config.json (capitalization doesn't matter, but every letter does).`
        : `The Elite API request failed (${err.message}). Check your internet connection and try again in a minute.`
    );
    process.exitCode = 1;
    return;
  }

  const profiles = account.profiles || [];
  if (profiles.length === 0) {
    writeError(
      `"${account.name || username}" has no SkyBlock profiles`,
      "This Minecraft account has never played Hypixel SkyBlock (or its data is not public). Double-check the username in config.json."
    );
    process.exitCode = 1;
    return;
  }

  let profile = null;
  if (cfg.profileName) {
    profile = profiles.find((p) => (p.profileName || "").toLowerCase() === cfg.profileName.toLowerCase());
    if (!profile) warnings.push(`Profile "${cfg.profileName}" not found - falling back to automatic selection.`);
  }
  if (!profile) {
    const ironman = profiles.filter((p) => p.gameMode === "ironman");
    profile = ironman.find((p) => p.selected) || ironman[0] || profiles.find((p) => p.selected) || profiles[0];
    if (profile.gameMode !== "ironman") {
      warnings.push(
        `No Ironman profile found for this account - showing "${profile.profileName}" (${profile.gameMode || "normal"}) instead. Recommendations are still Ironman-flavored.`
      );
    }
  }

  console.log(`  profile: ${profile.profileName} (${profile.gameMode || "normal"}${profile.selected ? ", currently selected" : ""})`);

  // ---- member data
  const member = await fetchJson(`${API}/profile/${account.id}/${profile.profileId}`);
  // current mayor/minister - public Hypixel resource endpoint, no API key
  const election = await fetchJson("https://api.hypixel.net/v2/resources/skyblock/election", { optional: true });

  // ---- inventories we analyze: everything except icon/sack display bags,
  // so ownership checks see all real storage (incl. the Loadouts update's
  // equipment_wardrobe and the personal vault)
  const wantInv = (n) => !/^(icons_backpack|sacks_bag)$/.test(n);
  const invIndex = Object.fromEntries((member.inventories || []).map((i) => [i.name, i.id]));
  const invs = {};
  for (const [name, id] of Object.entries(invIndex)) {
    if (!wantInv(name)) continue;
    console.log(`  fetching ${name} ...`);
    invs[name] = await fetchJson(`${API}/profile/${account.id}/${profile.profileId}/inventories/${id}`, { optional: true });
  }

  // =================================================================
  // ANALYSIS
  // =================================================================

  const api = member.api || {};
  const skills = member.stats?.skills?.levels || {};
  const skillAverage = member.stats?.skills?.average ?? null;
  const slayerBosses = member.stats?.slayer?.bosses || {};
  const dungeons = member.stats?.dungeons || {};
  const acc = member.stats?.accessories || {};
  const pets = member.pets || [];
  const petSummary = member.petSummary || {};
  const minions = member.minionSummary || {};
  const networth = member.networth || {};

  const armorItems = itemsOf(invs.armor);
  const equipItems = itemsOf(invs.equipment);
  const accessoryItems = itemsOf(invs.talisman_bag);

  const recs = [];
  const rec = (priority, category, title, why, how) => recs.push({ priority, category, title, why, how });
  // priority: 1 = High, 2 = Medium, 3 = Low

  // ---------------- API settings ----------------
  if (api.inventories === false) {
    rec(1, "Setup", "Enable your Inventory API",
      "Your Hypixel Inventory API is OFF, so gear and accessory analysis is blank.",
      "In game: SkyBlock Menu → Settings → Personal → API Settings → enable everything. Then refresh this dashboard.");
  }
  if (api.skills === false) {
    rec(1, "Setup", "Enable your Skills API",
      "Your Skills API is OFF, so skill levels can't be read.",
      "In game: SkyBlock Menu → Settings → Personal → API Settings → enable Skills.");
  }

  // ---------------- Skills ----------------
  const skillLevel = (name) => skills[name]?.level ?? 0;
  const ironmanSkillAdvice = {
    combat: [30, "Combat is the backbone of all progression - it gates slayers and damage.",
      "Grind Bestiary while doing slayers; early Ironman spots: Zombie/Spider caves, then the End. Use a Wolf/Tiger pet to level Taming at the same time."],
    mining: [30, "Mining unlocks Heart of the Mountain perks and commissions - one of the strongest Ironman money/resource loops.",
      "Do Dwarven Mines commissions daily, spend Mithril Powder in the HotM tree, and work toward a Mithril → Titanium drill setup."],
    farming: [30, "Farming feeds the Garden, Jacob contests, and most Ironman food/crafting needs.",
      "Unlock the Garden, complete visitor offers for Garden XP + Copper, and farm crops during Jacob contests for medals and gold."],
    enchanting: [30, "Enchanting level directly boosts XP gains and unlocks better enchants (huge for a self-sufficient Ironman).",
      "Do the daily Experimentation Table (Superpairs) - it is by far the fastest Enchanting XP and drops enchant books you can't buy on Ironman."],
    alchemy: [25, "Alchemy unlocks longer, stronger potions - Ironman can't buy God Potions casually, so brewing matters.",
      "Brew Enchanted Sugar Cane speed potions or Nether Wart-based potions in bulk from minion output; each brew gives solid XP."],
    taming: [25, "Taming boosts all pet stats; it levels passively from pet XP.",
      "Always keep a pet equipped that matches what you're grinding. Never grind without a pet out."],
    fishing: [15, "Fishing unlocks sea creatures (Bestiary, rare drops) and is a common Ironman gear source.",
      "Fish during events (Fishing Festival) and while AFK-ish; upgrade your rod through the Fishing collection - it's slow but front-loads value."],
    foraging: [15, "Foraging gates some talismans, axes and the Park island content.",
      "Chop in the Park with the best axe your collection allows; do it in short bursts - it's not a priority beyond the early milestones."],
  };
  for (const [name, [target, why, how]] of Object.entries(ironmanSkillAdvice)) {
    const lvl = skillLevel(name);
    if (lvl < target) {
      const pr = lvl < target * 0.5 ? 1 : 2;
      rec(pr, "Skills", `Raise ${name[0].toUpperCase() + name.slice(1)} to ${target} (currently ${lvl})`, why, how);
    }
  }
  if (skillAverage !== null && skillAverage >= 40) {
    const capped = Object.entries(skills).filter(([n, s]) => s.level >= s.maxLevel && !["runecrafting", "social"].includes(n));
    if (capped.length) {
      rec(3, "Skills", `${capped.length} skill(s) at cap - nice`, "Capped skills stop giving stat bonuses; your XP is better spent elsewhere.", "Focus remaining XP on uncapped skills, especially ones that gate content you play.");
    }
  }

  // ---------------- Slayers ----------------
  // unlock chain verified against the wiki: each slayer opens by defeating a
  // specific tier of the previous one (vampire opens via Rift progression)
  const SLAYER_PREREQ = {
    zombie: null,
    spider: { boss: "zombie", tier: 2, label: "Revenant Horror" },
    wolf: { boss: "spider", tier: 2, label: "Tarantula Broodfather" },
    enderman: { boss: "wolf", tier: 4, label: "Sven Packmaster" },
    blaze: { boss: "enderman", tier: 3, label: "Voidgloom Seraph" },
    vampire: { special: "Progress the Rift dimension and secure its Timecharm" },
  };
  const tierKills = (boss, tier) => Number(slayerBosses[boss]?.bossKills?.[String(tier - 1)] ?? 0);
  const slayerUnlocked = (boss) => {
    const p = SLAYER_PREREQ[boss];
    if (!p) return true;
    if ((slayerBosses[boss]?.xp ?? 0) > 0) return true; // already has XP = clearly unlocked
    if (p.special) return false;
    return tierKills(p.boss, p.tier) >= 1;
  };
  const slayerLockText = (boss) => {
    const p = SLAYER_PREREQ[boss];
    if (!p) return null;
    return p.special || `Defeat a Tier ${["I", "II", "III", "IV", "V"][p.tier - 1]} ${p.label} to unlock`;
  };

  const slayerMeta = {
    zombie: { target: 5, unlock: "Revenant gear, the Reaper Falchion line and key crafting recipes (e.g. for late-game swords)" },
    spider: { target: 4, unlock: "Tarantula gear and toxic arrow poison recipes" },
    wolf: { target: 4, unlock: "the Pooch Sword line and Grizzly gear" },
    enderman: { target: 4, unlock: "Voidgloom drops - the core of Ironman end-game weapons and Ender Slayer books" },
    blaze: { target: 3, unlock: "Blaze slayer drops that feed Crimson Isle gear upgrades" },
    vampire: { target: 3, unlock: "Rift-side rewards (low priority for most Ironman roadmaps)" },
  };
  const combatLvl = skillLevel("combat");
  for (const [boss, meta] of Object.entries(slayerMeta)) {
    const s = slayerBosses[boss];
    const lvl = s?.level ?? 0;
    if (lvl < meta.target) {
      // don't push hard slayers on fresh profiles
      let pr = 2;
      if (boss === "zombie" && combatLvl >= 15) pr = 1;
      if ((boss === "enderman" || boss === "blaze") && combatLvl < 30) pr = 3;
      if (boss === "vampire") pr = 3;
      if (!slayerUnlocked(boss)) {
        rec(pr, "Slayers", `Unlock ${boss[0].toUpperCase() + boss.slice(1)} Slayer first`,
          `This slayer is still locked. Leveling it to ${meta.target} later unlocks ${meta.unlock}.`,
          `${slayerLockText(boss)}.`);
      } else {
        rec(pr, "Slayers", `${boss[0].toUpperCase() + boss.slice(1)} Slayer ${lvl} → ${meta.target}`,
          `Level ${meta.target} unlocks ${meta.unlock}.`,
          "Do the highest tier you can complete in ~2-3 minutes reliably; on Ironman the RNG drops along the way are half the reward.");
      }
    }
  }

  // ---------------- Dungeons ----------------
  const cata = dungeons.catacombsLevel ?? 0;
  if (cata === 0 && combatLvl >= 15) {
    rec(2, "Dungeons", "Start Catacombs",
      "Dungeons are the main Ironman source of strong armor/weapons you cannot craft (Shadow Assassin, wither gear, and more).",
      "Talk to Mort at the Dungeon Hub, run the Entrance/F1 a few times, and pick a class (Berserk or Archer are simple to start).");
  } else if (cata > 0 && cata < 24) {
    rec(2, "Dungeons", `Push Catacombs ${cata} → 24+`,
      "Each Catacombs level multiplies your dungeon stats; the F5-F7 gear (Shadow Assassin → Necron/wither gear) defines Ironman mid-to-late game.",
      "Run your highest comfortable floor daily. Learn secret routes - score (S/S+) drives both XP and loot quality.");
  }
  if (cata >= 15) {
    const classes = dungeons.classLevels || {};
    const entries = Object.entries(classes);
    if (entries.length) {
      const lowest = entries.reduce((a, b) => ((a[1].level ?? 0) <= (b[1].level ?? 0) ? a : b));
      if ((lowest[1].level ?? 0) < cata - 10) {
        rec(3, "Dungeons", `Level your ${lowest[0]} class (${lowest[1].level})`,
          "Class average boosts your stats in dungeons across all classes.",
          "Rotate your played class occasionally, or run lower floors on weak classes for fast levels.");
      }
    }
  }

  // ---------------- Accessories ----------------
  const mp = acc.highestMagicalPower ?? 0;
  const accCount = accessoryItems.length;
  if (api.inventories !== false) {
    if (mp < 100) {
      rec(1, "Accessories", `Build Magical Power (currently ${mp})`,
        "Magical Power scales all your accessory-power stats - it's the cheapest overall stat boost an Ironman can get.",
        "Collect every cheap talisman: Zombie/Skeleton/Wolf talismans, Feather, Potato, Vaccine, Farming/Mining/Fishing talismans, Intimidation, Scavenger, etc. Most are craftable from collections or cheap NPC buys.");
    } else if (mp < 700) {
      rec(2, "Accessories", `Keep pushing Magical Power (${mp})`,
        "Mid-game MP milestones unlock big stat jumps via your selected Power.",
        "Work through craftable accessory upgrade chains (talisman → ring → artifact) using collection resources, and pick up event/quest accessories whenever available.");
    }
    if (!acc.selectedPower && mp > 0) {
      rec(1, "Accessories", "Select an Accessory Power",
        "You have Magical Power but no Power selected - you're getting almost nothing from your accessory bag.",
        "Open your Accessory Bag → Accessory Power and pick one (a generic damage power is fine to start).");
    }
    const tuningRemaining = member.stats?.accessoryDerivations?.tuningSlotsRemaining;
    const tuning = acc.tuningSlots || [];
    const unusedTuning = tuning.length > 0 && tuning.every((t) => Object.values(t).every((v) => !v));
    if (unusedTuning) {
      rec(2, "Accessories", "Assign your Tuning Points",
        "Your accessory tuning slots are all empty - free stats are sitting unused.",
        "Accessory Bag → Stats Tuning: dump points into Strength/Crit Damage (or Speed if you're under 400).");
    } else if (typeof tuningRemaining === "number" && tuningRemaining > 0) {
      rec(3, "Accessories", `Unlock your remaining tuning slot(s) (${tuningRemaining} left)`,
        "Extra tuning slots are permanent free stats.",
        "Tuning slots unlock at Magical Power milestones - keep collecting accessories.");
    }
    if (accCount > 0) {
      const recombed = accessoryItems.filter((i) => i.attributes?.rarity_upgrades === "1").length;
      const enriched = accessoryItems.filter((i) => i.attributes?.talisman_enrichment).length;
      const legendaryPlus = accessoryItems.filter((i) => ["LEGENDARY", "MYTHIC"].includes(itemRarity(i))).length;
      if (legendaryPlus > enriched && mp >= 500) {
        rec(3, "Accessories", `Enrich your Legendary+ accessories (${enriched}/${legendaryPlus} enriched)`,
          "Enrichments add a small stat to each Legendary/Mythic accessory - it adds up.",
          "Buy enrichments with Bits from the Community Shop (Ironman can earn Bits via Booster Cookies bought with Gems).");
      }
      if (recombed < Math.min(5, accCount) && mp >= 400) {
        rec(3, "Accessories", "Recombobulate high-value accessories",
          "Each recomb bumps an accessory a full rarity tier = more Magical Power.",
          "Recombobulators are scarce on Ironman (dungeon chests, Dark Auction, rare drops) - spend them on your highest-rarity accessories first.");
      }
    }
  }

  // ---------------- Gear ----------------
  const ARMOR_TIERS = [
    { rank: 1, match: /^(LEATHER|IRON|GOLD|CHAIN|LAPIS_ARMOR|MINER)/, label: "starter armor" },
    { rank: 2, match: /^(HARDENED_DIAMOND|GOLEM|ZOMBIE_(HELMET|CHESTPLATE|LEGGINGS|BOOTS)|SKELETON)/, label: "early armor" },
    { rank: 3, match: /^(ENDER_(HELMET|CHESTPLATE|LEGGINGS|BOOTS)|REVENANT|TARANTULA|MAGMA_LORD_)/, label: "early-mid armor" },
    { rank: 4, match: /^(SUPERIOR_DRAGON|STRONG_DRAGON|UNSTABLE_DRAGON|WISE_DRAGON|YOUNG_DRAGON|OLD_DRAGON|PROTECTOR_DRAGON|HOLY_DRAGON)/, label: "Dragon armor" },
    { rank: 5, match: /^(SHADOW_ASSASSIN|ADAPTIVE|FROZEN_BLAZE|SPIRIT_(BOOTS|LEGGINGS|CHESTPLATE|MASK))/, label: "dungeon mid-game armor" },
    { rank: 6, match: /^(CRIMSON|AURORA|TERROR|FERVOR|HOLLOW)/, label: "Kuudra (Crimson Isle) armor" },
    { rank: 7, match: /^(NECRON|STORM|GOLDOR|MAXOR|WITHER_(HELMET|CHESTPLATE|LEGGINGS|BOOTS))/, label: "wither armor (end-game)" },
  ];
  const SPECIALIST = /^(FARM|MELON|CROPIE|SQUASH|FERMENTO|HELIANTHUS|RANCHER|ENCHANTED_JACK|GLACITE|SORROW|MITHRIL_CORE|HEAT_CORE|ARMOR_OF_DIVAN|DIVAN|FISHERMAN|SPONGE|SHARK_SCALE|SALMON|TAURUS|FLAMING_CHESTPLATE|MOOGMA|SLUG|THUNDER|MAGMA_LORD)/;

  function armorRank(items) {
    let best = 0, specialist = 0, unknown = 0;
    for (const it of items) {
      const id = it.skyblockId || "";
      if (SPECIALIST.test(id)) { specialist++; continue; }
      let matched = false;
      for (const t of ARMOR_TIERS) if (t.match.test(id)) { best = Math.max(best, t.rank); matched = true; }
      if (!matched) unknown++;
    }
    return { best, specialist, unknown };
  }

  if (api.inventories !== false && armorItems.length > 0) {
    const { best, specialist, unknown } = armorRank(armorItems);
    const nextByRank = {
      0: ["get a real armor set", "Craft Hardened Diamond (40k+ Diamond collection mining) or farm Zombie/Skeleton pieces in the Catacombs entrance."],
      1: ["upgrade to Hardened Diamond or Golem", "Hardened Diamond is pure mining; Golem armor comes from the Diamond collection + End stone. Both are fully Ironman-craftable."],
      2: ["work toward Ender armor + dragons", "Ender armor (from Endermen in the End, doubled stats there) carries you to Dragon fights. Join End dragon fights for Dragon armor pieces."],
      3: ["target a Dragon set - ideally Superior", "Place Summoning Eyes at dragon altars (Ender Pearl + Summoning Eye grind). Superior is the all-round pick; Strong works for melee."],
      4: ["push Dungeons for Shadow Assassin", "Shadow Assassin drops on Floor 5 - it's the classic Ironman bridge set between Dragon and wither armor."],
      5: ["aim at Kuudra or F7 wither armor", "Crimson Isle: reputation grind + Kuudra runs for Crimson/Terror sets. Or push Catacombs to F7 for Necron/Storm/Goldor/Maxor pieces."],
      6: ["refine your Kuudra set and push F7/M-floors", "Upgrade Kuudra armor tiers (Hot → Burning → Fiery → Infernal) and chase wither armor in Master Mode."],
      7: ["min-max: Master Mode + attribute/gemstone upgrades", "You're in end-game armor. Focus on 5-starring, gemstones, and Master Mode dungeon upgrades."],
    };
    const established = combatLvl >= 30 || cata >= 12; // clearly not an early-game profile
    if (specialist >= 3 && best === 0) {
      rec(3, "Gear", "You're wearing a specialist (farming/mining/fishing) set",
        "That's great for its activity - just make sure a combat set exists in your wardrobe for slayers/dungeons.",
        "Check the Gear section below; if you have no combat set, follow the armor ladder starting from Hardened Diamond/Ender armor.");
    } else if (best === 0 && unknown >= 2 && established) {
      rec(3, "Gear", "Worn armor not in this dashboard's ladder",
        "Your equipped set isn't one this dashboard recognizes (likely event or newer content, e.g. Diana's Challenger/Mythos sets) - so no armor-ladder advice this refresh.",
        "No action needed if the set is intentional. Your wardrobe and stats suggest you know what you're doing here.");
    } else if (nextByRank[best]) {
      const [title, how] = nextByRank[best];
      const pr = best <= 2 ? 1 : best <= 5 ? 2 : 3;
      rec(pr, "Gear", `Armor: ${title}`,
        `Your current set sits at the "${ARMOR_TIERS.find((t) => t.rank === best)?.label || "starter"}" stage of the Ironman armor ladder.`,
        how);
    }

    // enchant quality on worn armor
    const weakEnchants = [];
    for (const it of armorItems) {
      const e = it.enchantments || {};
      const nm = stripColors(it.name);
      if ((e.growth ?? 0) < 5) weakEnchants.push(`${nm}: Growth ${e.growth ?? 0}`);
      if ((e.protection ?? 0) < 5) weakEnchants.push(`${nm}: Protection ${e.protection ?? 0}`);
    }
    if (weakEnchants.length) {
      rec(2, "Gear", "Armor enchants below Growth 5 / Protection 5",
        `Weak defensive enchants found - ${weakEnchants.slice(0, 4).join("; ")}${weakEnchants.length > 4 ? "; …" : ""}.`,
        "Level Enchanting and use the Experimentation Table daily for high-tier books; combine dupes in an anvil.");
    }
    const unreforged = armorItems.filter((i) => !i.attributes?.modifier);
    if (unreforged.length) {
      rec(2, "Gear", `${unreforged.length} armor piece(s) with no reforge`,
        "Reforges are free stats - an unreforged piece wastes a big chunk of its value.",
        "Use the Reforge Anvil (or Reforge NPC) - even a basic reforge helps; aim for Fierce/Wise or reforge-stone reforges later.");
    }
    const noHpb = armorItems.filter((i) => Number(i.attributes?.hot_potato_count || 0) < 10);
    if (noHpb.length && best >= 3) {
      rec(3, "Gear", `Hot Potato Books missing on ${noHpb.length} piece(s)`,
        "Each HPB adds flat Health/Defense; 10 per piece is standard.",
        "HPBs are craftable from the Potato collection - very Ironman-friendly. Farm potatoes, craft, apply at an anvil.");
    }
  }
  if (api.inventories !== false && equipItems.length < 4) {
    rec(2, "Gear", `Fill your equipment slots (${equipItems.length}/4 filled)`,
      "Necklace/Cloak/Belt/Gloves give permanent stats independent of armor.",
      "Early Ironman pieces come from Fishing (e.g. Angler set), the Rift, slayer drops, and Crimson Isle reputation vendors.");
  }

  // ---------------- Pets ----------------
  const petByType = {};
  for (const p of pets) {
    const cur = petByType[p.type];
    if (!cur || (p.level ?? 0) > (cur.level ?? 0)) petByType[p.type] = p;
  }
  const havePet = (t) => petByType[t];
  const active = petSummary.activePet || null;

  if (pets.length === 0) {
    rec(1, "Pets", "Get a pet - any pet",
      "Pets add huge stats and level Taming. Playing petless wastes every minute of grinding.",
      "Early Ironman pets: craft a Rock pet (mining), Zombie/Bee pets from collections, or buy a starter pet from Bea with coins + fee.");
  } else {
    if (!active) {
      rec(2, "Pets", "No pet currently equipped",
        "An unequipped pet gives nothing - stats and Taming XP only flow while one is out.",
        "Equip the best pet for whatever you're grinding right now.");
    }
    if (!havePet("ENDER_DRAGON") && combatLvl >= 25) {
      rec(2, "Pets", "Work toward an Ender Dragon pet",
        "The Ender Dragon pet is the Ironman combat pet - Golden Dragon isn't realistically obtainable without the Auction House.",
        "Ender Dragon eggs drop from End dragon fights (top damage/RNG). Keep joining fights while you grind the End.");
    }
    const maxed = petSummary.maxLevelPets ?? 0;
    if (pets.length >= 5 && maxed === 0) {
      rec(3, "Pets", "Level a core pet to 100",
        "A level-100 pet is dramatically stronger than a level-60 one; focus beats spreading XP thin.",
        "Pick your main grinding pet and keep it equipped; matching the pet to the skill you're grinding doubles up the value.");
    }
  }

  // ---------------- Minions ----------------
  if (minions.maxSlots) {
    if ((minions.currentSlots ?? 0) < minions.maxSlots) {
      const need = minions.uniqueTiersToNextSlot;
      rec(2, "Minions", `Next minion slot: craft ${need} more unique tier(s)`,
        `You have ${minions.currentSlots}/${minions.maxSlots} minion slots. On Ironman, minions ARE your economy - every slot compounds daily.`,
        "Craft the cheapest un-crafted minion tiers (check the crafted minions list) - low tiers of new minion types are the fastest unique-tier gains.");
    }
  }

  // =================================================================
  // DEEP GEAR & ACCESSORY REVIEW (all storage: wardrobe, ender chest,
  // backpacks, toolkits; museum counts as "owned" but is tagged)
  // =================================================================

  const allItems = [];
  for (const [cname, inv] of Object.entries(invs)) {
    for (const it of itemsOf(inv)) allItems.push({ id: it.skyblockId, name: stripColors(it.name), container: cname });
  }
  const ownedIds = new Set(allItems.map((i) => i.id));
  const bagIds = accessoryItems.map((i) => i.skyblockId);
  // item-id -> display name; small words stay lowercase like the in-game names
  // ("Aspect of the End"), plus overrides where the in-game name differs from the id
  const NAME_OVERRIDES = {
    DAEDALUS_AXE: "Daedalus Blade", STARRED_DAEDALUS_AXE: "Fragged Daedalus Blade", MANTI_CORE: "Manti-core",
    FOUR_EYED_FISH: "Four-Eyed Fish", WASHED_UP_SOUVENIR: "Washed-up Souvenir", DAEDALUS_NOTES: "Daedalus' Notes",
  };
  const nice = (id) => NAME_OVERRIDES[id] || id.toLowerCase().split("_").filter(Boolean)
    .map((w, i) => (i > 0 && /^(of|the|and|to|in)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" ");

  // ---- accessory upgrade chains (lowest → highest tier) ----
  const ACCESSORY_CHAINS = [
    { chain: ["ZOMBIE_TALISMAN", "ZOMBIE_RING", "ZOMBIE_ARTIFACT"], note: "Revenant slayer materials" },
    { chain: ["SPIDER_TALISMAN", "SPIDER_RING", "SPIDER_ARTIFACT"], note: "Tarantula slayer materials" },
    { chain: ["RED_CLAW_TALISMAN", "RED_CLAW_RING", "RED_CLAW_ARTIFACT"], note: "Sven slayer materials" },
    { chain: ["SEA_CREATURE_TALISMAN", "SEA_CREATURE_RING", "SEA_CREATURE_ARTIFACT"], note: "fishing materials" },
    { chain: ["INTIMIDATION_TALISMAN", "INTIMIDATION_RING", "INTIMIDATION_ARTIFACT"], note: "Fear Mongerer: ring + 100 Purple Candy" },
    { chain: ["SPEED_TALISMAN", "SPEED_RING", "SPEED_ARTIFACT"], note: "Sugar Cane collection" },
    { chain: ["POWER_TALISMAN", "POWER_RING", "POWER_ARTIFACT"], note: "uses flawless gemstones" },
    { chain: ["MINERAL_TALISMAN", "GLOSSY_MINERAL_TALISMAN"], note: "gemstone craft" },
    { chain: ["TITANIUM_TALISMAN", "TITANIUM_RING", "TITANIUM_ARTIFACT", "TITANIUM_RELIC"], note: "refined titanium (long grind)" },
    { chain: ["TREASURE_TALISMAN", "TREASURE_RING", "TREASURE_ARTIFACT"], note: "dungeon loot recipes" },
    { chain: ["JERRY_TALISMAN_GREEN", "JERRY_TALISMAN_BLUE", "JERRY_TALISMAN_PURPLE", "JERRY_TALISMAN_GOLDEN"], note: "Jerry's Workshop event" },
    { chain: ["BAT_TALISMAN", "BAT_RING", "BAT_ARTIFACT"], note: "Spooky Festival" },
    { chain: ["FEATHER_TALISMAN", "FEATHER_RING", "FEATHER_ARTIFACT"], note: "feather craft" },
    { chain: ["HEALING_TALISMAN", "HEALING_RING"], note: "healing craft" },
    { chain: ["CANDY_TALISMAN", "CANDY_RING", "CANDY_ARTIFACT", "CANDY_RELIC"], note: "Spooky candy" },
    { chain: ["WOLF_TALISMAN", "WOLF_RING"], note: "wolf drops + Sven materials" },
    { chain: ["SOULFLOW_PILE", "SOULFLOW_BATTERY", "SOULFLOW_SUPERCELL"], note: "Voidgloom soulflow" },
    { chain: ["WITHER_ARTIFACT", "WITHER_RELIC"], note: "wither essence" },
    { chain: ["SHADY_RING", "CROOKED_ARTIFACT", "SEAL_OF_THE_FAMILY"], note: "Dark Auction" },
    { chain: ["HASTE_RING", "HASTE_ARTIFACT"], note: "256x Enchanted Cobblestone" },
    { chain: ["VACCINE_TALISMAN", "VACCINE_RING", "VACCINE_ARTIFACT"], note: "8x Poison Sample (fishing drop)" },
    { chain: ["EMERALD_RING", "EMERALD_ARTIFACT"], note: "36x Ench Emerald Block + Avaricious Chalice (rare drop)" },
    { chain: ["BAT_PERSON_TALISMAN", "BAT_PERSON_RING", "BAT_PERSON_ARTIFACT"], note: "Spooky Shards + Ectoplasm" },
    { chain: ["GREAT_SPOOK_TALISMAN", "GREAT_SPOOK_RING", "GREAT_SPOOK_ARTIFACT"], note: "Great Spook event reward" },
  ];
  const accUpgrades = [];
  for (const { chain, note } of ACCESSORY_CHAINS) {
    let maxIdx = -1;
    for (let i = 0; i < chain.length; i++) if (ownedIds.has(chain[i])) maxIdx = i;
    if (maxIdx >= 0 && maxIdx < chain.length - 1) {
      accUpgrades.push({ have: nice(chain[maxIdx]), next: nice(chain[maxIdx + 1]), nextId: chain[maxIdx + 1], note });
    }
  }

  // ---- notable accessories an Ironman can obtain, checked against ALL storage ----
  const NOTABLES = [
    { ids: ["MELODY_HAIR"], name: "Melody's Hair", how: "Complete all of Melody's Harp songs in the Wizard Tower - free Magical Power, zero RNG." },
    { ids: ["WOLF_TALISMAN", "WOLF_RING"], name: "Wolf Talisman", how: "Drops from wolves (Ruins / Howling Cave); pairs with your Sven slayer materials." },
    { ids: ["TARANTULA_TALISMAN"], name: "Tarantula Talisman", how: "Drops from Tarantula slayer bosses (T3+)." },
    { ids: ["ENDER_ARTIFACT", "ENDER_RELIC"], name: "Ender Artifact", how: "End-content drop - comes naturally with zealot / Voidgloom grinding." },
    { ids: ["SOULFLOW_PILE", "SOULFLOW_BATTERY", "SOULFLOW_SUPERCELL"], name: "Soulflow chain", how: "Craft from Raw Soulflow dropped by Voidgloom Seraphs." },
    { ids: ["WITHER_ARTIFACT", "WITHER_RELIC"], name: "Wither Artifact", how: "Craft with Wither Essence from Catacombs runs." },
    { prefix: "WEDDING_RING", name: "Wedding Ring", how: "Romero & Juliette questline - long, but free and Ironman-friendly." },
    { ids: ["BAIT_RING"], name: "Bait Ring", how: "Fishing-side craft - check your recipe book." },
    { ids: ["AGARIMOO_TALISMAN"], name: "Agarimoo Talisman", how: "Craft from Agarimoo Tongues." },
    { ids: ["SURVIVOR_CUBE"], name: "Survivor Cube", how: "Rare drop from Zealots in the End." },
    { ids: ["DAY_CRYSTAL"], name: "Day Crystal", how: "Craft from the End Stone collection." },
    { ids: ["NIGHT_CRYSTAL"], name: "Night Crystal", how: "Craft from the End Stone collection." },
    { ids: ["BLOOD_GOD_CREST"], name: "Blood God Crest", how: "Crimson Isle - unlocks alongside reputation / Blaze slayer progress." },
  ];
  const accMissing = NOTABLES.filter((n) =>
    n.prefix ? ![...ownedIds].some((id) => id.startsWith(n.prefix)) : !n.ids.some((id) => ownedIds.has(id))
  ).map(({ name, how }) => ({ name, how }));

  // ---- housekeeping: dupes / redundant tiers in the accessory bag ----
  const housekeeping = [];
  {
    const counts = {};
    for (const id of bagIds) counts[id] = (counts[id] || 0) + 1;
    for (const [id, c] of Object.entries(counts)) {
      if (c > 1 && !/^PERSONAL_(COMPACTOR|DELETOR)/.test(id)) housekeeping.push(`${c}x ${nice(id)} in your accessory bag - duplicates never stack, remove ${c - 1}.`);
    }
    for (const { chain } of ACCESSORY_CHAINS) {
      const inBag = chain.filter((id) => bagIds.includes(id));
      if (inBag.length > 1) housekeeping.push(`${nice(inBag[0])} is obsolete - you also carry ${nice(inBag[inBag.length - 1])} (same family, only the highest tier counts).`);
    }
    const campfires = bagIds.filter((id) => /CAMPFIRE_TALISMAN_\d+$/.test(id));
    if (campfires.length > 1) housekeeping.push(`You carry ${campfires.length} Campfire talismans - only the highest tier counts, the rest add nothing.`);
    const stones = allItems.filter((i) => i.id.includes("UPGRADE_STONE"));
    for (const s of stones) housekeeping.push(`${s.name || nice(s.id)} sitting in ${s.container.replace("_", " ")} - check if one of your pets can use it.`);
    if (ownedIds.has("PULSE_RING") && allItems.some((i) => i.id === "THUNDER_IN_A_BOTTLE_EMPTY"))
      housekeeping.push("You have empty Thunder in a Bottle(s) - charge them during thunderstorms to upgrade your Pulse Ring.");
  }

  // ---- wearable sets grouped by activity, across all storage ----
  const SLOT_RX = /_(HELMET|CHESTPLATE|LEGGINGS|BOOTS|SUIT|HAT|MASK|NECKLACE|CLOAK|BELT|BRACELET|GLOVES|GAUNTLET|GRIPPERS|HANDWARMERS|LOCKET|VINE|TROUSERS|SHOES|JACKET)$/;
  const ARMOR_SLOTS = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS", "SUIT", "HAT", "MASK"];
  const ACTIVITY_RULES = [
    [/^(DIVAN|ARMOR_OF_DIVAN|SORROW|GLOSSY_MINERAL|MINERAL|ARMOR_OF_YOG|YOG|GLACITE|HEAT|MINER_OUTFIT|TANK_MINER|GOBLIN|TITANIUM|MITHRIL|DWARVEN)/, "mining"],
    [/^(HELIANTHUS|FERMENTO|SQUASH|CROPIE|MELON|FARM|RANCHER|PUMPKIN|CACTUS|MUSHROOM|BIOHAZARD|PESTHUNTERS|PEST_VEST|ENCHANTED_JACK|BLOSSOM|LOTUS|LEAFLET)/, "farming"],
    [/^(SHARK_SCALE|THUNDERBOLT|THUNDER|MAGMA_LORD|DIVER|SPONGE|SALMON|ANGLER|BACKWATER|FINWAVE|TAURUS|FLAMING|MOOGMA|SLUG|SQUID|SNORKELING|CLOWNFISH|PRISMARINE|SNOW)/, "fishing"],
    [/^(CHALLENGER|MYTHOS)_/, "combat"], // Diana (Mythological Ritual) gear
    [/^(SILVER_HUNTER|FIG|CANOPY|MANGROVE|MOSS)/, "foraging"],
    [/^(ADAPTIVE|SHADOW_ASSASSIN|ZOMBIE|SKELETON|HEAVY|SUPER_HEAVY|END(?=$|_)|ENDER|\w*_DRAGON|REVENANT|TARANTULA|MASTIFF|NECRON|STORM|GOLDOR|MAXOR|WITHER|CRIMSON|TERROR|AURORA|FERVOR|HOLLOW|SPIRIT|FROZEN_BLAZE|HARDENED_DIAMOND|GOLEM|LAPIS|ROTTEN|SKELETOR|VANQUISHED|IMPLOSION|ARACHNE|RAMPART|ABYSSAL|BONZO|DAVID)/, "combat"],
  ];
  const activityOf = (family) => {
    for (const [rx, act] of ACTIVITY_RULES) if (rx.test(family)) return act;
    return "other";
  };
  const families = {};
  for (const it of allItems) {
    const m = it.id.match(SLOT_RX);
    if (!m) continue;
    const family = it.id.replace(SLOT_RX, "");
    const f = (families[family] ||= { family, slots: new Set(), containers: new Set(), armorContainers: new Set() });
    f.slots.add(m[1]);
    f.containers.add(it.container === "museum" ? "museum" : it.container);
    if (ARMOR_SLOTS.includes(m[1]) && it.container !== "museum") f.armorContainers.add(it.container);
  }
  const setsByActivity = {};
  for (const f of Object.values(families)) {
    if (f.slots.size < 2) continue; // single pieces are noise
    const act = activityOf(f.family);
    (setsByActivity[act] ||= []).push({
      name: nice(f.family),
      pieces: f.slots.size,
      where: [...f.containers].map((c) => c.replace(/_/g, " ")).join(", "),
      museumOnly: f.containers.size === 1 && f.containers.has("museum"),
    });
    // scattered full armor set: 4+ armor slots owned, but a piece is buried
    // outside the places you'd actually equip from (worn slots / wardrobe)
    const armorPieces = [...f.slots].filter((s) => ARMOR_SLOTS.includes(s));
    const buried = [...f.armorContainers].filter((c) => !["armor", "wardrobe", "equipment"].includes(c));
    if (armorPieces.length >= 4 && f.armorContainers.size > 1 && buried.length > 0) {
      housekeeping.push(`Full ${nice(f.family)} set is completable, but piece(s) are buried in: ${buried.join(", ").replace(/_/g, " ")}.`);
    }
  }
  for (const list of Object.values(setsByActivity)) list.sort((a, b) => b.pieces - a.pieces);

  // ---- tools per activity ----
  const usable = allItems.filter((i) => i.container !== "museum");
  const uniqIds = (arr) => [...new Set(arr.map((i) => i.id))];
  const tools = {
    mining: uniqIds(usable.filter((i) => /DRILL|PICKAXE|PICKONIMBUS|GEMSTONE_GAUNTLET/.test(i.id) && !/UPGRADE/.test(i.id))).map(nice),
    farming: itemsOf(invs.farming_toolkit).map((i) => i.skyblockId),
    fishing: uniqIds(usable.filter((i) => i.id.includes("ROD") && !i.id.includes("RADAR"))).map(nice),
    foraging: uniqIds(usable.filter((i) => /AXE$|LASSO|FISHING_NET|RETIA|NEX_TITANUM|APEX_PRAEDATOR/.test(i.id))).map(nice),
    combat: uniqIds(usable.filter((i) =>
      /(SWORD|KATANA|BLADE|CLEAVER|DAGGER|SCEPTRE|SHORTBOW|(^|_)BOW$|WAND|WHIP|ASPECT_OF)/.test(i.id) &&
      !/(_ARTIFACT|_TALISMAN|_RING|_RELIC|BUNDLE)/.test(i.id)
    )).map(nice),
  };

  // farming tool tiers (max known tier 3)
  const TIERED_TOOL = /^(THEORETICAL_HOE_\w+?|MELON_DICER|PUMPKIN_DICER|FUNGI_CUTTER|COCO_CHOPPER)_(\d)$/;
  const hoeUpgrades = [];
  for (const id of tools.farming) {
    const m = id.match(TIERED_TOOL);
    if (m && Number(m[2]) < 3) hoeUpgrades.push(`${nice(m[1])} T${m[2]} → T${Number(m[2]) + 1}`);
  }
  tools.farming = tools.farming.map(nice);

  // ---- combat weapon gap checks (museum-donated items don't count) ----
  const usableIds = new Set(usable.map((i) => i.id));
  const DUNGEON_WEAPONS = ["LIVID_DAGGER", "SHADOW_FURY", "GIANTS_SWORD", "BAT_WAND", "FLOWER_OF_TRUTH", "JUJU_SHORTBOW", "TERMINATOR", "HYPERION", "VALKYRIE", "SCYLLA", "ASTRAEA", "AXE_OF_THE_SHREDDED", "NECRON_BLADE"];
  const hasDungeonWeapon = DUNGEON_WEAPONS.some((id) => usableIds.has(id));
  if (cata >= 12 && !hasDungeonWeapon) {
    rec(2, "Gear", "No serious dungeon weapon found anywhere in your storage",
      "At your Catacombs level a proper dungeon weapon is a bigger damage jump than any armor swap.",
      "Farm Floor 5 for the Livid Dagger (also drops Shadow Assassin armor), or Floor 4 for a Spirit Sceptre. Both are classic Ironman targets.");
  }
  const KATANAS = ["VOIDWALKER_KATANA", "VOIDEDGE_KATANA", "VORPAL_KATANA", "ATOMSPLIT_KATANA"]; // ascending; reqs eman 1/3/5/6 (NEU-verified)
  const katanaIdx = KATANAS.reduce((best, id, i) => (usableIds.has(id) ? i : best), -1);
  if (katanaIdx >= 0 && katanaIdx < KATANAS.length - 1 && (slayerBosses.enderman?.level ?? 0) >= 3) {
    rec(2, "Gear", `Upgrade your ${nice(KATANAS[katanaIdx])} → ${nice(KATANAS[katanaIdx + 1])}`,
      "The katana chain is the Ironman melee path through Voidgloom slayer.",
      "Higher Enderman slayer tiers drop the materials - upgrade as your slayer level allows.");
  }
  if (usableIds.has("ASPECT_OF_THE_END") && !usableIds.has("ASPECT_OF_THE_VOID")) {
    rec(3, "Gear", "Upgrade Aspect of the End → Aspect of the Void",
      "Same teleport, better stats - and you keep it forever as a utility item.",
      "Craftable with Summoning Eyes from zealot grinding in the End.");
  }

  // =================================================================
  // EVENTS - live status (mayor + SkyBlock calendar) and a step-by-step
  // progression path per event. Facts verified against the wiki / NEU
  // (2026-09-30); steps auto-check from the player's data where possible.
  // =================================================================

  const playerStats = member.stats?.playerStats || {};
  const events = [];
  const TIER_ORDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];
  const evSacks = member.sacks || {};
  const evHave = (id) => (evSacks[id] ?? 0) + allItems.filter((i) => i.id === id && i.container !== "museum").length;
  const evMats = (spec) => spec.map(([id, need]) => ({ name: nice(id), need, have: evHave(id), ok: evHave(id) >= need }));
  // items held by pets (e.g. a Minos Relic on the Griffin) live on the pet, not in storage
  const petHeld = new Set(pets.map((p) => p.heldItem).filter(Boolean));
  const has = (id) => ownedIds.has(id) || petHeld.has(id);
  const tierName = (t) => t[0] + t.slice(1).toLowerCase();
  const fmt = (n) => Math.round(n ?? 0).toLocaleString("en-US");
  // step: done = true/false (auto-detected) or null (repeat each event, can't be tracked);
  // pieces = optional per-piece breakdown [{ name, owned, mats }]
  const step = (text, done, matsSpec, pieces) => ({ text, done, mats: done === false && matsSpec ? evMats(matsSpec) : null, pieces: done === false && pieces ? pieces : null });

  // live mayor / minister perks
  const mayor = election?.mayor || null;
  const perkList = [...(mayor?.perks || []), ...(mayor?.minister?.perk ? [mayor.minister.perk] : [])];
  const perkActive = (name) => perkList.some((p) => p.name === name);
  const mayorInfo = mayor ? {
    mayor: mayor.name,
    perks: (mayor.perks || []).map((p) => ({ name: p.name, desc: stripColors(p.description) })),
    minister: mayor.minister ? { name: mayor.minister.name, perk: mayor.minister.perk?.name, desc: stripColors(mayor.minister.perk?.description) } : null,
  } : null;
  const now = sbDate();
  const sbToday = `${SB_MONTHS[now.month]} ${now.day}, Year ${now.year}`;

  // ---- Mythological Ritual (Diana) ----
  {
    const my = playerStats.mythos || {};
    const griffin = petByType["GRIFFIN"] || null;
    const gTier = griffin ? TIER_ORDER.indexOf(griffin.tier) : -1;
    const kills = Object.entries(my)
      .filter(([k]) => k.startsWith("kills"))
      .map(([k, v]) => [k.slice(5).replace(/([a-z])([A-Z])/g, "$1 $2") + " kills", fmt(v)]);
    // Diana item recipes (NEU repo, checked 2026-09-30)
    const DR = {
      CHALLENGER_HELMET: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 32], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_CHESTPLATE: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 48], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_LEGGINGS: [["ANCIENT_CLAW", 128], ["ENCHANTED_GOLD", 16], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_BOOTS: [["ENCHANTED_GOLD", 64], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_NECKLACE: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 32], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_CLOAK: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 32], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_BELT: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 32], ["GRIFFIN_FEATHER", 4]],
      CHALLENGER_BRACELET: [["ANCIENT_CLAW", 64], ["ENCHANTED_GOLD", 32], ["GRIFFIN_FEATHER", 4]],
      MYTHOS_HELMET: [["CHALLENGER_HELMET", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 64]],
      MYTHOS_CHESTPLATE: [["CHALLENGER_CHESTPLATE", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_GOLD_BLOCK", 32]],
      MYTHOS_LEGGINGS: [["CHALLENGER_LEGGINGS", 1], ["MYTHOS_FRAGMENT", 4], ["GRIFFIN_FEATHER", 64]],
      MYTHOS_BOOTS: [["CHALLENGER_BOOTS", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32]],
      MYTHOS_NECKLACE: [["CHALLENGER_NECKLACE", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_GOLD_BLOCK", 16]],
      MYTHOS_CLOAK: [["CHALLENGER_CLOAK", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_GOLD_BLOCK", 16]],
      MYTHOS_BELT: [["CHALLENGER_BELT", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_GOLD_BLOCK", 16]],
      MYTHOS_BRACELET: [["CHALLENGER_BRACELET", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_GOLD_BLOCK", 16]],
      SWORD_OF_REVELATIONS: [["HILT_OF_REVELATIONS", 1], ["GRIFFIN_FEATHER", 12], ["ENCHANTED_ANCIENT_CLAW", 8], ["ENCHANTED_GOLD_BLOCK", 1]],
      DAEDALUS_AXE: [["SWORD_OF_REVELATIONS", 1], ["DAEDALUS_STICK", 2], ["ENCHANTED_GOLD_BLOCK", 48]],
      STARRED_DAEDALUS_AXE: [["DAEDALUS_AXE", 1], ["GOLDEN_FRAGMENT", 8]],
      ARCHAIC_SPADE: [["ANCESTRAL_SPADE", 1], ["HILT_OF_REVELATIONS", 1], ["ENCHANTED_ANCIENT_CLAW", 8], ["GRIFFIN_FEATHER", 32], ["ENCHANTED_GOLD_BLOCK", 2]],
      DEIFIC_SPADE: [["ARCHAIC_SPADE", 1], ["HILT_OF_REVELATIONS", 1], ["BRAIDED_GRIFFIN_FEATHER", 1], ["MYTHOS_FRAGMENT", 16], ["ENCHANTED_ANCIENT_CLAW", 128], ["ENCHANTED_GOLD_BLOCK", 128]],
      CROWN_OF_AVARICE: [["CROWN_OF_GREED", 1], ["AVARICIOUS_CHALICE", 2], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_GOLD_BLOCK", 24]],
      MANTICORE_CLAW: [["MANTI_CORE", 1], ["ENCHANTED_ANCIENT_CLAW", 320], ["ENCHANTED_GOLD_BLOCK", 64]],
      GOLDEN_FLEECE: [["SHIMMERING_WOOL", 1], ["BRAIDED_GRIFFIN_FEATHER", 1], ["ENCHANTED_GOLD_BLOCK", 256], ["ENCHANTED_WOOL", 128]],
      DAEDALUS_NOTES: [["DAEDALUS_STICK", 1], ["MYTHOS_FRAGMENT", 4], ["ENCHANTED_ANCIENT_CLAW", 32], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_PAPER", 128]],
      BRAIDED_GRIFFIN_FEATHER: [["GRIFFIN_FEATHER", 160], ["SOUL_STRING", 256]],
      ZOG_ANVIL: [["ANCIENT_CLAW", 96], ["GRIFFIN_FEATHER", 16]],
      HEPHAESTUS_ANVIL: [["ZOG_ANVIL", 1], ["BRAIDED_GRIFFIN_FEATHER", 2], ["MYTHOS_FRAGMENT", 32], ["ENCHANTED_ANCIENT_CLAW", 128], ["ENCHANTED_GOLD_BLOCK", 64]],
    };
    // Hephaestus upgrades: 3 copies of a mob-dropped pet item + a Hephaestus Anvil
    // (effects from the wiki's event pet item table)
    const HEPH_INFO = [
      { base: "MINOS_RELIC", up: "HEPHAESTUS_RELIC", from: "Minos Champion", now: "+33.3% all pet stats", then: "+50% all pet stats" },
      { base: "ANTIQUE_REMEDIES", up: "HEPHAESTUS_REMEDIES", from: "Harpy", now: "+80% pet base Strength", then: "+100% pet base Strength" },
      { base: "CROCHET_TIGER_PLUSHIE", up: "HEPHAESTUS_PLUSHIE", from: "Siamese Lynx", now: "+35 Bonus Attack Speed", then: "+50 Bonus Attack Speed" },
      { base: "DWARF_TURTLE_SHELMET", up: "HEPHAESTUS_SHELMET", from: "Gaia Construct", now: "+10 True Defense, no knockback", then: "+20 True Defense, no knockback" },
      { base: "CRETAN_URN", up: "HEPHAESTUS_URN", from: "Cretan Bull", now: "+5 Pet Luck", then: "+10 Pet Luck" },
      { base: "WASHED_UP_SOUVENIR", up: "HEPHAESTUS_SOUVENIR", from: "Stranded Nymph", now: "+5 Sea Creature Chance", then: "+10 Sea Creature Chance" },
    ];
    const HEPH = { ANTIQUE_REMEDIES: "HEPHAESTUS_REMEDIES", CRETAN_URN: "HEPHAESTUS_URN", CROCHET_TIGER_PLUSHIE: "HEPHAESTUS_PLUSHIE", DWARF_TURTLE_SHELMET: "HEPHAESTUS_SHELMET", MINOS_RELIC: "HEPHAESTUS_RELIC", WASHED_UP_SOUVENIR: "HEPHAESTUS_SOUVENIR" };
    for (const [base, up] of Object.entries(HEPH)) DR[up] = [[base, 3], ["HEPHAESTUS_ANVIL", 1]];
    // owning an upgrade counts as having obtained what it consumed
    const UPGRADED_BY = { ANCESTRAL_SPADE: ["ARCHAIC_SPADE", "DEIFIC_SPADE"], ARCHAIC_SPADE: ["DEIFIC_SPADE"], SWORD_OF_REVELATIONS: ["DAEDALUS_AXE", "STARRED_DAEDALUS_AXE"], DAEDALUS_AXE: ["STARRED_DAEDALUS_AXE"], CROWN_OF_GREED: ["CROWN_OF_AVARICE"] };
    for (const s of ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS", "NECKLACE", "CLOAK", "BELT", "BRACELET"]) UPGRADED_BY["CHALLENGER_" + s] = ["MYTHOS_" + s];
    for (const [base, up] of Object.entries(HEPH)) UPGRADED_BY[base] = [up];
    // rare drops count as obtained once they've been used in a craft
    Object.assign(UPGRADED_BY, {
      HILT_OF_REVELATIONS: ["SWORD_OF_REVELATIONS", "ARCHAIC_SPADE", "DEIFIC_SPADE"],
      DAEDALUS_STICK: ["DAEDALUS_AXE", "DAEDALUS_NOTES"], MANTI_CORE: ["MANTICORE_CLAW"], SHIMMERING_WOOL: ["GOLDEN_FLEECE"],
    });
    const got = (id) => has(id) || (UPGRADED_BY[id] || []).some(got);
    const piecesFor = (ids) => ids.map((id) => ({ name: nice(id), owned: got(id), mats: !got(id) && DR[id] ? evMats(DR[id]) : null }));
    // pieces share one material pool - count how many can be crafted in order
    // before something runs out, and name the material that runs out
    const affordable = (ids) => {
      const pool = {};
      let n = 0, limit = null;
      for (const id of ids.filter((x) => !got(x))) {
        const spec = DR[id] || [];
        for (const [m] of spec) if (!(m in pool)) pool[m] = evHave(m);
        const short = spec.find(([m, need]) => pool[m] < need);
        if (short) { limit = nice(short[0]); break; }
        for (const [m, need] of spec) pool[m] -= need;
        n++;
      }
      return { n, limit };
    };

    const armorSlots = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"], equipSlots = ["NECKLACE", "CLOAK", "BELT", "BRACELET"];
    const challengerIds = [...armorSlots, ...equipSlots].map((s) => "CHALLENGER_" + s);
    const mythosArmorIds = armorSlots.map((s) => "MYTHOS_" + s), mythosEquipIds = equipSlots.map((s) => "MYTHOS_" + s);
    const cnt = (ids) => ids.filter(got).length;
    const pieceStep = (text, ids) => {
      const st = step(text, cnt(ids) === ids.length, null, piecesFor(ids));
      if (st.pieces) st.canNow = affordable(ids);
      return st;
    };
    const heldBy = (id) => pets.filter((p) => p.heldItem === id).map((p) => `${tierName(p.tier)} ${nice(p.type)}`);
    const ownAnvil = has("HEPHAESTUS_ANVIL");
    const hephRows = HEPH_INFO.map((h) => {
      const held = heldBy(h.base);
      const copies = evHave(h.base) + held.length;
      const done = has(h.up);
      return {
        name: nice(h.up), base: nice(h.base), from: h.from, now: h.now, then: h.then, copies, held, done,
        status: done ? "made" : copies >= 3 ? (ownAnvil ? "ready to craft" : "enough copies - needs the anvil") : `need ${3 - copies} more (${h.from} drop)`,
      };
    });
    const hephDone = hephRows.filter((r) => r.done).length;
    const steps = [
      step("Buy a Griffin Pet (25k coins) and an Ancestral Spade (5k + 32 Gold Ingot) from Diana", !!griffin && (has("ANCESTRAL_SPADE") || has("ARCHAIC_SPADE") || has("DEIFIC_SPADE"))),
      step("Craft the Sword of Revelations - Hilt of Revelations drops from Minos Hunters", has("SWORD_OF_REVELATIONS") || has("DAEDALUS_AXE"),
        [["HILT_OF_REVELATIONS", 1], ["GRIFFIN_FEATHER", 12], ["ENCHANTED_ANCIENT_CLAW", 8], ["ENCHANTED_GOLD_BLOCK", 1]]),
      step("Craft the Archaic Spade - 6-burrow chains, and Mythos Fragments start dropping (6.76%)", has("ARCHAIC_SPADE") || has("DEIFIC_SPADE"),
        [["ANCESTRAL_SPADE", 1], ["HILT_OF_REVELATIONS", 1], ["ENCHANTED_ANCIENT_CLAW", 8], ["GRIFFIN_FEATHER", 32], ["ENCHANTED_GOLD_BLOCK", 2]]),
      pieceStep(`Challenger armor + equipment (${cnt(challengerIds)}/8) - claws, gold and feathers`, challengerIds),
      step("Griffin to Rare (Uncommon + Rare stones at Kat) - unlocks Harpy and Gaia Construct", gTier >= 2),
      step("Griffin to Epic (stone + 250k at Kat, 1 day) - unlocks Minotaur (Daedalus Stick) and Minos Champion (Minos Relic)", gTier >= 3,
        [["MYTHOS_FRAGMENT", 4], ["GRIFFIN_FEATHER", 64], ["ENCHANTED_ANCIENT_CLAW", 4], ["ENCHANTED_GOLD_BLOCK", 12]]),
      pieceStep(`Mythos armor (${cnt(mythosArmorIds)}/4) - each piece upgrades the matching Challenger piece`, mythosArmorIds),
      step("Griffin to Legendary (stone + 500k at Kat, 3 days) - unlocks Sphinx and Minos Inquisitor (Chimera)", gTier >= 4,
        [["MYTHOS_FRAGMENT", 16], ["BRAIDED_GRIFFIN_FEATHER", 1], ["ENCHANTED_ANCIENT_CLAW", 32], ["ENCHANTED_GOLD_BLOCK", 96]]),
      pieceStep(`Mythos equipment (${cnt(mythosEquipIds)}/4) - each piece upgrades the matching Challenger piece`, mythosEquipIds),
      step("Deific Spade - 8-burrow chains and a better Mythos Fragment rate (9.31%)", has("DEIFIC_SPADE"),
        [["ARCHAIC_SPADE", 1], ["HILT_OF_REVELATIONS", 1], ["BRAIDED_GRIFFIN_FEATHER", 1], ["MYTHOS_FRAGMENT", 16], ["ENCHANTED_ANCIENT_CLAW", 128], ["ENCHANTED_GOLD_BLOCK", 128]]),
      step("Zog Anvil - the base of the Hephaestus Anvil (it also upgrades Zog's pet items)", has("ZOG_ANVIL") || ownAnvil || hephDone > 0, DR.ZOG_ANVIL),
      step("Hephaestus Anvil - merges 3 copies of an event pet item into a stronger Hephaestus version", ownAnvil || hephDone > 0, DR.HEPHAESTUS_ANVIL),
      step(`Hephaestus pet items (${hephDone}/6) - see the upgrade table below`, hephDone === 6),
      step("Daedalus Blade - needs 2 Daedalus Sticks (rare Minotaur drop, Epic+ Griffin)", has("DAEDALUS_AXE"),
        [["DAEDALUS_STICK", 2], ["SWORD_OF_REVELATIONS", 1], ["ENCHANTED_GOLD_BLOCK", 48]]),
      step("Griffin to Mythic (stone + 1M at Kat) - unlocks Manticore and King Minos", gTier >= 5,
        [["MYTHOS_FRAGMENT", 48], ["BRAIDED_GRIFFIN_FEATHER", 2], ["ENCHANTED_ANCIENT_CLAW", 128], ["ENCHANTED_GOLD_BLOCK", 192]]),
    ];
    // Mythos Fragments are shared by several remaining steps - show the pool
    const fragOf = (mats) => mats?.find((m) => m.name === "Mythos Fragment")?.need || 0;
    const fragNeed = steps.filter((s) => s.done === false).reduce((a, s) => a + fragOf(s.mats) + (s.pieces || []).filter((p) => !p.owned).reduce((b, p) => b + fragOf(p.mats), 0), 0);

    // every item the event offers, grouped - verified against the wiki's event item tables
    const src = (id, how) => ({ id, how });
    const CATALOG = [
      ["Spades", [src("ANCESTRAL_SPADE", "Buy from Diana: 5k coins + 32 Gold Ingot"), src("ARCHAIC_SPADE", "Craft - 6-burrow chains, Mythos Fragments"), src("DEIFIC_SPADE", "Craft - 8-burrow chains, best Mythos rate")]],
      ["Weapons", [src("SWORD_OF_REVELATIONS", "Craft"), src("DAEDALUS_AXE", "Craft (Daedalus Blade)"), src("STARRED_DAEDALUS_AXE", "Fragged Daedalus Blade - craft")]],
      ["Armor", [...armorSlots.map((s) => src("CHALLENGER_" + s, "Craft")), ...armorSlots.map((s) => src("MYTHOS_" + s, "Craft - consumes the Challenger piece")), src("CROWN_OF_GREED", "Drop from King Minos (Mythic Griffin)"), src("CROWN_OF_AVARICE", "Craft")]],
      ["Equipment", [...equipSlots.map((s) => src("CHALLENGER_" + s, "Craft")), ...equipSlots.map((s) => src("MYTHOS_" + s, "Craft - consumes the Challenger piece")), src("MANTICORE_CLAW", "Craft - needs a Manti-core"), src("GOLDEN_FLEECE", "Craft - +15 Tracking on burrows")]],
      ["Pet items (mob drops)", [src("ANTIQUE_REMEDIES", "Drop from Harpy"), src("CRETAN_URN", "Drop from Cretan Bull"), src("CROCHET_TIGER_PLUSHIE", "Drop from Siamese Lynx"), src("DWARF_TURTLE_SHELMET", "Drop from Gaia Construct"), src("MINOS_RELIC", "Drop from Minos Champion"), src("WASHED_UP_SOUVENIR", "Drop from Stranded Nymph")]],
      ["Anvils", [src("ZOG_ANVIL", "Craft: 96 Ancient Claw + 16 Griffin Feather"), src("HEPHAESTUS_ANVIL", "Craft from a Zog Anvil (or a Raffle of the Century reward)")]],
      ["Hephaestus upgrades", HEPH_INFO.map((h) => src(h.up, `${h.then} (the base item gives ${h.now}) - 3 ${nice(h.base)} + a Hephaestus Anvil`))],
      ["Rare drops", [src("HILT_OF_REVELATIONS", "Minos Hunter"), src("DAEDALUS_STICK", "Minotaur (rare)"), src("BRAIN_FOOD", "Sphinx - +5 Tracking"), src("MANTI_CORE", "Manticore"), src("FATEFUL_STINGER", "Manticore"), src("SHIMMERING_WOOL", "King Minos")]],
      ["Extras", [src("DAEDALUS_NOTES", "Craft - Erudite reforge: +2 burrows per chain"), src("FOUR_EYED_FISH", "Griffin pet item: +13 MF, +55 def, +2k coins per burrow")]],
    ];
    const catalog = CATALOG.map(([group, list]) => ({
      group,
      items: list.map(({ id, how }) => {
        const owned = got(id);
        return { name: nice(id) === "Daedalus Axe" ? "Daedalus Blade" : nice(id) === "Starred Daedalus Axe" ? "Fragged Daedalus Blade" : nice(id), owned, how, mats: !owned && DR[id] ? evMats(DR[id]) : null };
      }),
    }));
    const catOwned = catalog.reduce((a, g) => a + g.items.filter((i) => i.owned).length, 0);
    const catTotal = catalog.reduce((a, g) => a + g.items.length, 0);
    const tips = [
      "Every Griffin stone is crafted from a Base Griffin Upgrade Stone (16 Ench Gold + 8 Ench Cobblestone + 8 Griffin Feather).",
      `Braided Griffin Feather = 160 Griffin Feather + 256 Soul String (you: ${fmt(evHave("GRIFFIN_FEATHER"))} feathers, ${fmt(evHave("SOUL_STRING"))} string).`,
      `Enchanted Ancient Claw = 160 Ancient Claw - your ${fmt(evSacks.ANCIENT_CLAW)} raw claws make ${Math.floor((evSacks.ANCIENT_CLAW ?? 0) / 160)} more.`,
    ];
    if (fragNeed > 0) tips.push(`Mythos Fragments are shared: your remaining steps need ${fmt(fragNeed)}, you have ${fmt(evHave("MYTHOS_FRAGMENT"))}. The Deific Spade raises the drop rate, so it pays for itself.`);
    tips.push("Hephaestus Anvil: neither the wiki nor the item text says whether a craft uses it up. Check the recipe in-game before planning several upgrades - if it is used up, spend it on the Hephaestus Relic first (the biggest effect).");
    const live = perkActive("Mythological Ritual");
    events.push({
      key: "diana", name: "Mythological Ritual (Diana)",
      status: live ? { active: true, text: `ACTIVE NOW - ${mayor?.name === "Diana" ? "Diana is mayor" : "Mythological Ritual perk is live"}. Dig burrows in the Hub.` }
                   : { active: false, text: "Only while Diana is mayor (or her Mythological Ritual perk is live)." },
      stats: [
        ["Griffin", griffin ? `${tierName(griffin.tier)} lvl ${griffin.level}` : "none"],
        ["Burrows dug", fmt(my.burrowsDugNext?.total)],
        ["Chains completed", fmt(my.burrowsChainsComplete?.total)],
        ["Event items", `${catOwned}/${catTotal}`],
      ],
      kills,
      steps, tips,
      catalog, catalogOwned: catOwned, catalogTotal: catTotal,
      hephaestus: { rows: hephRows, anvil: ownAnvil },
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Mythological_Ritual",
    });
  }

  // ---- Jacob's Farming Contests ----
  {
    const j = member.jacob || {};
    const earned = j.earnedMedals || {}, perks = j.perks || {}, med = j.medals || {};
    const dayIdx = Math.floor((Date.now() - SB_EPOCH) / SB_DAY);
    // contests run every 3rd SkyBlock day, starting on Early Spring 2
    const live = (dayIdx - 1) % 3 === 0;
    const nextIn = (() => { let d = dayIdx + 1; while ((d - 1) % 3 !== 0) d++; return d * SB_DAY + SB_EPOCH - Date.now(); })();
    const ff = perks.doubleDrops ?? 0;
    events.push({
      key: "jacob", name: "Jacob's Farming Contests",
      status: live ? { active: true, text: "A contest is running now (20 real minutes)." } : { active: false, text: `Next contest in ${fmtDuration(nextIn)} - every hour, year-round.` },
      stats: [
        ["Contests entered", fmt(j.participations)],
        ["Diamond medals", earned.diamond ?? 0],
        ["Unspent medals", `${med.bronze ?? 0}🥉 ${med.silver ?? 0}🥈 ${med.gold ?? 0}🥇`],
      ],
      steps: [
        step("Reach Farming X and talk to Jacob once", (j.participations ?? 0) > 0),
        step("Collect 100+ of a contest crop to place; higher brackets pay more medals", (earned.gold ?? 0) > 0),
        step(`Anita: Extra Farming Fortune ${ff}/15 (+4 Farming Fortune per tier, gold medals + Jacob's Tickets)`, ff >= 15),
        step("Anita: Personal Bests perk", perks.personalBests === true),
        step(`Anita: Farming level cap +${perks.levelCap ?? 0}/10`, (perks.levelCap ?? 0) >= 10),
        step(`Earn Diamond medals (${earned.diamond ?? 0} so far) - top brackets per crop`, (earned.diamond ?? 0) > 0),
      ],
      tips: ["Anita is in the Farmhouse and in your Garden."],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Jacob%27s_Farming_Contest",
    });
  }

  // ---- Hoppity's Hunt (Chocolate Factory) ----
  if (member.chocolateFactory && (member.chocolateFactory.totalChocolate ?? 0) > 0) {
    const c = member.chocolateFactory;
    const u = c.uniqueRabbits || {};
    const w = sbWindow(0, 1, 93); // Early Spring 1 through Late Spring
    events.push({
      key: "hoppity", name: "Hoppity's Hunt (Chocolate Factory)",
      status: w.active ? { active: true, text: `ACTIVE NOW - ends in ${fmtDuration(w.ms)}. Hunt eggs every spawn.` } : { active: false, text: `Starts in ${fmtDuration(w.ms)} (Early Spring 1). The factory produces year-round.` },
      stats: [
        ["Prestige", c.prestige ?? 0],
        ["Unique rabbits", Object.values(u).reduce((a, b) => a + (b || 0), 0)],
        ["Mythic / Divine", `${u.mythic ?? 0} / ${u.divine ?? 0}`],
      ],
      steps: [
        step(`Prestige the Chocolate Factory (prestige ${c.prestige ?? 0}) - higher prestige widens Hoppity's rabbit stock`, (c.prestige ?? 0) >= 1),
        step("During the hunt, claim every Chocolate Egg (announced in chat; an Egglocator points to them)", null),
        step("Buy rabbits when Hoppity visits (250k-5m chocolate by rarity)", null),
        step(`Collect Mythic rabbits (${u.mythic ?? 0})`, (u.mythic ?? 0) > 0),
        step("Unlock Zorro", !!c.unlockedZorro),
        step("Find a Divine rabbit", (u.divine ?? 0) > 0),
      ],
      tips: [],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Hoppity%27s_Hunt",
    });
  }

  // ---- Spooky Festival ----
  {
    const w = sbWindow(7, 29, 3); // Autumn 29-31
    const fish = sbWindow(7, 26, 9); // spooky fishing: Autumn 26, 9 days
    const set4 = (p) => ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].every((s) => has(p + s));
    const intim = has("INTIMIDATION_ARTIFACT") || has("INTIMIDATION_RELIC");
    events.push({
      key: "spooky", name: "Spooky Festival",
      status: w.active ? { active: true, text: `ACTIVE NOW - ends in ${fmtDuration(w.ms)}. Every mob kill can drop candy.` }
            : fish.active ? { active: true, text: `Spooky fishing is live (festival starts in ${fmtDuration(w.ms)}).` }
            : { active: false, text: `Starts in ${fmtDuration(w.ms)} (Autumn 29-31; spooky fishing from Autumn 26).` },
      stats: [["Bats spawned", playerStats.spooky?.bats_spawned?.total ?? 0], ["Purple Candy", fmt(evHave("PURPLE_CANDY"))], ["Green Candy", fmt(evHave("GREEN_CANDY"))]],
      steps: [
        step("Wear full Spooky or Bat Person armor - +20% Green Candy chance", set4("SPOOKY_") || set4("BAT_PERSON_")),
        step("Kill mobs during the festival - 10% Green Candy base; Purple Candy is rarer", null),
        step("Fear Mongerer: Intimidation Artifact (your ring + 100 Purple Candy)", intim, has("INTIMIDATION_RING") ? [["PURPLE_CANDY", 100], ["INTIMIDATION_RING", 1]] : null),
        step("Fear Mongerer: Bat Artifact", has("BAT_ARTIFACT")),
        step("Fear Mongerer: Candy chain up to the Candy Relic (Artifact + 1,024 Purple Candy)", has("CANDY_RELIC")),
        step("Bat Person chain (Spooky Shards + Ectoplasm)", has("BAT_PERSON_ARTIFACT")),
      ],
      tips: ["The Fear Mongerer only sells during the festival - bank Purple Candy ahead of time."],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Spooky_Festival",
    });
  }

  // ---- Season of Jerry ----
  {
    const w = sbWindow(11, 1, 31); // workshop open all of Late Winter
    const defend = sbWindow(11, 24, 1);
    const yeti = petByType["BABY_YETI"] || null;
    events.push({
      key: "jerry", name: "Season of Jerry",
      status: defend.active ? { active: true, text: "DEFEND JERRY'S WORKSHOP IS LIVE - snowballs for the Magma Cubes." }
            : w.active ? { active: true, text: `Jerry's Workshop is open - the defense starts in ${fmtDuration(defend.ms)} (Late Winter 24).` }
            : { active: false, text: `Workshop opens in ${fmtDuration(w.ms)} (Late Winter). Defense on Late Winter 24.` },
      stats: [["Gifts given", fmt(playerStats.gifts?.given)], ["Gifts received", fmt(playerStats.gifts?.received)]],
      steps: [
        step("Open Jerry's Workshop during Late Winter (/savethejerrys, or Jerry on your island)", null),
        step("Defend Jerry's Workshop on Late Winter 24 - 5 rounds; only snowballs hurt Magma Cubes; presents scale with damage", null),
        step("Golden Jerry Talisman - needs 5 Purple Jerry Talismans", has("JERRY_TALISMAN_GOLDEN"), [["JERRY_TALISMAN_PURPLE", 5]]),
        step(`Baby Yeti pet${yeti ? ` (yours: ${tierName(yeti.tier)} lvl ${yeti.level})` : ""}`, !!yeti),
      ],
      tips: [],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Season_of_Jerry",
    });
  }

  // ---- Fishing Festival (Marina) ----
  {
    const live = perkActive("Fishing Festival") && now.day <= 3;
    const perk = perkActive("Fishing Festival");
    const sharkPieces = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].filter((s) => has("SHARK_SCALE_" + s)).length;
    events.push({
      key: "fishingfest", name: "Fishing Festival (Marina)",
      status: live ? { active: true, text: "ACTIVE NOW - sharks are biting (days 1-3 of the month)." }
            : perk ? { active: false, text: `Marina's perk is on - next festival on day 1 of ${SB_MONTHS[(now.month + 1) % 12]}.` }
            : { active: false, text: "Only while Marina is mayor (or her Fishing Festival perk is live)." },
      stats: [["Enchanted Shark Fin", fmt(evHave("ENCHANTED_SHARK_FIN"))]],
      steps: [
        step("Fish any water on days 1-3 of each month for Sharks (fins + teeth)", null),
        step("Rod of the Sea", has("ROD_OF_THE_SEA") || has("HELLFIRE_ROD"), [["ENCHANTED_SHARK_FIN", 4], ["GREAT_WHITE_SHARK_TOOTH", 4], ["LEGEND_ROD", 1]]),
        step(`Shark Scale armor (${sharkPieces}/4)`, sharkPieces === 4),
      ],
      tips: [],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Fishing_Festival",
    });
  }

  // ---- Mining Fiesta (Cole) ----
  {
    const perk = perkActive("Mining Fiesta");
    const coleSeated = mayor?.name === "Cole" || mayor?.minister?.name === "Cole";
    const glossy = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].filter((s) => has("GLOSSY_MINERAL_" + s)).length;
    events.push({
      key: "fiesta", name: "Mining Fiesta (Cole)",
      status: perk ? { active: true, text: "Cole's Mining Fiesta perk is live - fiestas are scheduled this term (7 days each)." }
            : { active: false, text: coleSeated ? "Cole is seated but without the Mining Fiesta perk - no fiestas this term." : "Only while Cole's Mining Fiesta perk is live." },
      stats: [["Glossy Gemstone", fmt(evHave("GLOSSY_GEMSTONE"))], ["Refined Mineral", fmt(evHave("REFINED_MINERAL"))]],
      steps: [
        step("Mine on public islands during a Fiesta for Refined Minerals and Glossy Gemstones", null),
        step("Glossy Mineral Talisman (16 Glossy Gemstones)", has("GLOSSY_MINERAL_TALISMAN"), [["GLOSSY_GEMSTONE", 16], ["MINERAL_TALISMAN", 1]]),
        step(`Glossy Mineral armor (${glossy}/4) - 16 Glossy Gemstones per piece`, glossy === 4),
      ],
      tips: [],
      wiki: "https://hypixelskyblock.minecraft.wiki/w/Mining_Fiesta",
    });
  }

  // mark "you are here" (first undone trackable step) and sort live events first
  for (const ev of events) {
    const idx = ev.steps.findIndex((s) => s.done === false);
    if (idx >= 0) ev.steps[idx].current = true;
    ev.stepsDone = ev.steps.filter((s) => s.done === true).length;
    ev.stepsTrackable = ev.steps.filter((s) => s.done !== null).length;
  }
  events.sort((a, b) => (b.status.active ? 1 : 0) - (a.status.active ? 1 : 0));

  // live events are time-limited: their next step goes to the top of the to-do list
  for (const ev of events) {
    const cur = ev.steps.find((s) => s.current);
    if (!cur) continue;
    if (ev.status.active) rec(1, "Events", `${ev.name.split(" (")[0]} is live: ${cur.text.split(" - ")[0]}`, ev.status.text, "The full path is in the Events section.");
    else if (ev.key === "jacob") rec(2, "Events", `Jacob: ${cur.text.split(" - ")[0]}`, cur.text, "The full path is in the Events section.");
  }

  // =================================================================
  // SLAYER LOADOUTS - the best kit you actually OWN for each slayer,
  // tuned to your current level. Museum-donated gear doesn't count.
  // =================================================================

  const slayerLvl = (b) => slayerBosses[b]?.level ?? 0;
  const sacks = member.sacks || {};
  const sackOf = (id) => sacks[id] ?? 0;
  const n = (x) => Math.round(x).toLocaleString("en-US");
  const countItems = (id) => allItems.filter((i) => i.id === id && i.container !== "museum").length;
  const matHave = (id) => sackOf(id) + countItems(id);
  // full item objects (with lore) for tooltip display; museum copies excluded
  const fullItemById = {};
  for (const [cname, inv] of Object.entries(invs)) {
    if (cname === "museum") continue;
    for (const it of itemsOf(inv)) if (!fullItemById[it.skyblockId]) fullItemById[it.skyblockId] = it;
  }
  const bestOwnedSet = (sets) => {
    for (const s of sets) {
      const slots = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].filter((sl) => usableIds.has(s.id + "_" + sl));
      if (slots.length >= 3) return { name: s.name || nice(s.id), pieces: slots.length, why: s.why || null, pieceIds: slots.map((sl) => s.id + "_" + sl) };
    }
    return null;
  };
  const bestOwnedId = (ids) => ids.find((id) => usableIds.has(id)) || null;
  // pets: ranked {type, why} lists per slayer (abilities verified via NEU lore).
  // Returns the best owned pet with its reason, an owned alternative, and the
  // unowned upgrade goal if something better exists.
  const PET_OBTAIN = { ENDER_DRAGON: "egg from End dragon fights" };
  // entries may carry `matchup`: a claim that this pet genuinely BEATS the
  // generic pick for this fight - but only once Legendary and well-leveled.
  // Qualified matchup pets are promoted to the top pick; unqualified ones get
  // an honest "would be #1 at Legendary lvl 80+" note instead.
  const petQualified = (p) => ["LEGENDARY", "MYTHIC"].includes(p.tier) && p.level >= 80;
  const pickPets = (ranked) => {
    let owned = ranked.filter((p) => petByType[p.type]);
    const promoted = owned.filter((e) => e.matchup && petQualified(petByType[e.type]));
    if (promoted.length) {
      const rest = owned.filter((e) => !promoted.includes(e));
      // an owned Ender Dragon still outranks matchup promotions (Superior beats niches)
      const edrag = rest.filter((e) => e.type === "ENDER_DRAGON");
      owned = [...edrag, ...promoted, ...rest.filter((e) => e.type !== "ENDER_DRAGON")];
    }
    const deco = (e, extraWhy) => ({ name: nice(e.type), tier: petByType[e.type].tier, level: petByType[e.type].level, why: extraWhy || e.why });
    const pick = owned[0] ? deco(owned[0], owned[0].matchup && petQualified(petByType[owned[0].type]) ? owned[0].matchup : null) : null;
    let alt = owned[1] ? deco(owned[1]) : null;
    if (alt && owned[1].matchup && !petQualified(petByType[owned[1].type])) {
      alt.condition = `Beats the ${pick.name} at Legendary 80+: ${owned[1].matchup}`;
    }
    const conditionals = owned.slice(2)
      .filter((e) => e.matchup && !petQualified(petByType[e.type]))
      .map((e) => ({ name: nice(e.type), tier: petByType[e.type].tier, level: petByType[e.type].level, text: e.matchup }));
    const goalEntry = pick ? ranked.slice(0, ranked.findIndex((p) => p.type === owned[0].type)).find((p) => !petByType[p.type]) : ranked[0];
    const goal = goalEntry ? { name: nice(goalEntry.type), why: goalEntry.why, obtain: PET_OBTAIN[goalEntry.type] || null } : null;
    return { pick, alt, goal, conditionals };
  };
  const EQUIP_SLOTS = { // per-slot candidates, best first (generic combat)
    Necklace: ["VANQUISHED_MAGMA_NECKLACE", "ENDER_NECKLACE", "THUNDERBOLT_NECKLACE"],
    Cloak: ["VANQUISHED_GHAST_CLOAK", "ENDER_CLOAK", "DAVIDS_CLOAK"],
    Belt: ["IMPLOSION_BELT", "ENDER_BELT", "ADAPTIVE_BELT"],
    Gloves: ["VANQUISHED_GLOWSTONE_GAUNTLET", "ENDER_GAUNTLET", "DWARVEN_HANDWARMERS"],
  };

  const SLAYER_KITS = [
    {
      boss: "zombie", label: "Revenant Horror (Zombie)", maxTier: 5,
      weapons: ["AXE_OF_THE_SHREDDED", "REAPER_SWORD", "REVENANT_SWORD", "ZOMBIE_KNIGHT_SWORD", "UNDEAD_SWORD"],
      weaponHint: "Craft the Revenant Falchion (unlocked at Zombie 3) - it does bonus damage to zombies; the Reaper Falchion at Zombie 6 upgrades it directly.",
      sets: [{ id: "REAPER", why: "healing-focused, made for this fight" }, { id: "REVENANT" }, { id: "SHADOW_ASSASSIN", why: "strong all-rounder" }, { id: "SUPERIOR_DRAGON" }, { id: "ADAPTIVE" }, { id: "HEAVY", why: "raw defense" }],
      pets: [
        { type: "ENDER_DRAGON", why: "Superior: boosts ALL combat stats" },
        { type: "TIGER", why: "Apex Predator: bonus damage vs lone targets" },
        { type: "WITHER_SKELETON", why: "Strength/Crit + wither DoT" },
        { type: "WOLF", why: "Crit Damage + Combat Wisdom" },
      ],
      note: "Revenants hit hard in melee - sustain or raw HP wins.",
      recipes: [ // unlock levels from the wiki tables, cross-checked with NEU
        { id: "ZOMBIE_RING", req: 2, prio: 3, why: "starter accessory" },
        { id: "REVENANT_SWORD", name: "Revenant Falchion", req: 3, prio: 1, why: "first zombie weapon - biggest early jump" },
        { ids: ["REVENANT_LEGGINGS", "REVENANT_BOOTS"], name: "Revenant Leggings + Boots", wiki: "Revenant Armor", req: 4, prio: 2, why: "tanky set starts" },
        { id: "REVENANT_CHESTPLATE", wiki: "Revenant Armor", req: 5, prio: 2, why: "completes the Revenant set" },
        { id: "DEVOUR_RING", req: 5, prio: 3, why: "cheap combat accessory" },
        { id: "REAPER_SWORD", name: "Reaper Falchion", req: 6, prio: 1, why: "weapon upgrade (consumes the Revenant) - before anything else at 6" },
        { id: "ZOMBIE_ARTIFACT", req: 7, prio: 2, why: "accessory upgrade" },
        { id: "REAPER_MASK", req: 7, prio: 2, why: "strong ability helmet" },
        { id: "REAPER_CHESTPLATE", wiki: "Reaper Armor", req: 7, prio: 3, why: "healing set - situational" },
        { id: "WARDEN_HELMET", req: 8, prio: 2, why: "huge-HP helmet" },
        { id: "REAPER_ORB", req: 8, prio: 3, why: "deployable healing orb" },
        { id: "AXE_OF_THE_SHREDDED", req: 8, prio: 1, why: "endgame cleave weapon - the level-8 prize" },
      ],
    },
    {
      boss: "spider", label: "Tarantula Broodfather (Spider)", maxTier: 4,
      weapons: ["SCORPION_FOIL", "RECLUSE_FANG", "SPIDER_SWORD"],
      weaponHint: "Use your strongest melee; the Scorpion Foil unlocks at Spider 6.",
      sets: [{ id: "TARANTULA", why: "made for this fight" }, { id: "SHADOW_ASSASSIN" }, { id: "SUPERIOR_DRAGON" }, { id: "ADAPTIVE" }, { id: "END", name: "Ender Armor", why: "cheap and solid" }],
      pets: [
        { type: "ENDER_DRAGON", why: "Superior: boosts ALL combat stats" },
        { type: "TIGER", why: "Apex Predator: bonus damage vs lone targets" },
        { type: "TARANTULA", why: "resists boss anti-heal + spider XP", matchup: "anti-heal resist beats a generic pet here (upgrade at Kat)" },
        { type: "WOLF", why: "Crit Damage + Combat Wisdom" },
      ],
      note: "Watch the boss's Voodoo Doll phase - break it fast or heal through it.",
      recipes: [
        { id: "SPIDER_RING", req: 1, prio: 3, why: "starter accessory" },
        { id: "RECLUSE_FANG", req: 3, prio: 2, why: "early spider weapon" },
        { ids: ["TARANTULA_HELMET", "TARANTULA_CHESTPLATE", "TARANTULA_LEGGINGS", "TARANTULA_BOOTS"], name: "Tarantula set", wiki: "Tarantula Armor", req: 5, prio: 2, why: "the spider armor set (pieces at 4-5)" },
        { id: "SCORPION_FOIL", req: 6, prio: 1, why: "the spider weapon - first pick at 6" },
        { id: "SPIDER_ARTIFACT", req: 6, prio: 2, why: "accessory upgrade" },
        { id: "TARANTULA_TALISMAN", req: 6, prio: 2, why: "boss drop, not a craft" },
        { id: "TARANTULA_RING", req: 7, prio: 3, why: "upgrades the talisman" },
        { id: "STING", req: 8, prio: 1, why: "endgame sword" },
      ],
    },
    {
      boss: "wolf", label: "Sven Packmaster (Wolf)", maxTier: 4,
      weapons: ["POOCH_SWORD", "SHAMAN_SWORD", "HYPER_CLEAVER"],
      weaponHint: "The Pooch Sword (Sven drop) is the wolf specialist - +1 damage per 50 max Health.",
      sets: [{ id: "MASTIFF", why: "+500 HP per piece; Sven deals true damage, so raw HP beats defense" }, { id: "SHADOW_ASSASSIN" }, { id: "SUPERIOR_DRAGON" }, { id: "HEAVY" }],
      pets: [
        { type: "ENDER_DRAGON", why: "Superior: boosts ALL combat stats" },
        { type: "TIGER", why: "Apex Predator: bonus damage vs lone targets" },
        { type: "WOLF", why: "Alpha Dog: less damage from wolves - swap if dying" },
        { type: "HOUND", why: "attack speed + bonus wolf Combat XP", matchup: "faster slayer XP/hour than a generic damage pet" },
      ],
      note: "Mastiff + Pooch Sword scale together: the HP stack feeds the sword's damage.",
      recipes: [
        { id: "RED_CLAW_TALISMAN", req: 1, prio: 3, why: "starter accessory" },
        { id: "RADIANT_POWER_ORB", req: 2, prio: 2, why: "starter healing orb" },
        { id: "GOLDEN_TOOTH", req: 2, prio: 1, why: "craft from Wolf Teeth + Ench Gold - funds every upgrade below" },
        { id: "MADDOX_BATPHONE", req: 3, prio: 2, why: "call Maddox from anywhere" },
        { ids: ["MASTIFF_HELMET", "MASTIFF_CHESTPLATE", "MASTIFF_LEGGINGS", "MASTIFF_BOOTS"], name: "Mastiff set", wiki: "Mastiff Armor", req: 4, prio: 1, why: "the Sven tank armor - makes every later tier safer" },
        { id: "RED_CLAW_RING", req: 5, prio: 2, why: "accessory chain" },
        { id: "RED_CLAW_ARTIFACT", req: 5, prio: 2, why: "accessory upgrade" },
        { id: "MANA_FLUX_POWER_ORB", req: 6, prio: 1, why: "big orb upgrade - helps every fight in the game" },
        { id: "HUNTER_TALISMAN", req: 7, prio: 3, why: "combat accessory" },
        { id: "OVERFLUX_CAPACITOR", req: 7, prio: 2, why: "orb component (uses Eman soulflow)" },
        { id: "OVERFLUX_POWER_ORB", req: 7, prio: 1, why: "endgame orb (consumes Mana Flux)" },
        { id: "PLASMAFLUX_POWER_ORB", req: 8, prio: 2, why: "best orb in the game - long-term" },
      ],
    },
    {
      boss: "enderman", label: "Voidgloom Seraph (Enderman)", maxTier: 4,
      weapons: ["ATOMSPLIT_KATANA", "VORPAL_KATANA", "VOIDEDGE_KATANA", "VOIDWALKER_KATANA"],
      weaponHint: "Katanas do bonus damage to Endermen - always run the highest you own. Chain: Voidwalker (Eman 1) → Voidedge (3) → Vorpal (5) → Atomsplit (6).",
      sets: [{ id: "FINAL_DESTINATION", why: "built for enderman grinding" }, { id: "SHADOW_ASSASSIN" }, { id: "END", name: "Ender Armor", why: "ALL stats x2 while on the End Island - beats fancier sets there" }, { id: "SUPERIOR_DRAGON" }, { id: "ADAPTIVE" }],
      pets: [
        { type: "ENDER_DRAGON", why: "End Strike: bonus damage to Ender mobs - THE Voidgloom pet" },
        { type: "TIGER", why: "Apex Predator: bonus damage vs lone targets" },
        { type: "ENDERMAN", why: "less damage from Ender mobs + buffs AOTE warp - defensive swap" },
      ],
      equipOverride: { Cloak: ["ENDER_CLOAK", "VANQUISHED_GHAST_CLOAK"], Belt: ["ENDER_BELT", "IMPLOSION_BELT"], Necklace: ["ENDER_NECKLACE", "VANQUISHED_MAGMA_NECKLACE"], Gloves: ["ENDER_GAUNTLET", "VANQUISHED_GLOWSTONE_GAUNTLET"] },
      note: "Ender armor AND equipment get 2x stats in the End. Break the Seraph's beacons instantly.",
      recipes: [
        { id: "VOIDWALKER_KATANA", req: 1, prio: 1, why: "tier-1 katana" },
        { id: "SOULFLOW_PILE", req: 2, prio: 3, why: "starts the soulflow economy" },
        { id: "LESSER_SOULFLOW_ENGINE", req: 2, prio: 1, inMinion: true, why: "minion upgrade: generates Soulflow (halves that minion's output)" },
        { id: "VOIDEDGE_KATANA", req: 3, prio: 1, why: "tier-2 katana" },
        { ids: ["FINAL_DESTINATION_HELMET", "FINAL_DESTINATION_CHESTPLATE", "FINAL_DESTINATION_LEGGINGS", "FINAL_DESTINATION_BOOTS"], name: "Final Destination set", wiki: "Final Destination Armor", req: 4, prio: 2, why: "stats grow per Enderman kill - the XP-grind set" },
        { id: "SOULFLOW_BATTERY", req: 5, prio: 3, why: "soulflow accessory tier 2" },
        { id: "SOULFLOW_ENGINE", req: 5, prio: 2, inMinion: true, why: "upgraded engine (best on a Voidling minion: +3% output per level)" },
        { id: "VORPAL_KATANA", req: 5, prio: 1, why: "tier-3 katana - first pick at 5, speeds every kill after" },
        { id: "JUJU_SHORTBOW", req: 5, prio: 1, why: "THE Ironman dungeon bow - right after the Vorpal" },
        { id: "ASPECT_OF_THE_VOID", req: 6, prio: 2, why: "permanent utility teleport" },
        { id: "ATOMSPLIT_KATANA", req: 6, prio: 1, why: "tier-4 katana" },
        { id: "SOULFLOW_SUPERCELL", req: 7, prio: 2, why: "accessory tier 3 + Overflux part" },
        { id: "ETHERWARP_CONDUIT", req: 7, prio: 1, why: "teleport-where-you-look AOTV upgrade" },
        { id: "TERMINATOR", req: 7, prio: 1, why: "endgame bow" },
      ],
    },
    {
      boss: "blaze", label: "Inferno Demonlord (Blaze)", maxTier: 4,
      weapons: ["BLADE_OF_THE_VOLCANO", "SOUL_WHIP"],
      weaponHint: "Any strong melee handles T1-T2; real blaze gear comes from the Crimson Isle.",
      sets: [{ id: "CRIMSON" }, { id: "TERROR" }, { id: "AURORA" }, { id: "FERVOR" }, { id: "FROZEN_BLAZE" }, { id: "SHADOW_ASSASSIN" }, { id: "ADAPTIVE" }],
      pets: [
        { type: "BLAZE", why: "Nether Embodiment: stat boost on the Crimson Isle (this fight's arena)" },
        { type: "ENDER_DRAGON", why: "Superior: boosts ALL combat stats" },
        { type: "TIGER", why: "Apex Predator: bonus damage vs lone targets" },
      ],
      note: "From T2 the boss uses elemental attunements (its nametag shows which damage type it takes) - stay mobile and re-read the nametag after each phase.",
      recipes: [
        { id: "FIREDUST_DAGGER", req: 2, prio: 1, why: "starter daggers (w/ Twilight) - the fight requires attunement daggers" },
        { id: "MANA_DISINTEGRATOR", req: 2, prio: 3, why: "utility craft" },
        { id: "BURSTSTOPPER_TALISMAN", req: 3, prio: 2, why: "anti-burst survivability accessory" },
        { id: "KINDLEBANE_DAGGER", req: 4, prio: 1, why: "tier-2 daggers (w/ Mawdredge)" },
        { id: "DESTRUCTION_CLOAK", req: 5, prio: 3, why: "combat cloak" },
        { id: "PYROCHAOS_DAGGER", req: 6, prio: 1, why: "tier-3 daggers (w/ Deathripper)" },
        { id: "BURSTSTOPPER_ARTIFACT", req: 7, prio: 2, why: "talisman upgrade" },
        { id: "ANNIHILATION_CLOAK", req: 7, prio: 2, why: "endgame cloak" },
      ],
    },
  ];

  // recipe materials, aggregated from the NEU repo (checked 2026-07-09)
  const RECIPE_MATS = {
    ZOMBIE_RING: [["REVENANT_FLESH", 64], ["ZOMBIE_TALISMAN", 1]],
    REVENANT_CHESTPLATE: [["ENCHANTED_DIAMOND", 128], ["REVENANT_VISCERA", 4]],
    ZOMBIE_ARTIFACT: [["REVENANT_VISCERA", 48], ["ENCHANTED_IRON", 32], ["ENCHANTED_DIAMOND", 16], ["ZOMBIE_RING", 1]],
    REAPER_MASK: [["REVENANT_VISCERA", 128], ["BEHEADED_HORROR", 1], ["ENCHANTED_STRING", 32], ["REVIVED_HEART", 1]],
    WARDEN_HELMET: [["REVIVED_HEART", 2], ["WARDEN_HEART", 1], ["ENCHANTED_IRON_BLOCK", 128]],
    AXE_OF_THE_SHREDDED: [["REVENANT_VISCERA", 256], ["SHARD_OF_THE_SHREDDED", 4], ["REAPER_SWORD", 1]],
    SPIDER_RING: [["TARANTULA_WEB", 64], ["SPIDER_TALISMAN", 1]],
    TARANTULA_HELMET: [["TARANTULA_SILK", 3], ["ENCHANTED_IRON", 128]],
    SCORPION_FOIL: [["TARANTULA_SILK", 32], ["TARANTULA_CATALYST", 8], ["TARANTULA_FANG", 1]],
    SPIDER_ARTIFACT: [["TARANTULA_SILK", 32], ["ENCHANTED_EMERALD", 32], ["SPIDER_RING", 1]],
    RED_CLAW_ARTIFACT: [["ENCHANTED_LEATHER", 256], ["GOLDEN_TOOTH", 54], ["RED_CLAW_RING", 1], ["RED_CLAW_EGG", 1]],
    MANA_FLUX_POWER_ORB: [["ENCHANTED_LAPIS_LAZULI_BLOCK", 4], ["GOLDEN_TOOTH", 32], ["RADIANT_POWER_ORB", 1]],
    SOULFLOW_PILE: [["NULL_SPHERE", 90]],
    VORPAL_KATANA: [["NULL_EDGE", 1], ["NULL_OVOID", 8], ["REFINED_MITHRIL", 8], ["VOIDEDGE_KATANA", 1]],
    JUJU_SHORTBOW: [["ENCHANTED_EYE_OF_ENDER", 32], ["ENCHANTED_STRING", 192], ["NULL_OVOID", 32], ["ENCHANTED_QUARTZ_BLOCK", 32]],
    ASPECT_OF_THE_VOID: [["NULL_OVOID", 32], ["ASPECT_OF_THE_END", 1]],
    ATOMSPLIT_KATANA: [["NULL_BLADE", 2], ["VORPAL_KATANA", 1]],
    TERMINATOR: [["TESSELLATED_ENDER_PEARL", 8], ["NULL_BLADE", 3], ["TARANTULA_SILK", 128], ["JUDGEMENT_CORE", 1], ["BRAIDED_GRIFFIN_FEATHER", 4]],
    REVENANT_SWORD: [["CRYSTALLIZED_HEART", 1], ["UNDEAD_CATALYST", 1], ["UNDEAD_SWORD", 1]],
    REAPER_SWORD: [["REVIVED_HEART", 1], ["REVENANT_CATALYST", 1], ["REVENANT_SWORD", 1]],
    DEVOUR_RING: [["ENCHANTED_RAW_CHICKEN", 2], ["ENCHANTED_RAW_SALMON", 8], ["REVENANT_VISCERA", 39]],
    GOLDEN_TOOTH: [["WOLF_TOOTH", 128], ["ENCHANTED_GOLD", 32]],
    HUNTER_TALISMAN: [["GOLDEN_TOOTH", 64], ["ENCHANTED_ROTTEN_FLESH", 32]],
    OVERFLUX_POWER_ORB: [["GOLDEN_TOOTH", 128], ["OVERFLUX_CAPACITOR", 1], ["ENCHANTED_REDSTONE_BLOCK", 24], ["MANA_FLUX_POWER_ORB", 1]],
    PLASMAFLUX_POWER_ORB: [["ENCHANTED_OBSIDIAN", 256], ["PLASMA_NUCLEUS", 1], ["GOLDEN_TOOTH", 72], ["OVERFLUX_POWER_ORB", 1]],
    FINAL_DESTINATION_HELMET: [["NULL_OVOID", 3], ["ENCHANTED_REDSTONE", 128]],
    FINAL_DESTINATION_CHESTPLATE: [["NULL_OVOID", 4], ["ENCHANTED_REDSTONE", 256]],
    FINAL_DESTINATION_LEGGINGS: [["NULL_OVOID", 3], ["ENCHANTED_REDSTONE", 256]],
    FINAL_DESTINATION_BOOTS: [["NULL_OVOID", 2], ["ENCHANTED_REDSTONE", 128]],
    TARANTULA_CHESTPLATE: [["TARANTULA_SILK", 4], ["ENCHANTED_IRON", 256]],
    TARANTULA_LEGGINGS: [["TARANTULA_SILK", 3], ["ENCHANTED_IRON", 256]],
    TARANTULA_BOOTS: [["TARANTULA_SILK", 4], ["SPIDER_CATALYST", 1], ["ENCHANTED_IRON", 192], ["SPIDER_BOOTS", 1]],
    REVENANT_LEGGINGS: [["REVENANT_VISCERA", 3], ["ENCHANTED_DIAMOND", 64]],
    REVENANT_BOOTS: [["REVENANT_VISCERA", 2], ["ENCHANTED_DIAMOND", 64]],
    LESSER_SOULFLOW_ENGINE: [["NULL_OVOID", 6], ["ENCHANTED_EYE_OF_ENDER", 48], ["ENCHANTED_IRON_BLOCK", 8]],
    SOULFLOW_ENGINE: [["NULL_ATOM", 2], ["LESSER_SOULFLOW_ENGINE", 4], ["NULL_OVOID", 64], ["REFINED_TITANIUM", 12]],
    SOULFLOW_BATTERY: [["NULL_OVOID", 8], ["SOULFLOW_PILE", 1]],
    SOULFLOW_SUPERCELL: [["NULL_OVOID", 192], ["NULL_ATOM", 2], ["SOULFLOW_BATTERY", 1]],
    GEMSTONE_GAUNTLET: [["FLAWLESS_RUBY_GEM", 8], ["ENCHANTED_GOLD_BLOCK", 16]],
    MELON_CHESTPLATE: [["ENCHANTED_MELON_BLOCK", 40]],
    CROPIE_CHESTPLATE: [["CROPIE", 20], ["MELON_CHESTPLATE", 1], ["BOX_OF_SEEDS", 6], ["ENCHANTED_HAY_BALE", 8], ["ENCHANTED_BAKED_POTATO", 45]],
    SQUASH_CHESTPLATE: [["SQUASH", 20], ["CROPIE_CHESTPLATE", 1], ["ENCHANTED_MELON_BLOCK", 48], ["POLISHED_PUMPKIN", 8], ["ENCHANTED_COOKIE", 30]],
    FERMENTO_CHESTPLATE: [["CONDENSED_FERMENTO", 2], ["SQUASH_CHESTPLATE", 1], ["ENCHANTED_HUGE_MUSHROOM_2", 16], ["ENCHANTED_SUGAR_CANE", 32], ["ENCHANTED_HUGE_MUSHROOM_1", 16], ["MUTANT_NETHER_STALK", 30], ["ENCHANTED_CACTUS", 25]],
    RANCHERS_BOOTS: [["POLISHED_PUMPKIN", 16], ["FARMER_BOOTS", 1]],
    ROD_OF_THE_SEA: [["ENCHANTED_SHARK_FIN", 4], ["GREAT_WHITE_SHARK_TOOTH", 4], ["LEGEND_ROD", 1]],
    SORROW_CHESTPLATE: [["SORROW", 24]],
    // accessory chain targets (audit-verified)
    HASTE_ARTIFACT: [["ENCHANTED_COBBLESTONE", 256], ["HASTE_RING", 1]],
    VACCINE_ARTIFACT: [["POISON_SAMPLE", 8], ["VACCINE_RING", 1]],
    EMERALD_ARTIFACT: [["ENCHANTED_EMERALD_BLOCK", 36], ["EMERALD_RING", 1], ["AVARICIOUS_CHALICE", 1]],
    BAT_PERSON_RING: [["SPOOKY_SHARD", 4], ["ECTOPLASM", 32], ["BAT_PERSON_TALISMAN", 1]],
    BAT_PERSON_ARTIFACT: [["SPOOKY_SHARD", 16], ["ECTOPLASM", 128], ["BAT_PERSON_RING", 1]],
    SEA_CREATURE_ARTIFACT: [["ENCHANTED_SPONGE", 64], ["SEA_CREATURE_RING", 1]],
    SPEED_ARTIFACT: [["ENCHANTED_SUGAR_CANE", 48], ["SPEED_RING", 1]],
    POWER_ARTIFACT: [["GEMSTONE_MIXTURE", 32], ["POWER_RING", 1]],
    TREASURE_RING: [["TREASURE_TALISMAN", 8]],
    JERRY_TALISMAN_GOLDEN: [["JERRY_TALISMAN_PURPLE", 5]],
    INTIMIDATION_ARTIFACT: [["PURPLE_CANDY", 100], ["INTIMIDATION_RING", 1]],
  };

  // base stats per recipe item (NEU lore, checked 2026-07-09) - used to show
  // the offense/defense weight behind each priority and deltas vs current gear
  const ITEM_STATS = {
    REVENANT_SWORD: { dmg: 90, str: 50, int: 100 }, REAPER_SWORD: { dmg: 120, str: 100, int: 200 },
    AXE_OF_THE_SHREDDED: { dmg: 140, str: 115 },
    REVENANT_CHESTPLATE: { hp: 180, def: 70 }, REVENANT_LEGGINGS: { hp: 120, def: 50 }, REVENANT_BOOTS: { hp: 100, def: 30 },
    REAPER_MASK: { hp: 150, def: 100, int: 100 }, REAPER_CHESTPLATE: { hp: 180, def: 70, str: 25, int: 250 },
    WARDEN_HELMET: { hp: 300, def: 100 },
    RECLUSE_FANG: { dmg: 60, str: 30, cd: 10 }, SCORPION_FOIL: { dmg: 120, str: 60, cd: 30 }, STING: { dmg: 150, str: 75, cd: 40 },
    TARANTULA_HELMET: { hp: 100, def: 80, int: 80 }, TARANTULA_CHESTPLATE: { hp: 120, def: 100, int: 100 },
    TARANTULA_LEGGINGS: { hp: 105, def: 90, int: 80 }, TARANTULA_BOOTS: { hp: 70, def: 70, int: 50 },
    MASTIFF_HELMET: { hp: 500, def: -1000000 }, MASTIFF_CHESTPLATE: { hp: 500, def: -1000000 },
    MASTIFF_LEGGINGS: { hp: 500, def: -1000000 }, MASTIFF_BOOTS: { hp: 500, def: -1000000 },
    RED_CLAW_TALISMAN: { cd: 1 }, RED_CLAW_RING: { cd: 3 }, RED_CLAW_ARTIFACT: { cd: 5 },
    VOIDWALKER_KATANA: { dmg: 105, str: 40, cd: 15 }, VOIDEDGE_KATANA: { dmg: 155, str: 60, cd: 25 },
    VORPAL_KATANA: { dmg: 190, str: 80, cd: 30, int: 200 }, ATOMSPLIT_KATANA: { dmg: 305, str: 100, cd: 50, int: 300 },
    JUJU_SHORTBOW: { dmg: 310, str: 40, cc: 10, cd: 110 }, TERMINATOR: { dmg: 310, str: 50, cd: 250 },
    ASPECT_OF_THE_VOID: { dmg: 120, str: 100 },
    FINAL_DESTINATION_HELMET: { hp: 140, def: 100, int: 100 }, FINAL_DESTINATION_CHESTPLATE: { hp: 200, def: 100, int: 100 },
    FINAL_DESTINATION_LEGGINGS: { hp: 160, def: 100, int: 100 }, FINAL_DESTINATION_BOOTS: { hp: 100, def: 100, int: 100 },
    FIREDUST_DAGGER: { dmg: 90, str: 45, cd: 15 },
    BURSTSTOPPER_TALISMAN: { td: 2, str: 1 }, BURSTSTOPPER_ARTIFACT: { td: 3, str: 2 },
    DESTRUCTION_CLOAK: { hp: 60, str: 15, cd: 15 }, ANNIHILATION_CLOAK: { hp: 80, str: 20, cd: 20 },
    // skill gear (NEU lore): ms=Mining Speed, mf=Mining Fortune, ff=Farming Fortune, fs=Fishing Speed, scc=Sea Creature Chance
    MITHRIL_DRILL_1: { ms: 450, mf: 15 }, MITHRIL_DRILL_2: { ms: 600, mf: 20 }, TITANIUM_DRILL_1: { ms: 700, mf: 25 },
    DIVAN_DRILL: { ms: 1800, mf: 150 }, GEMSTONE_GAUNTLET: { dmg: 300, str: 50, ms: 800 },
    MELON_CHESTPLATE: { hp: 150, def: 25, ff: 20 }, CROPIE_CHESTPLATE: { hp: 165, def: 30, ff: 25 },
    SQUASH_CHESTPLATE: { hp: 180, def: 35, ff: 30 }, FERMENTO_CHESTPLATE: { hp: 195, def: 40, ff: 35 },
    RANCHERS_BOOTS: { hp: 100, def: 84, spd: 78 },
    ROD_OF_THE_SEA: { dmg: 150, str: 150, fs: 80, scc: 8 }, HELLFIRE_ROD: { dmg: 225, str: 225, fs: 60, scc: 14 },
    AUGER_ROD: { dmg: 135, str: 90, fs: 110 }, SORROW_CHESTPLATE: { ms: 50, mf: 20 },
  };
  const STAT_LBL = { dmg: " dmg", str: " str", cc: "% cc", cd: "% cd", hp: " HP", def: " def", int: " int", td: " tdef", ms: " mine-spd", mf: " mine-fortune", ff: " farm-fortune", fs: " fish-spd", scc: "% sea-creature", spd: " spd" };
  const statText = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${v > 0 ? "+" : ""}${Math.abs(v) >= 1e6 ? (v / 1e6) + "M" : v}${STAT_LBL[k] || k}`).join(" ");
  const sumStats = (ids) => { const t = {}; for (const id of ids) for (const [k, v] of Object.entries(ITEM_STATS[id] || {})) t[k] = (t[k] || 0) + v; return t; };
  // parse the player's own item lore for damage/strength (includes reforges)
  const loreStats = (item) => { const o = {}; for (const l of item?.lore || []) { const m = l.replace(/§./g, "").match(/^(Damage|Strength): \+?([\d,]+)/); if (m) o[m[1] === "Damage" ? "dmg" : "str"] = Number(m[2].replace(/,/g, "")); } return o; };

  // owning any of these higher-tier items means the entry is already "done"
  const SUPERSEDES = {
    RED_CLAW_TALISMAN: ["RED_CLAW_RING", "RED_CLAW_ARTIFACT"],
    RED_CLAW_RING: ["RED_CLAW_ARTIFACT"],
    ZOMBIE_RING: ["ZOMBIE_ARTIFACT"],
    SPIDER_RING: ["SPIDER_ARTIFACT"],
    TARANTULA_TALISMAN: ["TARANTULA_RING"],
    RADIANT_POWER_ORB: ["MANA_FLUX_POWER_ORB", "OVERFLUX_POWER_ORB", "PLASMAFLUX_POWER_ORB"],
    MANA_FLUX_POWER_ORB: ["OVERFLUX_POWER_ORB", "PLASMAFLUX_POWER_ORB"],
    OVERFLUX_CAPACITOR: ["OVERFLUX_POWER_ORB", "PLASMAFLUX_POWER_ORB"],
    OVERFLUX_POWER_ORB: ["PLASMAFLUX_POWER_ORB"],
    REVENANT_SWORD: ["REAPER_SWORD", "AXE_OF_THE_SHREDDED"],
    REAPER_SWORD: ["AXE_OF_THE_SHREDDED"],
    VOIDWALKER_KATANA: ["VOIDEDGE_KATANA", "VORPAL_KATANA", "ATOMSPLIT_KATANA"],
    VOIDEDGE_KATANA: ["VORPAL_KATANA", "ATOMSPLIT_KATANA"],
    VORPAL_KATANA: ["ATOMSPLIT_KATANA"],
    SOULFLOW_PILE: ["SOULFLOW_BATTERY", "SOULFLOW_SUPERCELL"],
    SOULFLOW_BATTERY: ["SOULFLOW_SUPERCELL"],
    LESSER_SOULFLOW_ENGINE: ["SOULFLOW_ENGINE"],
    BURSTSTOPPER_TALISMAN: ["BURSTSTOPPER_ARTIFACT"],
    FIREDUST_DAGGER: ["KINDLEBANE_DAGGER", "PYROCHAOS_DAGGER"],
    KINDLEBANE_DAGGER: ["PYROCHAOS_DAGGER"],
    MITHRIL_DRILL_1: ["MITHRIL_DRILL_2", "TITANIUM_DRILL_1", "TITANIUM_DRILL_2", "TITANIUM_DRILL_3", "TITANIUM_DRILL_4", "DIVAN_DRILL"],
    MITHRIL_DRILL_2: ["TITANIUM_DRILL_1", "TITANIUM_DRILL_2", "TITANIUM_DRILL_3", "TITANIUM_DRILL_4", "DIVAN_DRILL"],
    TITANIUM_DRILL_1: ["TITANIUM_DRILL_2", "TITANIUM_DRILL_3", "TITANIUM_DRILL_4", "DIVAN_DRILL"],
    MELON_CHESTPLATE: ["CROPIE_CHESTPLATE", "SQUASH_CHESTPLATE", "FERMENTO_CHESTPLATE", "HELIANTHUS_CHESTPLATE"],
    CROPIE_CHESTPLATE: ["SQUASH_CHESTPLATE", "FERMENTO_CHESTPLATE", "HELIANTHUS_CHESTPLATE"],
    SQUASH_CHESTPLATE: ["FERMENTO_CHESTPLATE", "HELIANTHUS_CHESTPLATE"],
    FERMENTO_CHESTPLATE: ["HELIANTHUS_CHESTPLATE"],
    ROD_OF_THE_SEA: ["HELLFIRE_ROD"],
    SPONGE_CHESTPLATE: ["SHARK_SCALE_CHESTPLATE"],
  };

  const suggestedTier = (lvl, max) => Math.min(max, lvl <= 1 ? 1 : lvl <= 3 ? 2 : lvl <= 5 ? 3 : 4);
  const slayerLoadouts = SLAYER_KITS.map((k) => {
    const lvl = slayerLvl(k.boss);
    const weaponId = bestOwnedId(k.weapons);
    const armor = bestOwnedSet(k.sets);
    const { pick: pet, alt: petAlt, goal: petGoal, conditionals: petConditionals } = pickPets(k.pets);
    const slots = { ...EQUIP_SLOTS, ...(k.equipOverride || {}) };
    const equipment = Object.entries(slots).map(([slot, ids]) => ({ slot, id: bestOwnedId(ids) })).filter((e) => e.id);
    const recipes = (k.recipes || []).map((r) => {
      const ids = r.ids || [r.id];
      const ownedCount = ids.filter((id) => ownedIds.has(id)).length;
      const allOwned = ownedCount === ids.length;
      const superseded = !allOwned && (SUPERSEDES[ids[0]] || []).some((s) => ownedIds.has(s));
      const status = allOwned || superseded ? "owned" : lvl >= r.req ? "unlocked" : "locked";
      // sets: per-piece built/missing state with each piece's outstanding materials
      const pieces = ids.length > 1 && status !== "owned" ? ids.map((id) => ({
        name: nice(id), owned: ownedIds.has(id),
        mats: !ownedIds.has(id) && RECIPE_MATS[id]
          ? RECIPE_MATS[id].map(([mid, need]) => ({ name: nice(mid), need, have: matHave(mid), ok: matHave(mid) >= need }))
          : null,
      })) : null;
      let mats = null;
      if (status !== "owned" && !pieces) {
        const agg = {};
        for (const id of ids) {
          if (ownedIds.has(id)) continue;
          for (const [mid, need] of RECIPE_MATS[id] || []) agg[mid] = (agg[mid] || 0) + need;
        }
        if (Object.keys(agg).length) mats = Object.entries(agg).map(([mid, need]) => ({ name: nice(mid), need, have: matHave(mid), ok: matHave(mid) >= need }));
      }
      const baseName = r.name || nice(ids[0]);
      const name = baseName + (ids.length > 1 ? ` (${ownedCount}/${ids.length} pieces)` : "");
      // wiki titles keep small words lowercase ("Aspect of the Void")
      const wikiTitle = (s) => s.replace(/\b(Of|The|To|In|And)\b/g, (m, w, off) => (off === 0 ? m : m.toLowerCase()));
      const wiki = "https://hypixelskyblock.minecraft.wiki/w/" + wikiTitle(r.wiki || baseName).replace(/ /g, "_");
      // stat weight behind the priority, + delta vs the player's current weapon
      const stats = sumStats(ids);
      let delta = null;
      if (status !== "owned" && stats.dmg && weaponId && fullItemById[weaponId]) {
        const cur = loreStats(fullItemById[weaponId]);
        if (cur.dmg) {
          const d = stats.dmg - cur.dmg, s = (stats.str || 0) - (cur.str || 0);
          if (d > 0 || s > 0) delta = `${d > 0 ? `+${d} dmg` : ""}${d > 0 && s > 0 ? ", " : ""}${s > 0 ? `+${s} str` : ""} vs your ${nice(weaponId)}`;
        }
      }
      return { name, req: r.req, reqLabel: `LVL ${r.req}`, why: r.why, prio: r.prio || 2, wiki, status, superseded, mats, pieces, stats: statText(stats) || null, delta, inMinion: r.inMinion || false };
    });
    // what to craft first among currently-unlocked recipes (skip items we
    // can't verify, like minion-installed upgrades - no point nagging)
    const focus = recipes.filter((r) => r.status === "unlocked" && !r.inMinion).sort((a, b) => a.prio - b.prio || a.req - b.req)[0] || null;
    return {
      boss: k.boss, label: k.label, level: lvl, suggestedTier: suggestedTier(lvl, k.maxTier), maxTier: k.maxTier,
      weaponId, weaponHint: weaponId ? null : k.weaponHint, armor, pet, petAlt, petGoal, petConditionals, equipment, recipes, focus, note: k.note,
      wikiUrl: "https://hypixelskyblock.minecraft.wiki/w/" + { zombie: "Zombie_Slayer", spider: "Spider_Slayer", wolf: "Wolf_Slayer", enderman: "Enderman_Slayer", blaze: "Blaze_Slayer" }[k.boss],
      locked: !slayerUnlocked(k.boss), unlock: slayerLockText(k.boss),
    };
  });

  // unlocked-but-uncrafted slayer recipes = free progression sitting on the table
  for (const L of slayerLoadouts) {
    if (L.locked) continue;
    const ready = L.recipes.filter((r) => r.status === "unlocked" && !r.inMinion).sort((a, b) => a.prio - b.prio || a.req - b.req);
    if (ready.length) {
      rec(2, "Slayers", `${L.label.split(" (")[0]}: ${ready.length} unlocked recipe(s) you haven't made`,
        `Craft first: ${ready[0].name} (${ready[0].why}).${ready.length > 1 ? ` Then: ${ready.slice(1, 3).map((r) => r.name).join(", ")}${ready.length > 3 ? ", …" : ""}.` : ""}`,
        "Priority order and materials are on this slayer's roadmap.");
    }
  }

  // =================================================================
  // SKILL LOADOUTS - the slayer template applied to gathering skills:
  // best owned tool/armor/equipment/pet + prioritized gear roadmap.
  // =================================================================

  const collTier = (name) => member.collectionTiers?.[name] ?? 0;
  const potm = member.stats?.mining?.peakOfTheMountainLevel ?? 0;
  const gateOk = (g) => !g || (g.hotm ? potm >= g.hotm : g.coll ? collTier(g.coll[0]) >= g.coll[1] : true);
  const gateLabel = (g) => (!g ? "no gate" : g.hotm ? `HotM ${g.hotm}` : g.coll ? `${g.coll[2]} ${g.coll[1]}` : "");

  const SKILL_KITS = [
    {
      skill: "mining", label: "Mining", wikiPage: "Mining",
      tools: ["DIVAN_DRILL", "TITANIUM_DRILL_4", "TITANIUM_DRILL_3", "TITANIUM_DRILL_2", "TITANIUM_DRILL_1", "MITHRIL_DRILL_2", "MITHRIL_DRILL_1", "GEMSTONE_GAUNTLET", "STONK_PICKAXE"],
      toolHint: "Craft the Mithril Drill at HotM 2 - drills leap past pickaxes.",
      sets: [{ id: "DIVAN", name: "Armor of Divan", why: "top mining set" }, { id: "SORROW", why: "cheap, strong glacite set" }, { id: "ARMOR_OF_YOG", name: "Armor of Yog", why: "Crimson mining" }, { id: "GLOSSY_MINERAL" }, { id: "MINERAL" }, { id: "GLACITE" }],
      equipSlots: { Necklace: ["TITANIUM_NECKLACE", "MITHRIL_NECKLACE"], Cloak: ["TITANIUM_CLOAK", "MITHRIL_CLOAK"], Belt: ["TITANIUM_BELT", "MITHRIL_BELT"], Gloves: ["TITANIUM_GAUNTLET", "DWARVEN_HANDWARMERS", "MITHRIL_GAUNTLET"] },
      pets: [
        { type: "SCATHA", why: "Mining Fortune + treasure drops - the fortune pet" },
        { type: "GLACITE_GOLEM", why: "strong in the Glacite tunnels" },
        { type: "MOLE", why: "XP + spread mining" },
        { type: "ROCK", why: "starter" },
      ],
      note: "Mining Fortune multiplies drops, Mining Speed breaks blocks faster - balance both.",
      zones: [
        { zone: "Glacite Mineshafts / Tunnels", pet: "GLACITE_GOLEM", why: "Mining Fortune inside mineshafts + bonus Glacite Powder" },
        { zone: "Crystal Hollows (gemstones)", pet: "SCATHA", why: "Gemstone Fortune on drills + treasure chest finds" },
        { zone: "Mines of Divan / Nucleus runs", pet: "MOLE", why: "more scavenged items, automaton parts, nucleus bonus" },
        { zone: "Magma Fields", pet: "BAL", why: "Pristine there + heat control + pickaxe cooldown" },
        { zone: "Dwarven commissions (general)", pet: "SCATHA", why: "best general fortune pick" },
      ],
      recipes: [
        { id: "MITHRIL_DRILL_1", gate: { hotm: 2 }, prio: 1, why: "first drill - huge speed jump" },
        { id: "MITHRIL_DRILL_2", gate: { hotm: 3 }, prio: 2, why: "drill upgrade" },
        { id: "TITANIUM_DRILL_1", gate: { hotm: 5 }, prio: 1, why: "titanium drill line starts (upgrades to DR-X655)" },
        { ids: ["SORROW_HELMET", "SORROW_CHESTPLATE", "SORROW_LEGGINGS", "SORROW_BOOTS"], name: "Sorrow set", wiki: "Sorrow Armor", prio: 2, why: "24 Sorrow per piece (glacite drops)" },
        { ids: ["ARMOR_OF_YOG_HELMET", "ARMOR_OF_YOG_CHESTPLATE", "ARMOR_OF_YOG_LEGGINGS", "ARMOR_OF_YOG_BOOTS"], name: "Armor of Yog", wiki: "Armor of Yog", gate: { coll: ["HARD_STONE", 5, "Hard Stone"] }, prio: 2, why: "Crimson mining set (40 Yoggies per piece)" },
        { ids: ["DIVAN_HELMET", "DIVAN_CHESTPLATE", "DIVAN_LEGGINGS", "DIVAN_BOOTS"], name: "Armor of Divan", wiki: "Armor of Divan", gate: { hotm: 6 }, prio: 1, why: "top mining armor" },
        { id: "GEMSTONE_GAUNTLET", gate: { coll: ["GEMSTONE_COLLECTION", 11, "Gemstone"] }, prio: 2, why: "gemstone-mining tool" },
        { id: "DIVAN_DRILL", gate: { hotm: 7 }, prio: 1, why: "endgame drill" },
      ],
    },
    {
      skill: "farming", label: "Farming", wikiPage: "Farming",
      tools: [],
      toolHint: "Per-crop hoes and dicers live in your farming toolkit - push them to Tier 3.",
      sets: [{ id: "HELIANTHUS", why: "mythic-tier farming set" }, { id: "FERMENTO" }, { id: "SQUASH" }, { id: "CROPIE" }, { id: "MELON" }, { id: "FARM" }],
      equipSlots: { Necklace: ["PESTHUNTERS_NECKLACE", "BLOSSOM_NECKLACE", "LOTUS_NECKLACE"], Cloak: ["PESTHUNTERS_CLOAK", "LOTUS_CLOAK"], Belt: ["PESTHUNTERS_BELT", "BLOSSOM_BELT", "LOTUS_BELT"], Gloves: ["PESTHUNTERS_GLOVES", "BLOSSOM_BRACELET", "LOTUS_BRACELET"] },
      pets: [
        { type: "ELEPHANT", why: "+Farming Fortune - the farming pet" },
        { type: "MOOSHROOM_COW", why: "fortune synergy on crops" },
        { type: "SLUG", why: "pest control in the Garden" },
        { type: "RABBIT", why: "farming XP boost" },
      ],
      note: "Farming Fortune multiplies harvests - it beats speed for progression.",
      zones: [
        { zone: "Garden crops (fortune)", pet: "ELEPHANT", why: "flat Farming Fortune" },
        { zone: "Sprayonator / pest plots", pet: "SLUG", why: "bonus pest chance + fortune on sprayed plots" },
      ],
      recipes: [
        { id: "MELON_CHESTPLATE", gate: { coll: ["MELON", 9, "Melon"] }, prio: 2, why: "chestplate chain starts (each tier has a full set)" },
        { id: "CROPIE_CHESTPLATE", prio: 2, why: "consumes the Melon chest" },
        { id: "SQUASH_CHESTPLATE", prio: 2, why: "consumes the Cropie chest" },
        { id: "FERMENTO_CHESTPLATE", prio: 1, why: "top craftable farming chest (consumes Squash)" },
        { id: "RANCHERS_BOOTS", gate: { coll: ["PUMPKIN", 11, "Pumpkin"] }, prio: 1, why: "speed-control boots - a farming staple" },
      ],
    },
    {
      skill: "fishing", label: "Fishing", wikiPage: "Fishing",
      tools: ["HELLFIRE_ROD", "ROD_OF_THE_SEA", "AUGER_ROD", "INFERNO_ROD", "MAGMA_ROD", "LEGEND_ROD", "CHAMP_ROD", "CHALLENGE_ROD", "STARTER_LAVA_ROD"],
      toolHint: "Water and lava rods are separate lines - Rod of the Sea (water) and Inferno/Hellfire (lava).",
      sets: [{ id: "MAGMA_LORD", why: "top set - Magma Cube Boss fragments" }, { id: "THUNDER", why: "8 Thunder Shards per piece" }, { id: "SHARK_SCALE" }, { id: "SPONGE" }, { id: "ANGLER" }],
      equipSlots: { Necklace: ["THUNDERBOLT_NECKLACE", "BACKWATER_NECKLACE", "ANGLER_NECKLACE"], Cloak: ["FINWAVE_CLOAK", "BACKWATER_CLOAK", "ANGLER_CLOAK"], Belt: ["FINWAVE_BELT", "BACKWATER_BELT", "ANGLER_BELT"], Gloves: ["FINWAVE_GLOVES", "BACKWATER_GLOVES", "ANGLER_BRACELET"] },
      pets: [
        { type: "AMMONITE", why: "fishing speed scales with your HotM tier - elite Ironman fishing pet" },
        { type: "FLYING_FISH", why: "fishing stats all-rounder" },
        { type: "BABY_YETI", why: "strength + defense while fishing" },
        { type: "DOLPHIN", why: "sea creature chance" },
        { type: "SQUID", why: "fishing XP" },
      ],
      note: "Sea Creature Chance brings more creatures; Fishing Speed brings faster bites.",
      zones: [
        { zone: "General water fishing", pet: "AMMONITE", why: "Sea Creature Chance scales with your HotM tier" },
        { zone: "Crystal Hollows fishing", pet: "AMMONITE", why: "adds Double Hook chance per HotM level there" },
        { zone: "Crimson Isle (slugfish)", pet: "SLUG", why: "slugfish catch time reduced" },
        { zone: "Jerry pond (winter)", pet: "BABY_YETI", why: "strength + defense while fishing" },
      ],
      recipes: [
        { id: "SPONGE_CHESTPLATE", gate: { coll: ["SPONGE", 9, "Sponge"] }, prio: 2, why: "fishing armor chain starts" },
        { id: "SHARK_SCALE_CHESTPLATE", prio: 2, why: "consumes the Sponge chest" },
        { ids: ["THUNDER_HELMET", "THUNDER_CHESTPLATE", "THUNDER_LEGGINGS", "THUNDER_BOOTS"], name: "Thunder set", wiki: "Thunder Armor", prio: 1, why: "8 Thunder Shards per piece (Thunder boss)" },
        { ids: ["MAGMA_LORD_HELMET", "MAGMA_LORD_CHESTPLATE", "MAGMA_LORD_LEGGINGS", "MAGMA_LORD_BOOTS"], name: "Magma Lord set", wiki: "Magma Lord Armor", prio: 1, why: "8 Magma Lord Fragments per piece" },
        { id: "ROD_OF_THE_SEA", prio: 1, why: "top water rod" },
        { id: "HELLFIRE_ROD", gate: { coll: ["MAGMA_FISH", 12, "Magmafish"] }, prio: 1, why: "endgame lava rod" },
      ],
    },
    {
      skill: "foraging", label: "Foraging & Hunting", wikiPage: "Foraging",
      tools: [],
      toolHint: "Axe choice now depends on tree Toughness and Sweep (Galatea rework) - no single BiS; your Figstone Axe handles Galatea trees, Treecapitator suits Park trees. Check the wiki + Heart of the Forest.",
      sets: [{ id: "FIG", why: "Galatea foraging set" }, { id: "SILVER_HUNTER", why: "hunting set" }],
      equipSlots: { Cloak: ["MANGROVE_VINE"], Necklace: ["MANGROVE_LOCKET"], Gloves: ["MANGROVE_GRIPPERS"] },
      pets: [
        { type: "MONKEY", why: "the foraging pet" },
        { type: "OCELOT", why: "foraging XP" },
      ],
      note: "Newest content in the game - gear advice here is intentionally light; check the wiki.",
      recipes: [],
      zones: [
        { zone: "The Park", pet: "MONKEY", why: "its Speed and Sweep perks ONLY work in the Park" },
        { zone: "Galatea (Figs / Mangrove)", pet: "MONKEY", why: "only its flat Foraging Fortune applies here - newer Hunting-shard pets may beat it as the meta settles" },
      ],
    },
  ];

  const skillLoadouts = SKILL_KITS.map((k) => {
    const lvl = skillLevel(k.skill);
    const toolId = bestOwnedId(k.tools);
    const armor = bestOwnedSet(k.sets);
    const { pick: pet, alt: petAlt, goal: petGoal } = pickPets(k.pets);
    const equipment = Object.entries(k.equipSlots || {}).map(([slot, ids]) => ({ slot, id: bestOwnedId(ids) })).filter((e) => e.id);
    const recipes = (k.recipes || []).map((r) => {
      const ids = r.ids || [r.id];
      const ownedCount = ids.filter((id) => ownedIds.has(id)).length;
      const allOwned = ownedCount === ids.length;
      const superseded = !allOwned && (SUPERSEDES[ids[0]] || []).some((s) => ownedIds.has(s));
      const status = allOwned || superseded ? "owned" : gateOk(r.gate) ? "unlocked" : "locked";
      const pieces = ids.length > 1 && status !== "owned" ? ids.map((id) => ({
        name: nice(id), owned: ownedIds.has(id),
        mats: !ownedIds.has(id) && RECIPE_MATS[id]
          ? RECIPE_MATS[id].map(([mid, need]) => ({ name: nice(mid), need, have: matHave(mid), ok: matHave(mid) >= need }))
          : null,
      })) : null;
      let mats = null;
      if (status !== "owned" && !pieces) {
        const agg = {};
        for (const id of ids) { if (ownedIds.has(id)) continue; for (const [mid, need] of RECIPE_MATS[id] || []) agg[mid] = (agg[mid] || 0) + need; }
        if (Object.keys(agg).length) mats = Object.entries(agg).map(([mid, need]) => ({ name: nice(mid), need, have: matHave(mid), ok: matHave(mid) >= need }));
      }
      const baseName = r.name || nice(ids[0]);
      const wikiTitle = (s) => s.replace(/\b(Of|The|To|In|And)\b/g, (m, w, off) => (off === 0 ? m : m.toLowerCase()));
      return {
        name: baseName + (ids.length > 1 ? ` (${ownedCount}/${ids.length} pieces)` : ""),
        req: 0, reqLabel: gateLabel(r.gate), why: r.why, prio: r.prio || 2,
        wiki: "https://hypixelskyblock.minecraft.wiki/w/" + wikiTitle(r.wiki || baseName).replace(/ /g, "_"),
        status, superseded, mats, pieces, stats: statText(sumStats(ids)) || null, delta: null,
      };
    });
    const focus = recipes.filter((r) => r.status === "unlocked").sort((a, b) => a.prio - b.prio)[0] || null;
    // zone-specific pet picks (perks verified via NEU lore), with ownership
    const zones = (k.zones || []).map((z) => {
      const p = petByType[z.pet];
      return { ...z, petName: nice(z.pet), owned: p ? { tier: p.tier, level: p.level } : null };
    });
    // in-place upgrades on gear the player already owns (gem slots, drill parts)
    const gearUpgrades = [];
    const inspect = (id, label) => {
      const it = fullItemById[id];
      if (!it) return;
      const plain = (it.lore || []).map((l) => stripColors(l));
      const gemLine = plain.find((l) => /^Gemstones:/.test(l.trim()));
      if (gemLine) {
        // slot brackets contain custom-font glyphs, so count slots via "[" and
        // filled slots via the item's gems data (keys minus _gem meta entries)
        const gems = it.gems || {};
        const filledKeys = Object.keys(gems).filter((k) => !k.endsWith("_gem") && k !== "unlocked_slots");
        const totalSlots = (gemLine.match(/\[/g) || []).length;
        const empty = Math.max(0, totalSlots - filledKeys.length);
        if (empty > 0) gearUpgrades.push(`${label}: ${empty} of ${totalSlots} gemstone slots unfilled (some slot types need unlocking first).`);
        const lowQ = filledKeys.filter((k) => { const v = gems[k]; const q = typeof v === "string" ? v : v?.quality; return ["ROUGH", "FLAWED", "FINE"].includes(q); }).length;
        if (lowQ > 0) gearUpgrades.push(`${label}: ${lowQ} socketed gem(s) below Flawless quality - upgrading gems is a big stat jump.`);
      }
      const lore = plain.join(" | ");
      if (/Ruby-Polished Drill Engine/.test(lore)) gearUpgrades.push(`${label}: Ruby-Polished engine installed - Sapphire- and Amber-Polished Drill Engines are direct upgrades.`);
      if (/Mithril-Infused Fuel Tank/.test(lore)) gearUpgrades.push(`${label}: Mithril-Infused tank installed - Gemstone and Perfectly-Cut Fuel Tanks are direct upgrades.`);
    };
    if (toolId) inspect(toolId, "Your " + nice(toolId));
    if (armor) for (const pid of armor.pieceIds) inspect(pid, nice(pid));
    return {
      skill: k.skill, label: k.label, level: lvl, toolId, toolHint: toolId ? null : k.toolHint, armor, pet, petAlt, petGoal,
      equipment, recipes, focus, zones, gearUpgrades, note: k.note,
      wikiUrl: "https://hypixelskyblock.minecraft.wiki/w/" + k.wikiPage,
    };
  });

  for (const S of skillLoadouts) {
    if (S.focus) {
      rec(2, "Skills", `${S.label}: craft the ${S.focus.name}`, `${S.focus.why}${S.focus.stats ? ` (${S.focus.stats})` : ""}.`, "Materials and the full ladder are on the Skill Loadouts card.");
    }
  }

  // =================================================================
  // CRAFT PRIORITIES - gate-checked against YOUR profile.
  // Recipes/requirements verified against the NotEnoughUpdates item
  // repo (2026-07-08). Status per target:
  //   ready  = every gate and material met - craft it now
  //   gather = unlocked, but short on materials (listed)
  //   locked = recipe gate not met (slayer level / missing base item)
  // Weighing order when one resource has competing uses:
  //   permanent accessories > daily tools > armor (gets replaced) > hoarding
  // =================================================================

  // check builders: gate=true means a hard unlock (slayer/collection/base item)
  const gSlayer = (boss, lvl) => ({ label: `${boss[0].toUpperCase() + boss.slice(1)} Slayer ${lvl} (you: ${slayerLvl(boss)})`, ok: slayerLvl(boss) >= lvl, gate: true });
  const gColl = (name, tier, label) => ({ label: `${label} collection ${tier} (you: ${collTier(name)})`, ok: collTier(name) >= tier, gate: true });
  const gBase = (id, label) => ({ label: `${label} (base item)`, ok: ownedIds.has(id), gate: true });
  // resId (optional) marks the material as part of a shared pool - after all
  // targets are defined, demand is totaled per resource and allocated to the
  // most valuable crafts first (rank 1 = permanent accessory, 2 = weapon/tool,
  // 3 = situational armor / museum fodder).
  const gMat = (need, have, label, resId) => ({ label: `${n(need)}x ${label} (you: ${n(have)})`, ok: have >= need, _res: resId ? { id: resId, need, have } : null });
  const gInfo = (label, ok = true) => ({ label, ok });

  const craftPriorities = [];
  const resourceDemand = {};
  const statusRank = { ready: 0, gather: 1, locked: 2 };
  const target = (ids, name, checks, why, insteadOf, rank = 1) => {
    if ((Array.isArray(ids) ? ids : [ids]).some((x) => ownedIds.has(x))) return; // already own it
    const locked = checks.some((c) => c.gate && !c.ok);
    const short = checks.some((c) => !c.ok);
    const status = locked ? "locked" : short ? "gather" : "ready";
    for (const c of checks) {
      if (c._res) (resourceDemand[c._res.id] ||= []).push({ name, need: c._res.need, have: c._res.have, rank, status, order: craftPriorities.length });
    }
    craftPriorities.push({
      name, why, rank, insteadOf: insteadOf || null, status,
      checks: checks.map(({ label, ok }) => ({ label, ok })),
    });
  };

  // --- craftable accessories (recipes verified) ---
  if (ownedIds.has("SEA_CREATURE_RING"))
    target("SEA_CREATURE_ARTIFACT", "Sea Creature Artifact", [
      gColl("SPONGE", 8, "Sponge"), gBase("SEA_CREATURE_RING", "Sea Creature Ring"),
      gMat(64, sackOf("ENCHANTED_SPONGE"), "Enchanted Sponge"),
    ], "Ring → Artifact is permanent Magical Power and sea-creature stats for your fishing grind.");

  target("AGARIMOO_TALISMAN", "Agarimoo Talisman", [
    gMat(9, sackOf("AGARIMOO_TONGUE"), "Agarimoo Tongue"),
  ], "A cheap unique accessory = free Magical Power.");

  if (ownedIds.has("MINERAL_TALISMAN"))
    target("GLOSSY_MINERAL_TALISMAN", "Glossy Mineral Talisman", [
      gBase("MINERAL_TALISMAN", "Mineral Talisman"), gMat(16, sackOf("GLOSSY_GEMSTONE"), "Glossy Gemstone", "GLOSSY_GEMSTONE"),
    ], "Direct upgrade to an accessory you already carry.");

  // Glossy Mineral armor set completion - competes with the talisman for gemstones
  {
    const upgradable = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].filter(
      (s) => !ownedIds.has("GLOSSY_MINERAL_" + s) && ownedIds.has("MINERAL_" + s)
    );
    if (upgradable.length) {
      const outclassed = ["DIVAN", "SORROW", "ARMOR_OF_DIVAN"].some((p) => [...ownedIds].some((id) => id.startsWith(p)));
      target([], `Glossy Mineral armor - upgrade ${upgradable.length} piece(s) (${upgradable.map((s) => s.toLowerCase()).join(", ")})`, [
        ...upgradable.map((s) => gBase("MINERAL_" + s, `Mineral ${s[0] + s.slice(1).toLowerCase()} (base)`)),
        gMat(16 * upgradable.length, sackOf("GLOSSY_GEMSTONE"), "Glossy Gemstone (16 per piece)", "GLOSSY_GEMSTONE"),
      ],
      outclassed
        ? "Completes the set, but your Divan/Sorrow gear outclasses it for actual mining - this is museum/collection value, which is why the talisman outranks it for the same gemstones."
        : "Solid mining set upgrade using the same Glossy Gemstones as the talisman.",
      null, outclassed ? 3 : 2);
    }
  }

  if (ownedIds.has("SPEED_RING"))
    target("SPEED_ARTIFACT", "Speed Artifact", [
      gColl("SUGAR_CANE", 8, "Sugar Cane"), gBase("SPEED_RING", "Speed Ring"),
      gMat(48, sackOf("ENCHANTED_SUGAR_CANE"), "Enchanted Sugar Cane"),
      gInfo(`${n(sackOf("ENCHANTED_SUGAR"))} Enchanted Sugar banked - converts into Enchanted Sugar Cane`),
    ], "Permanent +speed; the materials are effectively already in your sacks as Enchanted Sugar.");

  target(["DAY_CRYSTAL"], "Day Crystal", [
    gColl("QUARTZ", 8, "Nether Quartz"),
    gMat(164, sackOf("ENCHANTED_QUARTZ") + sackOf("ENCHANTED_QUARTZ_BLOCK") * 160, "Enchanted Quartz worth (4 + 1 block @160)", "ENCHANTED_QUARTZ"),
  ], "Permanent accessory (quartz-based - NOT end stone). Its twin, the Night Crystal, uses the same materials.");

  target(["NIGHT_CRYSTAL"], "Night Crystal", [
    gColl("QUARTZ", 7, "Nether Quartz"),
    gMat(164, sackOf("ENCHANTED_QUARTZ") + sackOf("ENCHANTED_QUARTZ_BLOCK") * 160, "Enchanted Quartz worth (4 + 1 block @160)", "ENCHANTED_QUARTZ"),
  ], "Pairs with the Day Crystal; together they also buff stats on your island.");

  if (ownedIds.has("POWER_RING"))
    target("POWER_ARTIFACT", "Power Artifact", [
      gColl("GEMSTONE_COLLECTION", 10, "Gemstone"), gBase("POWER_RING", "Power Ring"),
      gMat(32, sackOf("GEMSTONE_MIXTURE") + countItems("GEMSTONE_MIXTURE"), "Gemstone Mixture (Crystal Hollows craft)"),
    ], "Permanent Magical Power. Gemstone Mixtures are the real cost - craft them from Crystal Hollows materials.",
    "spending gemstone materials on armor sockets - armor gets replaced, artifacts don't");

  const emeraldWorth = sackOf("ENCHANTED_EMERALD") + sackOf("ENCHANTED_EMERALD_BLOCK") * 160;
  target(["ENDER_ARTIFACT", "ENDER_RELIC"], "Ender Artifact", [
    gInfo("Bought in the Trades menu (unlocked via Emerald collection)"),
    gMat(312, emeraldWorth, "Enchanted Emerald", "ENCHANTED_EMERALD"),
  ], "Permanent Magical Power + End-zone stats, and you live in the End right now.",
  "the Wither Artifact - the SAME 312 Enchanted Emerald trade. Ender first while the End is your grind, Wither second");

  target(["WITHER_ARTIFACT", "WITHER_RELIC"], "Wither Artifact", [
    gInfo("Bought in the Trades menu (unlocked via Emerald collection)"),
    gMat(312, emeraldWorth, "Enchanted Emerald", "ENCHANTED_EMERALD"),
  ], "Second of the two emerald-trade artifacts - queue it after the Ender Artifact.");

  target("BAIT_RING", "Bait Ring", [
    gColl("INK_SACK", 8, "Ink Sac"), gMat(288, sackOf("ENCHANTED_INK_SACK"), "Enchanted Ink Sac"),
  ], "Fishing accessory - bait savings add up over thousands of casts.");

  if (slayerLvl("enderman") >= 2 && !ownedIds.has("SOULFLOW_SUPERCELL"))
    target(["SOULFLOW_PILE", "SOULFLOW_BATTERY"], "Soulflow Pile (→ Battery → Supercell)", [
      gSlayer("enderman", 2), gMat(90, sackOf("NULL_SPHERE"), "Null Sphere", "NULL_SPHERE"),
    ], "First step of the soulflow chain. Long-term the same soulflow economy also feeds the Overflux Capacitor power orb - orb before passive accessories when you must choose.");

  // --- locked-behind-slayer targets (listed so you can see the bottleneck) ---
  if (ownedIds.has("ZOMBIE_RING"))
    target("ZOMBIE_ARTIFACT", "Zombie Artifact", [
      gSlayer("zombie", 7), gBase("ZOMBIE_RING", "Zombie Ring"),
      gMat(48, sackOf("REVENANT_VISCERA"), "Revenant Viscera"),
      gMat(32, sackOf("ENCHANTED_IRON"), "Enchanted Iron"),
      gMat(16, sackOf("ENCHANTED_DIAMOND"), "Enchanted Diamond"),
    ], "The bottleneck is Zombie Slayer 7 - one level away. The viscera will come from those same T4 bosses.");

  if (ownedIds.has("SPIDER_RING"))
    target("SPIDER_ARTIFACT", "Spider Artifact", [
      gSlayer("spider", 6), gBase("SPIDER_RING", "Spider Ring"),
      gMat(32, sackOf("TARANTULA_SILK"), "Tarantula Silk"),
      gMat(32, sackOf("ENCHANTED_EMERALD"), "Enchanted Emerald", "ENCHANTED_EMERALD"),
    ], "Blocked by Spider Slayer 6 - one level away. Silk drops from the same bosses that level you.");

  target("TARANTULA_TALISMAN", "Tarantula Talisman", [
    gSlayer("spider", 6), gInfo("Drops from T3+ Tarantula bosses"),
  ], "Also gated behind Spider Slayer 6 - one push unlocks both spider accessories.");

  if (usableIds.has("ASPECT_OF_THE_END"))
    target("ASPECT_OF_THE_VOID", "Aspect of the Void", [
      gSlayer("enderman", 6), gBase("ASPECT_OF_THE_END", "Aspect of the End"),
      gMat(4096, sackOf("NULL_SPHERE"), "Null Sphere (as 32 Null Ovoids)", "NULL_SPHERE"),
      gMat(1024, sackOf("ENCHANTED_OBSIDIAN"), "Enchanted Obsidian"),
    ], "A long-term goal, not a quick craft: Enderman Slayer 6 gates the recipe and the Null Ovoid cost is steep. Your Voidgloom push works toward it automatically.");

  if (ownedIds.has("RED_CLAW_RING"))
    target("RED_CLAW_ARTIFACT", "Red Claw Artifact", [
      gSlayer("wolf", 5), gBase("RED_CLAW_RING", "Red Claw Ring"),
      gMat(64, sackOf("GOLDEN_TOOTH"), "Golden Tooth (drop from Sven T3+)"),
    ], "You cleared the Wolf Slayer 5 gate long ago - Golden Teeth are the remaining cost.",
    "the Wolf Ring - both compete for Golden Teeth; the artifact is the bigger Magical Power jump per tooth");

  if (ownedIds.has("TITANIUM_ARTIFACT"))
    target("TITANIUM_RELIC", "Titanium Relic", [
      gInfo(`HotM 5 required (your Peak of the Mountain: ${potm})`, potm >= 5),
      gBase("TITANIUM_ARTIFACT", "Titanium Artifact"),
      gMat(20, sackOf("REFINED_TITANIUM") + countItems("REFINED_TITANIUM"), "Refined Titanium (approx.)"),
    ], "Top of the titanium chain; your drill line is already done, so titanium has no better use.");

  if (usableIds.has("SWORD_OF_REVELATIONS"))
    target("DAEDALUS_AXE", "Daedalus Blade (Diana weapon)", [
      gBase("SWORD_OF_REVELATIONS", "Sword of Revelations"),
      gMat(2, sackOf("DAEDALUS_STICK") + countItems("DAEDALUS_STICK"), "Daedalus Stick (rare Minotaur drop)"),
      gMat(48, sackOf("ENCHANTED_GOLD_BLOCK"), "Enchanted Gold Block"),
      gInfo("Minotaurs need an Epic or better Griffin to spawn"),
    ], "The event weapon. Daedalus Sticks are a rare Minotaur drop - keep digging with an Epic+ Griffin.");

  target("JERRY_TALISMAN_GOLDEN", "Golden Jerry Talisman", [
    gBase("JERRY_TALISMAN_PURPLE", "Purple Jerry Talisman"),
    gMat(5, countItems("JERRY_TALISMAN_PURPLE"), "Purple Jerry Talisman copies"),
    gInfo("⏳ Only obtainable during Jerry's Workshop (winter)"),
  ], "Needs five Purple Jerry Talismans total - stack them up across Jerry's Workshop events.");

  target("TREASURE_RING", "Treasure Ring", [
    gBase("TREASURE_TALISMAN", "Treasure Talisman"),
    gMat(8, countItems("TREASURE_TALISMAN"), "Treasure Talisman copies (dungeon chest drops)"),
  ], "Eight Treasure Talismans fuse into the ring - a slow dungeon-chest collection that happens alongside your Catacombs push.");

  // ---- shared-resource budget: when total demand for a material exceeds
  // supply, allocate it to the most valuable crafts first and flag the rest
  for (const [resId, demands] of Object.entries(resourceDemand)) {
    if (demands.length < 2) continue;
    const supply = demands[0].have;
    const total = demands.reduce((a, d) => a + d.need, 0);
    if (total <= supply) continue; // enough for everything - no conflict
    const sorted = [...demands].sort((a, b) => a.rank - b.rank || statusRank[a.status] - statusRank[b.status] || a.order - b.order);
    let cum = 0;
    for (const d of sorted) {
      const covered = cum + d.need <= supply;
      cum += d.need;
      const others = sorted.filter((x) => x !== d).map((x) => `${x.name.split(" - ")[0]} (${n(x.need)})`).join(", ");
      const t = craftPriorities.find((c) => c.name === d.name);
      if (!t) continue;
      t.checks.push({
        label: `${nice(resId)} is a shared pool - also wanted by: ${others}. Total demand ${n(total)} vs your ${n(supply)}.${covered ? " This craft is within budget (higher priority takes first)." : " Short after higher-priority crafts claim theirs - gather more or skip the lower-value use."}`,
        ok: covered, warn: true,
      });
      if (!covered && t.status === "ready") t.status = "gather";
    }
  }

  craftPriorities.sort((a, b) => statusRank[a.status] - statusRank[b.status]);

  for (const c of craftPriorities) {
    if (c.status === "ready") {
      rec(2, "Crafting", `Craft now: ${c.name} - all requirements met`, c.why, 'Every gate and material is checked green - see "What to Craft First".');
    }
  }

  // annotate the accessory tracker with the same verified gates
  const TARGET_GATES = {
    ZOMBIE_ARTIFACT: gSlayer("zombie", 7), SPIDER_ARTIFACT: gSlayer("spider", 6),
    RED_CLAW_ARTIFACT: gSlayer("wolf", 5), SEA_CREATURE_ARTIFACT: gColl("SPONGE", 8, "Sponge"),
    SPEED_ARTIFACT: gColl("SUGAR_CANE", 8, "Sugar Cane"), POWER_ARTIFACT: gColl("GEMSTONE_COLLECTION", 10, "Gemstone"),
    TITANIUM_RELIC: gInfo("HotM 5", potm >= 5), TREASURE_RING: gInfo("8x Treasure Talisman", countItems("TREASURE_TALISMAN") >= 8),
    JERRY_TALISMAN_GOLDEN: gInfo("5x Purple Jerry Talisman", countItems("JERRY_TALISMAN_PURPLE") >= 5),
    SOULFLOW_BATTERY: gSlayer("enderman", 5), SOULFLOW_SUPERCELL: gSlayer("enderman", 7), // wiki table levels; NEU's EMAN_2 on these is wrong
  };
  // some upgrades are only purchasable while a seasonal event runs (verified:
  // the Fear Mongerer sells the Intimidation/Bat/Candy chains during Spooky)
  const EVENT_GATED = {
    INTIMIDATION_RING: "Spooky Festival (Fear Mongerer)", INTIMIDATION_ARTIFACT: "Spooky Festival (Fear Mongerer)",
    BAT_RING: "Spooky Festival (Fear Mongerer)", BAT_ARTIFACT: "Spooky Festival (Fear Mongerer)",
    CANDY_RING: "Spooky Festival (Fear Mongerer)", CANDY_ARTIFACT: "Spooky Festival (Fear Mongerer)", CANDY_RELIC: "Spooky Festival (Fear Mongerer)",
    JERRY_TALISMAN_BLUE: "Jerry's Workshop (winter)", JERRY_TALISMAN_PURPLE: "Jerry's Workshop (winter)", JERRY_TALISMAN_GOLDEN: "Jerry's Workshop (winter)",
    BAT_PERSON_RING: "Spooky season (Ectoplasm/Spooky Shard materials)", BAT_PERSON_ARTIFACT: "Spooky season (Ectoplasm/Spooky Shard materials)",
    GREAT_SPOOK_ARTIFACT: "Great Spook event",
  };
  for (const u of accUpgrades) {
    const g = TARGET_GATES[u.nextId];
    if (g) { u.requires = g.label; u.blocked = !g.ok; }
    if (EVENT_GATED[u.nextId]) u.event = EVENT_GATED[u.nextId];
    if (RECIPE_MATS[u.nextId]) {
      u.mats = RECIPE_MATS[u.nextId].map(([mid, need]) => ({ name: nice(mid), need, have: matHave(mid), ok: matHave(mid) >= need }));
    }
  }

  // ---- fold tracker results into recommendations ----
  if (accUpgrades.length) {
    rec(2, "Accessories", `${accUpgrades.length} accessory upgrade(s) ready to work on`,
      "You own the lower tier of these accessory chains - upgrading is the cheapest Magical Power available to you.",
      `See the Accessory Tracker section: ${accUpgrades.slice(0, 3).map((u) => u.have + " → " + u.next).join(", ")}${accUpgrades.length > 3 ? ", …" : ""}.`);
  }
  if (accMissing.length) {
    rec(3, "Accessories", `${accMissing.length} notable accessory(ies) you don't own yet`,
      "All of these are Ironman-obtainable and listed with their source in the Accessory Tracker section.",
      `Easiest first: ${accMissing.slice(0, 3).map((m) => m.name).join(", ")}${accMissing.length > 3 ? ", …" : ""}.`);
  }
  if (hoeUpgrades.length) {
    rec(3, "Gear", `${hoeUpgrades.length} farming tool(s) below max tier`,
      "Tier 3 tools give a big Farming Fortune / drops jump and are pure collection crafts.",
      hoeUpgrades.join("; ") + ".");
  }
  if (housekeeping.length) {
    rec(3, "Gear", `${housekeeping.length} storage housekeeping item(s)`,
      "Small free wins found while scanning your storage.",
      "See the list at the bottom of the Gear by Activity section.");
  }

  // ---------------- sort recommendations ----------------
  const catOrder = { Setup: 0, Skills: 1, Slayers: 2, Dungeons: 3, Gear: 4, Crafting: 5, Accessories: 6, Pets: 7, Minions: 8, Events: 9 };
  recs.sort((a, b) => a.priority - b.priority || (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9));

  // =================================================================
  // OUTPUT
  // =================================================================

  const slim = (it) => ({
    skyblockId: it.skyblockId,
    name: it.name,
    lore: it.lore || [],
    enchantments: it.enchantments || null,
    reforge: it.attributes?.modifier || null,
    recombobulated: it.attributes?.rarity_upgrades === "1",
    hotPotato: Number(it.attributes?.hot_potato_count || 0),
    gems: it.gems || null,
    rarity: itemRarity(it),
  });

  const updateAvailable = await updatePromise;
  if (updateAvailable) console.log(`\nUpdate available: v${updateAvailable.current} → v${updateAvailable.latest} (${updateAvailable.url})`);

  // full accessory collection from the NEU-derived family database
  let accessoryCollection = null;
  try {
    const adb = JSON.parse(fs.readFileSync(path.join(HERE, "accessory-db.json"), "utf8"));
    const families = adb.families.map((ids) => {
      const stages = ids.map((id) => ({ id, name: adb.info[id]?.n || nice(id), req: adb.info[id]?.q || "", owned: ownedIds.has(id) }));
      return { stages, started: stages.some((s) => s.owned), complete: stages[stages.length - 1].owned };
    });
    accessoryCollection = {
      familiesOwned: families.filter((f) => f.started).length,
      familiesTotal: families.length,
      stagesOwned: families.reduce((a, f) => a + f.stages.filter((s) => s.owned).length, 0),
      stagesTotal: families.reduce((a, f) => a + f.stages.length, 0),
      families,
    };
  } catch { /* accessory-db.json missing - section simply won't render */ }

  const data = {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    updateAvailable,
    player: {
      username: account.name || username,
      uuid: account.id,
      face: account.skin?.face || null,
      profileName: profile.profileName,
      gameMode: profile.gameMode || "normal",
      selected: !!profile.selected,
    },
    warnings,
    api,
    overview: {
      skyblockXp: member.skyblockXp ?? null,
      skillAverage,
      purse: member.purse ?? null,
      bankBalance: member.bankBalance ?? null,
      networth,
      magicalPower: mp,
      selectedPower: acc.selectedPower || null,
    },
    skills,
    slayers: Object.fromEntries(
      ["zombie", "spider", "wolf", "enderman", "blaze", "vampire"].map((k) => {
        const v = slayerBosses[k] || {};
        return [k, {
          level: v.level ?? 0, maxLevel: v.maxLevel ?? 9, xp: v.xp ?? 0, xpForNext: v.xpForNext ?? null, progress: v.progress ?? 0,
          locked: !slayerUnlocked(k), unlock: slayerLockText(k),
        }];
      })
    ),
    slayerTotalXp: member.stats?.slayer?.totalXp ?? 0,
    dungeons: {
      catacombsLevel: dungeons.catacombsLevel ?? 0,
      catacombsProgress: dungeons.catacombsProgress ?? 0,
      selectedClass: dungeons.selectedClass || null,
      secretsFound: dungeons.secretsFound ?? 0,
      classAverage: dungeons.classAverage ?? 0,
      classLevels: Object.fromEntries(Object.entries(dungeons.classLevels || {}).map(([k, v]) => [k, { level: v.level, progress: v.progress }])),
    },
    gear: {
      armor: armorItems.map(slim),
      equipment: equipItems.map(slim),
      wardrobePieces: itemsOf(invs.wardrobe).length,
    },
    accessories: {
      magicalPower: mp,
      selectedPower: acc.selectedPower || null,
      unlockedPowers: acc.unlockedPowers || [],
      count: accessoryItems.length,
      recombobulated: accessoryItems.filter((i) => i.attributes?.rarity_upgrades === "1").length,
      enriched: accessoryItems.filter((i) => i.attributes?.talisman_enrichment).length,
      byRarity: accessoryItems.reduce((m, i) => { const r = itemRarity(i) || "UNKNOWN"; m[r] = (m[r] || 0) + 1; return m; }, {}),
      items: accessoryItems.map((i) => ({ skyblockId: i.skyblockId, name: i.name, rarity: itemRarity(i), recombobulated: i.attributes?.rarity_upgrades === "1" })),
    },
    pets: {
      summary: {
        total: petSummary.totalPets ?? pets.length,
        maxLevel: petSummary.maxLevelPets ?? 0,
        active,
      },
      list: pets
        .map((p) => ({ type: p.type, tier: p.tier, level: p.level, maxLevel: p.maxLevel, active: p.active, heldItem: p.heldItem, progress: p.progress }))
        .sort((a, b) => b.level - a.level || (a.type < b.type ? -1 : 1)),
    },
    minions: minions,
    gearReview: {
      activities: [
        { key: "combat", label: "Combat & Dungeons", sets: setsByActivity.combat || [], tools: tools.combat },
        { key: "mining", label: "Mining", sets: setsByActivity.mining || [], tools: tools.mining },
        { key: "farming", label: "Farming", sets: setsByActivity.farming || [], tools: tools.farming },
        { key: "fishing", label: "Fishing", sets: setsByActivity.fishing || [], tools: tools.fishing },
        { key: "foraging", label: "Foraging & Hunting", sets: setsByActivity.foraging || [], tools: tools.foraging },
        { key: "other", label: "Other / Event", sets: setsByActivity.other || [], tools: [] },
      ],
      housekeeping,
    },
    accessoryTracker: {
      upgrades: accUpgrades,
      missing: accMissing,
    },
    accessoryCollection,
    events,
    mayorInfo,
    sbToday,
    slayerLoadouts: slayerLoadouts.map((L) => {
      const itemFor = (id) => (fullItemById[id] ? slim(fullItemById[id]) : { skyblockId: id, name: nice(id), lore: [] });
      return {
        ...L,
        weapon: L.weaponId ? itemFor(L.weaponId) : null,
        armorPieces: L.armor ? L.armor.pieceIds.map(itemFor) : [],
        equipment: L.equipment.map((e) => ({ slot: e.slot, item: itemFor(e.id) })),
      };
    }),
    skillLoadouts: skillLoadouts.map((S) => {
      const itemFor = (id) => (fullItemById[id] ? slim(fullItemById[id]) : { skyblockId: id, name: nice(id), lore: [] });
      return {
        ...S,
        tool: S.toolId ? itemFor(S.toolId) : null,
        armorPieces: S.armor ? S.armor.pieceIds.map(itemFor) : [],
        equipment: S.equipment.map((e) => ({ slot: e.slot, item: itemFor(e.id) })),
      };
    }),
    craftPriorities,
    recommendations: recs,
    error: null,
  };

  const out = "window.DASHBOARD_DATA = " + JSON.stringify(data, null, 1) + ";\n";
  fs.writeFileSync(path.join(HERE, "data.js"), out, "utf8");

  console.log(`\nDone. ${recs.length} recommendations generated (${recs.filter((r) => r.priority === 1).length} high priority).`);
  console.log("Open dashboard.html to view your dashboard.");
}

function writeError(title, detail) {
  const data = { generatedAt: new Date().toISOString(), error: { title, detail } };
  fs.writeFileSync(path.join(HERE, "data.js"), "window.DASHBOARD_DATA = " + JSON.stringify(data, null, 1) + ";\n", "utf8");
  console.error(`\nERROR: ${title}\n${detail}`);
}

main().catch((err) => {
  writeError("Unexpected error while fetching data", String(err && err.message ? err.message : err));
  process.exitCode = 1;
});
