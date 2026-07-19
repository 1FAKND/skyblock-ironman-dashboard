// Generates accessory-db.json from NEU talisman_upgrades + per-item reqs
const fs = require("fs");
const misc = require(process.argv[2]);
const OUT = process.argv[3];

(async () => {
  const up = misc.talisman_upgrades; // { id: [nextIds] }
  const allIds = new Set();
  for (const [k, v] of Object.entries(up)) { allIds.add(k); v.forEach((x) => allIds.add(x)); }
  // roots = ids never appearing as an upgrade target
  const targets = new Set(Object.values(up).flat());
  const roots = [...allIds].filter((id) => !targets.has(id));
  // walk chains (follow first upgrade path; branches noted)
  const families = [];
  for (const root of roots) {
    const stages = [root];
    let cur = root;
    const seen = new Set([root]);
    while (up[cur] && up[cur].length) {
      const next = up[cur][0];
      if (seen.has(next)) break;
      stages.push(next); seen.add(next); cur = next;
    }
    families.push(stages);
  }
  // fetch name + req per id in parallel batches
  const ids = [...allIds];
  const info = {};
  const fetchOne = async (id) => {
    try {
      const r = await fetch("https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items/" + encodeURIComponent(id) + ".json");
      if (!r.ok) { info[id] = { n: id, q: "" }; return; }
      const j = await r.json();
      const name = (j.displayname || id).replace(/§./g, "");
      let req = j.crafttext || "";
      if (!req && j.slayer_req) req = j.slayer_req.replace("EMAN", "Eman Slayer").replace(/^(ZOMBIE|SPIDER|WOLF|BLAZE)_(\d)/, "$1 Slayer $2");
      if (!req) { const lore = (j.lore || []).map((l) => l.replace(/§./g, "")); const rl = lore.find((l) => /Requires/i.test(l)); if (rl) req = rl.trim(); }
      info[id] = { n: name, q: req.replace(/^Requires:?\s*/i, "").trim() };
    } catch { info[id] = { n: id, q: "" }; }
  };
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map(fetchOne));
    process.stdout.write(".");
  }
  families.sort((a, b) => (info[a[0]]?.n || a[0]).localeCompare(info[b[0]]?.n || b[0]));
  const db = { generated: new Date().toISOString().slice(0, 10), source: "NEU repo talisman_upgrades", families, info };
  fs.writeFileSync(OUT, JSON.stringify(db));
  console.log("\nfamilies:", families.length, "| ids:", ids.length, "->", OUT);
})();
