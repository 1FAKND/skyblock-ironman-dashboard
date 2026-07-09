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

const API = "https://api.elitebot.dev";
const HERE = __dirname;
const UA = "SkyBlock-Ironman-Dashboard/1.0 (personal local dashboard)";

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

function stripColors(s) {
  return (s || "").replace(/§./g, "");
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

  // ---- inventories we analyze (all storage, so gear analysis sees everything)
  const wantInv = (n) => /^(armor|equipment|wardrobe|talisman_bag|inventory|ender_chest|fishing_bag|farming_toolkit|hunting_toolkit|museum|backpack_\d+)$/.test(n);
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
      rec(pr, "Slayers", `${boss[0].toUpperCase() + boss.slice(1)} Slayer ${lvl} → ${meta.target}`,
        `Level ${meta.target} unlocks ${meta.unlock}.`,
        "Do the highest tier you can complete in ~2-3 minutes reliably; on Ironman the RNG drops along the way are half the reward.");
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
        "Your equipped set isn't one this dashboard recognizes (likely newer content, e.g. Hunting-update gear) - so no armor-ladder advice this refresh.",
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
  const nice = (id) => id.toLowerCase().split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

  // ---- accessory upgrade chains (lowest → highest tier) ----
  const ACCESSORY_CHAINS = [
    { chain: ["ZOMBIE_TALISMAN", "ZOMBIE_RING", "ZOMBIE_ARTIFACT"], note: "Revenant slayer materials" },
    { chain: ["SPIDER_TALISMAN", "SPIDER_RING", "SPIDER_ARTIFACT"], note: "Tarantula slayer materials" },
    { chain: ["RED_CLAW_TALISMAN", "RED_CLAW_RING", "RED_CLAW_ARTIFACT"], note: "Sven slayer materials" },
    { chain: ["SEA_CREATURE_TALISMAN", "SEA_CREATURE_RING", "SEA_CREATURE_ARTIFACT"], note: "fishing materials" },
    { chain: ["INTIMIDATION_TALISMAN", "INTIMIDATION_RING", "INTIMIDATION_ARTIFACT"], note: "cheap combat craft" },
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
    [/^(CHALLENGER|SILVER_HUNTER|FIG|CANOPY|MANGROVE|MOSS)/, "foraging"],
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
  const KATANAS = ["VOIDEDGE_KATANA", "VOIDWALKER_KATANA", "VORPAL_KATANA", "ATOMSPLIT_KATANA"];
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
  // EVENTS (Diana, Jacob, Hoppity, Spooky, Winter)
  // =================================================================

  const playerStats = member.stats?.playerStats || {};
  const events = [];
  const TIER_ORDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];

  // ---- Mythological Ritual (Diana) ----
  {
    const my = playerStats.mythos || {};
    const griffin = petByType["GRIFFIN"] || null;
    const kills = [
      ["Minos Hunter", my.killsMinosHunter], ["Siamese Lynx", my.killsSiameseLynx],
      ["Gaia Construct", my.killsGaiaConstruct], ["Minotaur", my.killsMinotaur],
      ["Minos Champion", my.killsMinosChampion], ["Minos Inquisitor", my.killsMinosInquisitor],
    ].map(([k, v]) => [k, v ?? 0]);
    const DIANA_ITEMS = { DAEDALUS_AXE: "Daedalus Axe", ANCESTRAL_SPADE: "Ancestral Spade", ANTIQUE_REMEDIES: "Antique Remedies", DWARF_TURTLE_SHELMET: "Dwarf Turtle Shelmet", CROCHET_TIGER_PLUSHIE: "Crochet Tiger Plushie", MINOS_RELIC: "Minos Relic", GRIFFIN_FEATHER: "Griffin Feather(s)", ANCIENT_CLAW: "Ancient Claw(s)", ENCHANTED_ANCIENT_CLAW: "Enchanted Ancient Claw(s)" };
    const haveItems = Object.entries(DIANA_ITEMS).filter(([id]) => ownedIds.has(id)).map(([, label]) => label);
    const todo = [];
    const gTier = griffin ? TIER_ORDER.indexOf(griffin.tier) : -1;
    if (!griffin) {
      todo.push({ pr: 1, text: "Get a Griffin pet - it's the heart of the whole event (burrow quality scales with its rarity)." });
    } else if (gTier < TIER_ORDER.indexOf("LEGENDARY")) {
      const unlocks = gTier < TIER_ORDER.indexOf("EPIC") ? "Epic unlocks Minos Champions; Legendary unlocks Minos Inquisitors (the Chimera book source)" : "Legendary unlocks Minos Inquisitors - the Chimera book source";
      todo.push({ pr: 1, text: `Upgrade your ${griffin.tier[0] + griffin.tier.slice(1).toLowerCase()} Griffin - ${unlocks}. Griffin Feathers (and any upgrade stones you have banked) are the materials.` });
    }
    if ((my.killsMinosInquisitor ?? 0) === 0 && (my.burrowsDugNext?.total ?? 0) > 100) {
      todo.push({ pr: 2, text: "You've never killed a Minos Inquisitor - they drop Chimera books and top-tier Diana loot, and only appear with a Legendary Griffin." });
    }
    if (!ownedIds.has("DAEDALUS_AXE") && (my.burrowsDugNext?.total ?? 0) > 0) {
      todo.push({ pr: 2, text: "Work toward a Daedalus Axe - the event's dedicated weapon; materials come from higher-tier mythological creatures." });
    }
    const missingPetItems = ["DWARF_TURTLE_SHELMET", "CROCHET_TIGER_PLUSHIE", "MINOS_RELIC"].filter((id) => !ownedIds.has(id));
    if (missingPetItems.length && (my.burrowsDugNext?.total ?? 0) > 0) {
      todo.push({ pr: 3, text: `Diana-exclusive pet items you're missing: ${missingPetItems.map((id) => DIANA_ITEMS[id]).join(", ")} - all drop from event mobs/burrows.` });
    }
    events.push({
      name: "Mythological Ritual (Diana)",
      active: "Runs while Diana is mayor - burrow hunting on the Hub island",
      stats: [
        ["Griffin pet", griffin ? `${griffin.tier[0] + griffin.tier.slice(1).toLowerCase()} lvl ${griffin.level}` : "none"],
        ["Burrows dug", (my.burrowsDugNext?.total ?? 0).toLocaleString("en-US")],
        ["Treasure burrows", (my.burrowsDugTreasure?.total ?? 0).toLocaleString("en-US")],
        ...kills.map(([k, v]) => [k + " kills", v.toLocaleString("en-US")]),
      ],
      have: haveItems,
      todo,
    });
  }

  // ---- Jacob's Farming Contests ----
  {
    const j = member.jacob || {};
    const med = j.medals || {}, earned = j.earnedMedals || {}, perks = j.perks || {};
    const todo = [];
    if (perks.personalBests === false && (earned.gold ?? 0) > 0) {
      todo.push({ pr: 2, text: "Unlock the Personal Bests perk in Anita's shop - you have unspent gold medals and it's a permanent buff." });
    }
    if ((perks.doubleDrops ?? 0) < 15) {
      todo.push({ pr: 2, text: `Double Drops perk is ${perks.doubleDrops ?? 0}/15 - spend gold medals at Anita to max it (+${(15 - (perks.doubleDrops ?? 0)) * 2}% more crop drops available).` });
    }
    if ((med.bronze ?? 0) + (med.silver ?? 0) + (med.gold ?? 0) > 10) {
      todo.push({ pr: 3, text: `You're sitting on ${med.bronze ?? 0} bronze / ${med.silver ?? 0} silver / ${med.gold ?? 0} gold unspent medals - browse Anita's shop.` });
    }
    events.push({
      name: "Jacob's Farming Contests",
      active: "Every 3 SkyBlock days, year-round",
      stats: [
        ["Contests entered", (j.participations ?? 0).toLocaleString("en-US")],
        ["Gold medals earned", (earned.gold ?? 0) + (earned.platinum ?? 0) + (earned.diamond ?? 0)],
        ["Diamond medals", earned.diamond ?? 0],
        ["Unspent medals", `${med.bronze ?? 0}🥉 ${med.silver ?? 0}🥈 ${med.gold ?? 0}🥇`],
        ["Double Drops perk", `${perks.doubleDrops ?? 0}/15`],
        ["Farming level cap bought", `+${perks.levelCap ?? 0}`],
      ],
      have: [],
      todo,
    });
  }

  // ---- Hoppity's Hunt (Chocolate Factory) ----
  if (member.chocolateFactory && (member.chocolateFactory.totalChocolate ?? 0) > 0) {
    const c = member.chocolateFactory;
    const u = c.uniqueRabbits || {};
    const uniques = Object.values(u).reduce((a, b) => a + (b || 0), 0);
    const todo = [];
    if (!c.unlockedZorro) todo.push({ pr: 3, text: "Zorro is still locked - it requires progress on the rarest rabbit tiers." });
    if ((u.divine ?? 0) === 0) todo.push({ pr: 3, text: "No Divine rabbits yet - keep hunting eggs each Hoppity's Hunt for the rarest tier." });
    events.push({
      name: "Hoppity's Hunt (Chocolate Factory)",
      active: "Seasonal (SkyBlock spring) - factory produces year-round",
      stats: [
        ["Prestige", c.prestige ?? 0],
        ["All-time chocolate", c.totalChocolate >= 1e9 ? (c.totalChocolate / 1e9).toFixed(1) + "B" : Math.round(c.totalChocolate).toLocaleString("en-US")],
        ["Unique rabbits", uniques],
        ["Mythic / Divine rabbits", `${u.mythic ?? 0} / ${u.divine ?? 0}`],
        ["Zorro unlocked", c.unlockedZorro ? "yes" : "no"],
      ],
      have: [],
      todo,
    });
  }

  // ---- Spooky Festival ----
  {
    const candyIdx = ["CANDY_TALISMAN", "CANDY_RING", "CANDY_ARTIFACT", "CANDY_RELIC"].reduce((b, id, i) => (ownedIds.has(id) ? i : b), -1);
    const batIdx = ["BAT_TALISMAN", "BAT_RING", "BAT_ARTIFACT"].reduce((b, id, i) => (ownedIds.has(id) ? i : b), -1);
    const spookSet = ["GREAT_SPOOK_HELMET", "GREAT_SPOOK_CHESTPLATE", "GREAT_SPOOK_LEGGINGS", "GREAT_SPOOK_BOOTS"].filter((id) => ownedIds.has(id)).length;
    const have = [];
    if (spookSet) have.push(`Great Spook armor (${spookSet}/4)`);
    if (candyIdx >= 0) have.push(nice(["CANDY_TALISMAN", "CANDY_RING", "CANDY_ARTIFACT", "CANDY_RELIC"][candyIdx]));
    if (batIdx >= 0) have.push(nice(["BAT_TALISMAN", "BAT_RING", "BAT_ARTIFACT"][batIdx]));
    const todo = [];
    if (candyIdx >= 0 && candyIdx < 3) todo.push({ pr: 3, text: "Upgrade your candy accessory with Purple Candy during the next Spooky Festival." });
    if (batIdx >= 0 && batIdx < 2) todo.push({ pr: 3, text: "Upgrade your bat accessory - Spooky Festival bat drops." });
    if (spookSet > 0 && spookSet < 4) todo.push({ pr: 3, text: `Complete the Great Spook set (${spookSet}/4) during the Great Spook (spooky season).` });
    events.push({
      name: "Spooky Festival",
      active: "Seasonal (SkyBlock autumn)",
      stats: [["Bats spawned (lifetime)", playerStats.spooky?.bats_spawned?.total ?? 0]],
      have,
      todo,
    });
  }

  // ---- Jerry's Workshop (Winter) ----
  {
    const jerryIdx = ["JERRY_TALISMAN_GREEN", "JERRY_TALISMAN_BLUE", "JERRY_TALISMAN_PURPLE", "JERRY_TALISMAN_GOLDEN"].reduce((b, id, i) => (ownedIds.has(id) ? i : b), -1);
    const yeti = petByType["BABY_YETI"] || null;
    const have = [];
    if (jerryIdx >= 0) have.push(nice(["JERRY_TALISMAN_GREEN", "JERRY_TALISMAN_BLUE", "JERRY_TALISMAN_PURPLE", "JERRY_TALISMAN_GOLDEN"][jerryIdx]));
    if (yeti) have.push(`Baby Yeti pet (${yeti.tier[0] + yeti.tier.slice(1).toLowerCase()} lvl ${yeti.level})`);
    const todo = [];
    if (jerryIdx >= 0 && jerryIdx < 3) todo.push({ pr: 3, text: "Upgrade your Jerry talisman during Jerry's Workshop (last SkyBlock month of the year)." });
    if (!yeti) todo.push({ pr: 3, text: "Fish up a Baby Yeti pet in the Jerry pond - strong fishing pet, only available during winter." });
    events.push({
      name: "Jerry's Workshop (Winter)",
      active: "Seasonal (SkyBlock winter)",
      stats: [
        ["Gifts given", (playerStats.gifts?.given ?? 0).toLocaleString("en-US")],
        ["Gifts received", (playerStats.gifts?.received ?? 0).toLocaleString("en-US")],
      ],
      have,
      todo,
    });
  }

  // fold the strongest event to-dos into the main recommendation list (max MEDIUM - events are periodic)
  for (const ev of events) {
    for (const t of ev.todo) {
      if (t.pr <= 2) rec(2, "Events", `${ev.name.split(" (")[0]}: ${t.text.split(" - ")[0]}`, t.text, "See the Events section for details.");
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

  const sacks = member.sacks || {};
  const sackOf = (id) => sacks[id] ?? 0;
  const n = (x) => Math.round(x).toLocaleString("en-US");
  const collTier = (name) => member.collectionTiers?.[name] ?? 0;
  const slayerLvl = (b) => slayerBosses[b]?.level ?? 0;
  const countItems = (id) => allItems.filter((i) => i.id === id && i.container !== "museum").length;
  const potm = member.stats?.mining?.peakOfTheMountainLevel ?? 0;

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
    target("DAEDALUS_AXE", "Daedalus Axe (Diana weapon)", [
      gBase("SWORD_OF_REVELATIONS", "Sword of Revelations"),
      gMat(2, countItems("DAEDALUS_STICK"), "Daedalus Stick (drops from Minos Champions/Inquisitors)"),
      gMat(48, sackOf("ENCHANTED_GOLD_BLOCK"), "Enchanted Gold Block"),
      gInfo("Champions/Inquisitors need an Epic/Legendary Griffin to spawn"),
    ], "The event weapon. Its real bottleneck is your Griffin rarity - upgrade the pet first and the sticks follow.");

  target("JERRY_TALISMAN_GOLDEN", "Golden Jerry Talisman", [
    gBase("JERRY_TALISMAN_PURPLE", "Purple Jerry Talisman"),
    gMat(5, countItems("JERRY_TALISMAN_PURPLE"), "Purple Jerry Talisman copies"),
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
    SOULFLOW_BATTERY: gSlayer("enderman", 2), SOULFLOW_SUPERCELL: gSlayer("enderman", 2),
  };
  for (const u of accUpgrades) {
    const g = TARGET_GATES[u.nextId];
    if (g) { u.requires = g.label; u.blocked = !g.ok; }
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

  const data = {
    generatedAt: new Date().toISOString(),
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
      Object.entries(slayerBosses).map(([k, v]) => [k, { level: v.level, maxLevel: v.maxLevel, xp: v.xp, xpForNext: v.xpForNext, progress: v.progress }])
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
    events,
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
