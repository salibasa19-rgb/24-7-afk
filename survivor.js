"use strict";
// NØVA "real player" brain: no owner needed. Chops trees, crafts tools, builds a house with a door,
// mines stone, hunts food, fights mobs, hides/sleeps at night and wanders around - forever.

const fs = require("fs");
const path = require("path");
const { Vec3 } = require("vec3");

const PROGRESS_FILE = path.join(__dirname, "progress.json");
const BUILD_ITEMS_PRIORITY = ["_planks", "cobblestone", "stone_bricks", "bricks", "stone", "cobbled_deepslate"];
const SOFT_BLOCKS = ["air", "cave_air", "void_air", "short_grass", "grass", "tall_grass", "fern", "snow", "dead_bush"];
const STONE_NAMES = ["stone", "cobblestone", "andesite", "diorite", "granite"];
const FOOD_ANIMALS = ["cow", "pig", "chicken", "sheep", "rabbit"];
const BAD_FOOD = ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chorus_fruit", "golden_apple", "enchanted_golden_apple"];
const JUNK = ["cobblestone", "dirt", "gravel", "andesite", "diorite", "granite", "cobbled_deepslate", "flint", "rotten_flesh", "spider_eye", "sand", "tuff"];
const TIERS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function planHouse(x0, y0, z0, size, height) {
  const walls = [];
  const doorX = x0 + Math.floor(size / 2);
  const doorZ = z0 + size - 1;
  for (let dy = 0; dy < height; dy++)
    for (let x = 0; x < size; x++)
      for (let z = 0; z < size; z++) {
        if (!(x === 0 || z === 0 || x === size - 1 || z === size - 1)) continue;
        const wx = x0 + x, wz = z0 + z;
        if (dy < 2 && wx === doorX && wz === doorZ) continue;
        walls.push(new Vec3(wx, y0 + dy, wz));
      }
  const roof = [];
  for (let x = 0; x < size; x++)
    for (let z = 0; z < size; z++)
      roof.push({ p: new Vec3(x0 + x, y0 + height, z0 + z), d: Math.min(x, z, size - 1 - x, size - 1 - z) });
  roof.sort((a, b) => a.d - b.d);
  return { blocks: walls.concat(roof.map((r) => r.p)), doorPos: new Vec3(doorX, y0, doorZ) };
}

function setupSurvivor({ bot, mcData, defaultMove, config, addLog, goals }) {
  const cfg = config.player || {};
  const size = Math.max(5, (cfg.house && cfg.house.size) || 5) | 1;
  const height = (cfg.house && cfg.house.wallHeight) || 3;
  const wanderRadius = cfg.wanderRadius || 30;

  let ended = false;
  bot.once("end", () => (ended = true));
  const alive = () => !ended && bot.entity;
  const guard = () => { if (!alive()) throw new Error("cancelled"); };

  // ---------- saved progress (survives reconnects/restarts) ----------
  let prog = { done: {}, home: null };
  try { prog = Object.assign(prog, JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"))); } catch (_) {}
  const save = () => { try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(prog)); } catch (_) {} };
  const home = () => (prog.home ? new Vec3(prog.home.x, prog.home.y, prog.home.z) : null);

  // ---------- basic helpers ----------
  const isSolid = (b) => b && b.boundingBox === "block";
  const isSoft = (b) => !b || SOFT_BLOCKS.includes(b.name);
  const invCount = (pred) => bot.inventory.items().filter(pred).reduce((s, i) => s + i.count, 0);
  const hasItem = (pred) => bot.inventory.items().some(pred);

  async function goto(goal, timeoutMs = 25000) {
    bot.pathfinder.setMovements(defaultMove);
    let timer;
    const timeout = new Promise((_, rej) => (timer = setTimeout(() => { try { bot.pathfinder.stop(); } catch (_) {} rej(new Error("path timeout")); }, timeoutMs)));
    try { await Promise.race([bot.pathfinder.goto(goal), timeout]); } finally { clearTimeout(timer); }
  }

  async function equipTool(kind) {
    for (const tier of TIERS) {
      const it = bot.inventory.items().find((i) => i.name === `${tier}_${kind}`);
      if (it) { try { await bot.equip(it, "hand"); } catch (_) {} return true; }
    }
    return false;
  }

  function bestBuildItem() {
    let best = null;
    for (const key of BUILD_ITEMS_PRIORITY)
      for (const it of bot.inventory.items().filter((i) => (key.startsWith("_") ? i.name.endsWith(key) : i.name === key))) {
        const total = invCount((i) => i.name === it.name);
        if (!best || total > best.total) best = { name: it.name, total };
      }
    return best;
  }

  async function tidyInventory() {
    for (const it of bot.inventory.items()) {
      if (JUNK.includes(it.name)) {
        const total = invCount((i) => i.name === it.name);
        if (total > 64) { try { await bot.toss(it.type, null, Math.min(it.count, total - 64)); } catch (_) {} }
      }
    }
  }

  // ---------- gathering ----------
  async function collect(matchFn, amount, toolKind, label, exposedOnly = false) {
    let got = 0, fails = 0, relocates = 0;
    const bad = new Set();
    const exposed = (p) => [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]].some(([x,y,z]) => isSoft(bot.blockAt(p.offset(x, y, z))));
    while (got < amount && fails < 12) {
      guard();
      const found = bot.findBlocks({ matching: (b) => matchFn(b), maxDistance: 48, count: 40 })
        .filter((p) => !bad.has(p.toString()) && (!exposedOnly || exposed(p)))
        .sort((a, b) => (label === "log" ? a.y - b.y : 0) || bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
      if (!found.length) {
        if (++relocates > 4) return got;
        await wander(35).catch(() => {});
        continue;
      }
      const p = found[0];
      try {
        await goto(new goals.GoalNear(p.x, p.y, p.z, 2));
        const block = bot.blockAt(p);
        if (!block || !matchFn(block)) continue;
        if (!bot.canDigBlock(block)) { bad.add(p.toString()); fails++; continue; }
        if (toolKind) await equipTool(toolKind);
        await bot.dig(block);
        got++;
        await goto(new goals.GoalNear(p.x, p.y, p.z, 1), 8000).catch(() => {});
        await sleep(200);
      } catch (e) {
        if (e.message === "cancelled") throw e;
        bad.add(p.toString()); fails++;
      }
    }
    return got;
  }
  const chop = (n) => collect((b) => b && b.name.endsWith("_log"), n, "axe", "log");
  const mineStone = (n) => collect((b) => b && STONE_NAMES.includes(b.name), n, "pickaxe", "stone", true);

  async function wander(radius = wanderRadius) {
    const base = home() || bot.entity.position;
    const x = Math.floor(base.x + rnd(-radius, radius)), z = Math.floor(base.z + rnd(-radius, radius));
    await goto(new goals.GoalXZ(x, z), 30000);
  }

  // ---------- crafting ----------
  async function craftPlanks() {
    for (const it of bot.inventory.items().filter((i) => i.name.endsWith("_log"))) {
      const planks = mcData.itemsByName[it.name.replace("_log", "_planks")];
      const r = planks && bot.recipesFor(planks.id, null, 1, null)[0];
      if (r) { try { await bot.craft(r, it.count, null); } catch (_) {} }
    }
  }

  async function ensureTable() {
    const tableId = mcData.blocksByName.crafting_table.id;
    let t = bot.findBlock({ matching: tableId, maxDistance: 24 });
    if (!t) {
      if (!hasItem((i) => i.name === "crafting_table")) {
        await craftPlanks();
        const it = mcData.itemsByName.crafting_table;
        const r = bot.recipesFor(it.id, null, 1, null)[0];
        if (!r) return null;
        await bot.craft(r, 1, null);
      }
      const feet = bot.entity.position.floored();
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const pos = feet.offset(dx, 0, dz);
        if (isSoft(bot.blockAt(pos)) && isSolid(bot.blockAt(pos.offset(0, -1, 0)))) {
          if (await placeBlockAt(pos, "crafting_table")) break;
        }
      }
      t = bot.findBlock({ matching: tableId, maxDistance: 8 });
    }
    if (t && bot.entity.position.distanceTo(t.position) > 3.5) await goto(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 15000);
    return t;
  }

  async function craft(name, count = 1, needTable = true) {
    const item = mcData.itemsByName[name];
    if (!item) return false;
    try {
      const table = needTable ? await ensureTable() : null;
      if (needTable && !table) return false;
      const r = bot.recipesFor(item.id, null, 1, table)[0];
      if (!r) return false;
      await bot.craft(r, count, table);
      return true;
    } catch (e) { addLog(`[Player] craft ${name} failed: ${e.message}`); return false; }
  }

  async function craftTools(material) {
    // material: "wooden" or "stone"
    for (const tool of ["pickaxe", "axe", "sword"]) {
      if (hasItem((i) => i.name === `${material}_${tool}`)) continue;
      if (material === "wooden") { await craftPlanks(); await craft("stick", 1, false); await craft("stick", 1, false); }
      else if (!hasItem((i) => i.name === "stick")) await craft("stick", 1, false);
      await craft(`${material}_${tool}`);
    }
  }

  // ---------- building ----------
  async function placeBlockAt(pos, itemName) {
    const existing = bot.blockAt(pos);
    if (existing && !isSoft(existing) && !itemName.endsWith("_door")) return true;
    const feet = bot.entity.position.floored();
    if (feet.x === pos.x && feet.z === pos.z && (feet.y === pos.y || feet.y + 1 === pos.y))
      await goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), 8000).catch(() => {});
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2)
      await goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3), 15000);
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) throw new Error("out of blocks");
    await bot.equip(item, "hand");
    const faces = [new Vec3(0,-1,0), new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1), new Vec3(0,1,0)];
    for (const f of faces) {
      const ref = bot.blockAt(pos.plus(f));
      if (!isSolid(ref)) continue;
      try {
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(ref, f.scaled(-1));
        await sleep(120);
        return true;
      } catch (_) {}
    }
    return false;
  }

  function findSite(center) {
    const g = Math.floor(center.y);
    const offsets = [[4,-2],[-4-size,-2],[-2,4],[-2,-4-size],[6,4],[-6-size,4],[8,-8],[-8-size,-8]];
    for (const [dx, dz] of offsets) {
      const x0 = Math.floor(center.x) + dx, z0 = Math.floor(center.z) + dz;
      let ok = true;
      for (let x = 0; x < size && ok; x++)
        for (let z = 0; z < size && ok; z++) {
          if (!isSolid(bot.blockAt(new Vec3(x0 + x, g - 1, z0 + z)))) ok = false;
          for (let y = 0; y <= height && ok; y++) if (!isSoft(bot.blockAt(new Vec3(x0 + x, g + y, z0 + z)))) ok = false;
        }
      if (ok) return { x0, y0: g, z0 };
    }
    return null;
  }

  async function buildHouse() {
    let site = null;
    for (let tries = 0; tries < 6 && !site; tries++) {
      site = findSite(bot.entity.position);
      if (!site) { addLog("[Player] No flat spot here - exploring for one"); await wander(40).catch(() => {}); guard(); }
    }
    if (!site) return false;

    const plan = planHouse(site.x0, site.y0, site.z0, size, height);
    const need = plan.blocks.length;
    addLog(`[Player] Building a house at ${site.x0},${site.y0},${site.z0} (${need} blocks)`);

    let best = bestBuildItem();
    if (!best || best.total < need) {
      const logs = Math.ceil((need - (best ? best.total : 0)) / 4) + 2;
      addLog(`[Player] Need wood: chopping ${logs} logs`);
      await chop(logs);
      await craftPlanks();
      best = bestBuildItem();
      if (!best || best.total < need) { addLog("[Player] Not enough blocks yet, will retry later"); return false; }
    }

    let pending = plan.blocks.slice();
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      const failed = [];
      for (const pos of pending) {
        guard();
        try { if (!(await placeBlockAt(pos, best.name))) failed.push(pos); }
        catch (e) { if (e.message === "cancelled") throw e; if (e.message === "out of blocks") return false; failed.push(pos); }
      }
      pending = failed;
    }

    // door (so zombies can't walk in)
    try {
      await craftPlanks();
      if (!hasItem((i) => i.name.endsWith("_door"))) await craft("oak_door", 1);
      const door = bot.inventory.items().find((i) => i.name.endsWith("_door"));
      if (door) await placeBlockAt(plan.doorPos, door.name);
    } catch (e) { addLog("[Player] door failed: " + e.message); }

    const c = new Vec3(site.x0 + Math.floor(size / 2), site.y0, site.z0 + Math.floor(size / 2));
    prog.home = { x: c.x, y: c.y, z: c.z };
    save();
    addLog(`[Player] House done! Home = ${c.x},${c.y},${c.z}`);
    return true;
  }

  // ---------- survival ----------
  async function eatIfNeeded() {
    if (bot.food >= 15) return false;
    const food = bot.inventory.items().find((i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name));
    if (!food) return false;
    try { await bot.equip(food, "hand"); await bot.consume(); return true; } catch (_) { return false; }
  }

  async function hunt() {
    const target = Object.values(bot.entities)
      .filter((e) => e.name && FOOD_ANIMALS.includes(e.name) && e.position && bot.entity.position.distanceTo(e.position) < 48)
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
    if (!target) { await wander(40).catch(() => {}); return false; }
    await equipTool("sword");
    const start = Date.now();
    let last = target.position.clone();
    while (alive() && bot.entities[target.id] && Date.now() - start < 25000) {
      last = target.position.clone();
      const d = bot.entity.position.distanceTo(target.position);
      if (d > 3) { try { bot.pathfinder.setMovements(defaultMove); bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); } catch (_) {} await sleep(400); }
      else { try { await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true); bot.attack(target); } catch (_) {} await sleep(650); }
    }
    try { bot.pathfinder.setGoal(null); await goto(new goals.GoalNear(last.x, last.y, last.z, 1), 8000); } catch (_) {}
    await sleep(500);
    return true;
  }

  // defend against hostile mobs like a player would
  let lastHit = 0;
  const defense = setInterval(() => {
    if (!alive()) return clearInterval(defense);
    const now = Date.now();
    if (now - lastHit < 650) return;
    const mob = Object.values(bot.entities).find((e) =>
      e !== bot.entity && e.position && (e.type === "hostile" || e.kind === "Hostile mobs") &&
      bot.entity.position.distanceTo(e.position) < 4);
    if (!mob) return;
    lastHit = now;
    try { equipTool("sword"); bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true); bot.attack(mob); } catch (_) {}
  }, 300);

  const isNight = () => bot.time && (bot.time.isDay === false || (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000));

  async function nightRoutine() {
    const h = home();
    if (!h) return false;
    addLog("[Player] Night - heading home");
    await goto(new goals.GoalNear(h.x, h.y, h.z, 1), 40000).catch(() => {});
    // bed: craft one if we have wool, then sleep
    try {
      const wool = bot.inventory.items().find((i) => i.name.endsWith("_wool") && invCount((x) => x.name === i.name) >= 3);
      if (wool && !hasItem((i) => i.name.endsWith("_bed"))) await craft(wool.name.replace("_wool", "_bed"));
      const bedItem = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
      if (bedItem && !bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 8 })) {
        const feet = bot.entity.position.floored();
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const pos = feet.offset(dx, 0, dz);
          if (isSoft(bot.blockAt(pos)) && isSolid(bot.blockAt(pos.offset(0, -1, 0))) && (await placeBlockAt(pos, bedItem.name))) break;
        }
      }
      const bed = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 8 });
      if (bed) { await bot.sleep(bed); addLog("[Player] Sleeping..."); }
    } catch (_) {}
    // wait for morning, moving a little like a real AFK player
    while (alive() && isNight()) {
      await sleep(8000);
      if (bot.isSleeping) continue;
      try { bot.look(Math.random() * Math.PI * 2 - Math.PI, 0, false); } catch (_) {}
      if (Math.random() < 0.2) { bot.setControlState("jump", true); setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 300); }
    }
    try { if (bot.isSleeping) await bot.wake(); } catch (_) {}
    return true;
  }

  // ---------- the main brain loop ----------
  async function step() {
    await eatIfNeeded();
    await tidyInventory();

    if (isNight() && home()) return nightRoutine();

    if (bot.food < 12 && !hasItem((i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name))) { await hunt(); return; }

    if (!prog.done.wood) {
      addLog("[Player] Stage 1: getting wood + wooden tools");
      await chop(6);
      await craftPlanks();
      await craftTools("wooden");
      prog.done.wood = true; save(); return;
    }
    if (!prog.done.house) {
      if (await buildHouse()) { prog.done.house = true; save(); } else await sleep(5000);
      return;
    }
    if (!prog.done.stone) {
      addLog("[Player] Stage 3: mining stone + stone tools");
      const got = await mineStone(14);
      if (got >= 3) await craftTools("stone");
      prog.done.stone = true; save(); return;
    }

    // free-play: do human-like things forever
    const r = Math.random();
    if (r < 0.25) { addLog("[Player] Chopping some trees"); await chop(rnd(4, 10)); await craftPlanks(); }
    else if (r < 0.45) { addLog("[Player] Mining stone"); await mineStone(rnd(8, 20)); }
    else if (r < 0.60) { addLog("[Player] Looking for food"); await hunt(); }
    else if (r < 0.85) { addLog("[Player] Exploring around"); await wander(); }
    else {
      addLog("[Player] Chilling at home");
      const h = home(); if (h) await goto(new goals.GoalNear(h.x, h.y, h.z, 3), 40000).catch(() => {});
      const end = Date.now() + rnd(20000, 60000);
      while (alive() && Date.now() < end) {
        try { bot.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.8, false); } catch (_) {}
        if (Math.random() < 0.3) { bot.setControlState("jump", true); setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 300); }
        await sleep(rnd(3000, 8000));
      }
    }
  }

  (async () => {
    await sleep(8000); // let auth / world load first
    addLog(`[Player] Brain started. Progress: ${JSON.stringify(prog.done)} home=${JSON.stringify(prog.home)}`);
    let errors = 0;
    while (alive()) {
      try { await step(); errors = 0; }
      catch (e) {
        if (e.message === "cancelled") break;
        addLog("[Player] step error: " + e.message);
        errors++;
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        await sleep(Math.min(3000 * errors, 20000));
      }
      await sleep(rnd(1500, 5000));
    }
  })();

  return { planHouse };
}

module.exports = { setupSurvivor, planHouse };
