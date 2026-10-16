const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Database ----------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err.message));

const PlayerSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  x: { type: Number, default: 500 },
  y: { type: Number, default: 500 },
  health: { type: Number, default: 100 },
  temperature: { type: Number, default: 100 },
  inventory: {
    wood: { type: Number, default: 0 },
    stone: { type: Number, default: 0 }
  }
});

const PlayerModel = mongoose.model('Player', PlayerSchema);

const MAX_USERNAME_LENGTH = 20;
const AUTOSAVE_INTERVAL_MS = 30000;

// World / player settings (these match the client's constants)
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 1000;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 250; // pixels per second
const SPAWN_X = 500;
const SPAWN_Y = 500;
const TICK_RATE = 60;     // server updates per second

// PvP settings
const PLAYER_MAX_HEALTH = 100;
const PROJECTILE_RADIUS = 5;       // matches the radius the client draws
const PROJECTILE_DAMAGE = 10;      // health a player loses per bullet
const MAX_SKELETONS = 100;         // oldest skeletons get dropped past this

// Projectile settings
const PROJECTILE_SPEED = 600;      // pixels per second
const SHOOT_COOLDOWN_MS = 80;

// Final Boss settings
const BOSS_RADIUS = 56;
const BOSS_SHOT_RANGE = 400;
const BOSS_SHOT_INTERVAL_MS = 1000;
const BOSS_PROJECTILE_SPEED = 200;
const BOSS_PROJECTILE_RADIUS = 8;
const BOSS_PROJECTILE_DAMAGE = 25;
const BOSS_PROJECTILE_STRUCTURE_DAMAGE = 25;

// Recruitable NPC settings
const NPC_COUNT = 15;
const NPC_RADIUS = 16;
const NPC_RECRUIT_RANGE = 50;
const NPC_FOLLOW_DISTANCE = 50;
const NPC_FOLLOW_SPEED = PLAYER_SPEED;
const NPC_SHOOT_RANGE = 200;
const NPC_SHOT_COOLDOWN = 1.5; // seconds between shots

// Resource settings
const TREE_COUNT = 30;
const ROCK_COUNT = 20;
const GATHER_RANGE = 50;           // maximum distance to harvest a resource

// Building settings
const WALL_WOOD_COST = 5;
const WALL_MAX_HEALTH = 50;
const WALL_WIDTH = 50;
const WALL_HEIGHT = 20;
const BUILD_MAX_DISTANCE = 100;    // maximum distance player can build from

// Biome boundaries (Forest, Desert, Ice Glacier)
const BIOMES = [
  { name: 'Forest',      x: 0,   y: 0,   w: 500, h: 1000, freezing: false },
  { name: 'Ice Glacier', x: 500, y: 0,   w: 500, h: 500,  freezing: true },
  { name: 'Desert',      x: 500, y: 500, w: 500, h: 500,  freezing: false }
];

// Temperature settings
const PLAYER_MAX_TEMPERATURE = 100;
const FREEZE_RATE = 5;            // degrees per second lost in the ice without a campfire
const WARM_RATE = 10;             // degrees per second gained near a campfire / in warm biomes
const COLD_DAMAGE_PER_SECOND = 5; // health lost per second at 0 temperature

// Campfire settings
const CAMPFIRE_WOOD_COST = 10;
const CAMPFIRE_STONE_COST = 5;
const CAMPFIRE_SIZE = 20;
const CAMPFIRE_WARMTH_RADIUS = 100;

// Enemy settings
const ENEMY_SPAWN_INTERVAL_MS = 3000;   // one new enemy every 3 seconds
const ENEMY_CONTACT_DAMAGE = 10;        // health a player loses when an enemy touches them
const ENEMY_STRUCTURE_DPS = 20;         // damage per second an enemy chews through a wall
const MAX_ENEMIES = 150;                // hard cap so the array can't grow forever

// Enemy types: forestGoblin = normal speed / 50 HP, desertScorpion = fast / 30 HP,
// frostGolem = slow / 150 HP
const ENEMY_TYPES = {
  forestGoblin:   { speed: 100, maxHealth: 50,  radius: 14, color: '#27ae60' },
  desertScorpion: { speed: 180, maxHealth: 30,  radius: 10, color: '#d35400' },
  frostGolem:     { speed: 60,  maxHealth: 150, radius: 22, color: '#85c1e9' }
};

// Which enemy roams which biome (biome names come from BIOMES above)
const BIOME_ENEMY_TYPES = {
  'Forest':      'forestGoblin',
  'Desert':      'desertScorpion',
  'Ice Glacier': 'frostGolem'
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'];

// Every logged-in player, keyed by socket ID
const players = {};

// Usernames currently logged in (or mid-login / mid-save), so one account can't be used twice
const activeUsernames = new Set();

// Sockets whose login query is still running
const loginPending = new Set();

// The latest keys each player is holding: { up, down, left, right }
const inputs = {};

// Projectiles in flight: { id, owner, source?, x, y, vx, vy }
const projectiles = [];
let nextProjectileId = 0;

// Server-authoritative Final Boss, located in the Ice Glacier (x: 500-1000, y: 0-500)
const boss = { active: true, x: 850, y: 150, health: 2000, maxHealth: 2000, lastShot: 0 };

// Fallen players and cursed NPCs: { x, y }
const skeletons = [];

// Multiplayer resources: [{ id, type, x, y }]
const resources = [];
let nextResourceId = 0;

// Multiplayer structures: [{ id, x, y, width, height, health, maxHealth }]
const structures = [];
let nextStructureId = 0;

// Campfires: [{ id, x, y, size, warmthRadius }]
const campfires = [];
let nextCampfireId = 0;

// Enemies: [{ id, type, x, y, radius, speed, health, maxHealth, color }]
const enemies = [];
let nextEnemyId = 0;

// Recruitable NPCs: [{ id, x, y, state, originBiome, ownerId, lastShot }]
const npcs = [];
let nextNpcId = 0;

// When each player last fired (ms timestamp)
const lastShot = {};

// Each player's damage cooldown vs enemies (so contact damage isn't applied 60x a second)
const enemyHitCooldown = {};

function randomSpawnPoint() {
  return {
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - PLAYER_RADIUS * 2),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - PLAYER_RADIUS * 2)
  };
}

function randomResourcePoint() {
  const margin = 30;
  return {
    x: margin + Math.random() * (WORLD_WIDTH - margin * 2),
    y: margin + Math.random() * (WORLD_HEIGHT - margin * 2)
  };
}

function createResource(type) {
  const pt = randomResourcePoint();
  return {
    id: nextResourceId++,
    type, // 'tree' or 'rock'
    x: pt.x,
    y: pt.y
  };
}

// Populate resources on server start
for (let i = 0; i < TREE_COUNT; i++) {
  resources.push(createResource('tree'));
}
for (let i = 0; i < ROCK_COUNT; i++) {
  resources.push(createResource('rock'));
}

function getBiomeAt(x, y) {
  for (const b of BIOMES) {
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
      return b;
    }
  }
  return BIOMES[0];
}

// NPCs spawn across the whole map; their original biome is their boundary curse.
function createNPC() {
  const point = randomSpawnPoint();
  return {
    id: nextNpcId++,
    x: point.x,
    y: point.y,
    radius: NPC_RADIUS,
    state: 'idle',
    originBiome: getBiomeAt(point.x, point.y).name,
    ownerId: null,
    lastShot: 0 // elapsed seconds since the NPC's previous shot
  };
}

for (let i = 0; i < NPC_COUNT; i++) {
  npcs.push(createNPC());
}

// Enemy factory: the coordinates decide the biome, the biome decides the type
function createEnemy(x, y) {
  const type = BIOME_ENEMY_TYPES[getBiomeAt(x, y).name] || 'forestGoblin';
  const def = ENEMY_TYPES[type];

  return {
    id: nextEnemyId++,
    type,
    x,
    y,
    radius: def.radius,
    speed: def.speed,            // pixels per second
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    color: def.color
  };
}

// Spawn an enemy at a random point on the map, away from the players if we can help it
function spawnEnemy() {
  const margin = 30;
  let x = 0;
  let y = 0;

  // Try a few times to land somewhere that isn't right on top of someone
  for (let attempt = 0; attempt < 10; attempt++) {
    x = margin + Math.random() * (WORLD_WIDTH - margin * 2);
    y = margin + Math.random() * (WORLD_HEIGHT - margin * 2);

    let tooClose = false;
    for (const id in players) {
      const p = players[id];
      if (Math.hypot(p.x - x, p.y - y) < 150) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) break;
  }

  enemies.push(createEnemy(x, y));

  // Keep the array bounded (oldest enemies are culled first)
  if (enemies.length > MAX_ENEMIES) enemies.shift();
}

// Spawn a brand new enemy every 3 seconds at a random spot on the map
setInterval(spawnEnemy, ENEMY_SPAWN_INTERVAL_MS);

// Damages a player, returns true if that damage killed them
function damagePlayer(id, amount) {
  const p = players[id];
  if (!p) return false;

  p.health -= amount;
  if (p.health <= 0) {
    killPlayer(id);
    return true;
  }
  return false;
}

function killPlayer(id) {
  const p = players[id];

  skeletons.push({ x: p.x, y: p.y });
  if (skeletons.length > MAX_SKELETONS) skeletons.shift();

  const spot = randomSpawnPoint();
  p.health = PLAYER_MAX_HEALTH;
  p.temperature = PLAYER_MAX_TEMPERATURE;
  p.x = spot.x;
  p.y = spot.y;
}

// Circle-vs-axis-aligned-rectangle collision check
function projectileHitsStructure(px, py, pradius, s) {
  const halfW = (s.width || WALL_WIDTH) / 2;
  const halfH = (s.height || WALL_HEIGHT) / 2;
  const closestX = Math.max(s.x - halfW, Math.min(px, s.x + halfW));
  const closestY = Math.max(s.y - halfH, Math.min(py, s.y + halfH));
  const dx = px - closestX;
  const dy = py - closestY;
  return (dx * dx + dy * dy) < (pradius * pradius);
}

// Writes one player's progress to MongoDB. Takes a plain snapshot so it's safe to call
// after the player has already been removed from `players`.
async function savePlayer(snapshot) {
  if (!snapshot || !snapshot.username) return;
  await PlayerModel.updateOne(
    { username: snapshot.username },
    {
      $set: {
        x: snapshot.x,
        y: snapshot.y,
        health: snapshot.health,
        temperature: snapshot.temperature,
        inventory: {
          wood: snapshot.inventory.wood || 0,
          stone: snapshot.inventory.stone || 0
        }
      }
    }
  );
}

function snapshotPlayer(p) {
  return {
    username: p.username,
    x: p.x,
    y: p.y,
    health: p.health,
    temperature: p.temperature,
    inventory: { wood: p.inventory.wood, stone: p.inventory.stone }
  };
}

// Periodic autosave so a server crash doesn't wipe everyone's recent progress
setInterval(() => {
  for (const id in players) {
    savePlayer(snapshotPlayer(players[id])).catch((err) => {
      console.error('Autosave failed for ' + players[id].username + ':', err.message);
    });
  }
}, AUTOSAVE_INTERVAL_MS);

io.on('connection', (socket) => {
  console.log('A user connected: ' + socket.id);

  // No player is created here. The socket only joins the game after a successful 'login'.

  socket.on('login', async (data) => {
    // Ignore repeat logins from the same socket
    if (players[socket.id] || loginPending.has(socket.id)) return;

    const raw = (data && typeof data === 'object') ? data.username : data;
    const username = typeof raw === 'string' ? raw.trim() : '';

    if (!username || username.length > MAX_USERNAME_LENGTH) {
      socket.emit('login_error', 'Username must be 1-' + MAX_USERNAME_LENGTH + ' characters.');
      return;
    }

    if (activeUsernames.has(username)) {
      socket.emit('login_error', 'That username is already in use right now.');
      return;
    }

    activeUsernames.add(username);
    loginPending.add(socket.id);

    try {
      let doc = await PlayerModel.findOne({ username });

      if (!doc) {
        doc = new PlayerModel({
          username,
          x: SPAWN_X,
          y: SPAWN_Y,
          health: PLAYER_MAX_HEALTH,
          temperature: PLAYER_MAX_TEMPERATURE,
          inventory: { wood: 0, stone: 0 }
        });
        await doc.save();
      }

      // The player may have closed the tab while the query was running
      if (!socket.connected) {
        activeUsernames.delete(username);
        return;
      }

      players[socket.id] = {
        username: doc.username,
        x: doc.x,
        y: doc.y,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        health: doc.health > 0 ? doc.health : PLAYER_MAX_HEALTH,
        temperature: doc.temperature,
        inventory: {
          wood: (doc.inventory && doc.inventory.wood) || 0,
          stone: (doc.inventory && doc.inventory.stone) || 0
        }
      };
      inputs[socket.id] = { up: false, down: false, left: false, right: false };
      lastShot[socket.id] = 0;
      enemyHitCooldown[socket.id] = 0;

      socket.emit('login_success', { username: doc.username });
    } catch (err) {
      console.error('Login failed for ' + username + ':', err.message);
      activeUsernames.delete(username);
      socket.emit('login_error', 'Could not log in. Please try again.');
    } finally {
      loginPending.delete(socket.id);
    }
  });

  socket.on('movement', (data) => {
    if (!data || !players[socket.id]) return;
    inputs[socket.id] = {
      up: !!data.up,
      down: !!data.down,
      left: !!data.left,
      right: !!data.right
    };
  });

  socket.on('shoot', (angle) => {
    const p = players[socket.id];
    if (!p) return;
    if (typeof angle !== 'number' || !Number.isFinite(angle)) return;

    const now = Date.now();
    if (now - lastShot[socket.id] < SHOOT_COOLDOWN_MS) return;
    lastShot[socket.id] = now;

    projectiles.push({
      id: nextProjectileId++,
      owner: socket.id,
      x: p.x,
      y: p.y,
      vx: Math.cos(angle) * PROJECTILE_SPEED,
      vy: Math.sin(angle) * PROJECTILE_SPEED
    });
  });

  // Recruit the closest idle NPC within 50 pixels of this player.
  socket.on('recruit', () => {
    const player = players[socket.id];
    if (!player) return;

    let closestNpc = null;
    let closestDistance = NPC_RECRUIT_RANGE;

    for (const npc of npcs) {
      if (npc.state !== 'idle') continue;
      const distance = Math.hypot(player.x - npc.x, player.y - npc.y);
      if (distance <= closestDistance) {
        closestDistance = distance;
        closestNpc = npc;
      }
    }

    if (!closestNpc) return;
    closestNpc.state = 'recruited';
    closestNpc.ownerId = socket.id;
    closestNpc.lastShot = 0;
  });

  // Resource gathering
  socket.on('gather', () => {
    const p = players[socket.id];
    if (!p) return;

    for (let i = 0; i < resources.length; i++) {
      const res = resources[i];
      const dist = Math.hypot(p.x - res.x, p.y - res.y);

      if (dist <= GATHER_RANGE) {
        const harvested = resources.splice(i, 1)[0];
        if (harvested.type === 'tree') {
          p.inventory.wood = (p.inventory.wood || 0) + 1;
        } else if (harvested.type === 'rock') {
          p.inventory.stone = (p.inventory.stone || 0) + 1;
        }

        // Instantly spawn a new random resource of the same type on the map
        resources.push(createResource(harvested.type));
        break; // Only harvest one resource per gather action
      }
    }
  });

  // Base building
  socket.on('build', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;

    const targetX = Number(data.x);
    const targetY = Number(data.y);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;

    // Must have at least 5 wood
    if (!p.inventory || p.inventory.wood < WALL_WOOD_COST) return;

    // Must be within 100 pixels of the player
    const dist = Math.hypot(p.x - targetX, p.y - targetY);
    if (dist > BUILD_MAX_DISTANCE) return;

    // Deduct wood and add new structure
    p.inventory.wood -= WALL_WOOD_COST;
    structures.push({
      id: nextStructureId++,
      x: targetX,
      y: targetY,
      width: WALL_WIDTH,
      height: WALL_HEIGHT,
      health: WALL_MAX_HEALTH,
      maxHealth: WALL_MAX_HEALTH
    });
  });

  // Campfire building
  socket.on('build_campfire', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;

    const targetX = Number(data.x);
    const targetY = Number(data.y);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;

    // Must have 10 Wood and 5 Stone
    if (!p.inventory || p.inventory.wood < CAMPFIRE_WOOD_COST) return;
    if (!p.inventory || p.inventory.stone < CAMPFIRE_STONE_COST) return;

    // Must be within 100 pixels of the player
    const dist = Math.hypot(p.x - targetX, p.y - targetY);
    if (dist > BUILD_MAX_DISTANCE) return;

    // Deduct resources and add new campfire
    p.inventory.wood -= CAMPFIRE_WOOD_COST;
    p.inventory.stone -= CAMPFIRE_STONE_COST;
    campfires.push({
      id: nextCampfireId++,
      x: targetX,
      y: targetY,
      size: CAMPFIRE_SIZE,
      warmthRadius: CAMPFIRE_WARMTH_RADIUS
    });
  });

  socket.on('respawn', () => {
    const p = players[socket.id];
    if (!p) return;
    p.x = SPAWN_X;
    p.y = SPAWN_Y;
    p.health = PLAYER_MAX_HEALTH;
    p.temperature = PLAYER_MAX_TEMPERATURE;
  });

  socket.on('disconnect', async () => {
    console.log('A user disconnected: ' + socket.id);

    for (const npc of npcs) {
      if (npc.ownerId === socket.id) {
        npc.state = 'idle';
        npc.ownerId = null;
        npc.lastShot = 0;
      }
    }

    const p = players[socket.id];

    // Grab their current state first, then remove them from the world right away
    // so the game loop stops simulating them while the save is in flight.
    const snapshot = p ? snapshotPlayer(p) : null;

    delete players[socket.id];
    delete inputs[socket.id];
    delete lastShot[socket.id];
    delete enemyHitCooldown[socket.id];
    loginPending.delete(socket.id);

    if (!snapshot) return; // never finished logging in, nothing to save

    try {
      await savePlayer(snapshot);
    } catch (err) {
      console.error('Failed to save ' + snapshot.username + ':', err.message);
    } finally {
      // Free the username only after the save lands, so a quick re-login loads fresh data
      activeUsernames.delete(snapshot.username);
    }
  });
});

// 60Hz update loop
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  for (const id in players) {
    const p = players[id];
    const input = inputs[id];

    let dx = 0;
    let dy = 0;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.sqrt(2);
      dx *= inv;
      dy *= inv;
    }

    p.x += dx * PLAYER_SPEED * dt;
    p.y += dy * PLAYER_SPEED * dt;

    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));

    // Biome / temperature logic
    const biome = getBiomeAt(p.x, p.y);
    if (biome && biome.name === 'Ice Glacier') {
      let nearCampfire = false;
      for (const c of campfires) {
        const radius = c.warmthRadius || CAMPFIRE_WARMTH_RADIUS;
        if (Math.hypot(p.x - c.x, p.y - c.y) <= radius) {
          nearCampfire = true;
          break;
        }
      }
      if (nearCampfire) {
        p.temperature = Math.min(PLAYER_MAX_TEMPERATURE, p.temperature + WARM_RATE * dt);
      } else {
        p.temperature = Math.max(0, p.temperature - FREEZE_RATE * dt);
      }
    } else {
      // Forest or Desert: restore temperature to 100
      p.temperature = PLAYER_MAX_TEMPERATURE;
    }

    // Cold damage at 0 temperature
    if (p.temperature <= 0) {
      p.health -= COLD_DAMAGE_PER_SECOND * dt;
      if (p.health <= 0) {
        killPlayer(id);
      }
    }
  }

  // Recruited NPCs follow their owner, die when they leave their origin biome,
  // and fire server-authoritative projectiles at nearby enemies.
  for (let i = npcs.length - 1; i >= 0; i--) {
    const npc = npcs[i];
    if (npc.state !== 'recruited') continue;

    const owner = players[npc.ownerId];
    if (!owner) continue;

    const dx = owner.x - npc.x;
    const dy = owner.y - npc.y;
    const distanceToOwner = Math.hypot(dx, dy);

    // Move toward the owner, but stop 50 pixels away and never overshoot.
    if (distanceToOwner > NPC_FOLLOW_DISTANCE) {
      const moveDistance = Math.min(
        NPC_FOLLOW_SPEED * dt,
        distanceToOwner - NPC_FOLLOW_DISTANCE
      );
      npc.x += (dx / distanceToOwner) * moveDistance;
      npc.y += (dy / distanceToOwner) * moveDistance;
    }

    // The biome at the NPC's spawn point is its origin. Crossing into any other
    // biome kills it immediately and leaves a server-synchronized skeleton.
    if (getBiomeAt(npc.x, npc.y).name !== npc.originBiome) {
      skeletons.push({ x: npc.x, y: npc.y });
      if (skeletons.length > MAX_SKELETONS) skeletons.shift();
      npcs.splice(i, 1);
      continue;
    }

    npc.lastShot = Math.min(NPC_SHOT_COOLDOWN, npc.lastShot + dt);

    let target = null;
    let closestEnemyDistance = NPC_SHOOT_RANGE;
    for (const enemy of enemies) {
      const enemyDistance = Math.hypot(enemy.x - npc.x, enemy.y - npc.y);
      if (enemyDistance <= closestEnemyDistance) {
        closestEnemyDistance = enemyDistance;
        target = enemy;
      }
    }

    if (target && npc.lastShot >= NPC_SHOT_COOLDOWN) {
      const angle = Math.atan2(target.y - npc.y, target.x - npc.x);
      projectiles.push({
        id: nextProjectileId++,
        owner: npc.ownerId,
        source: 'npc',
        x: npc.x,
        y: npc.y,
        vx: Math.cos(angle) * PROJECTILE_SPEED,
        vy: Math.sin(angle) * PROJECTILE_SPEED
      });
      npc.lastShot = 0;
    }
  }

  // Enemy AI: hunt the closest player, chew through walls in the way,
  // and deal contact damage when they touch someone
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];

    // 1. Find the closest connected player
    let targetId = null;
    let target = null;
    let closestDist = Infinity;

    for (const id in players) {
      const p = players[id];
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < closestDist) {
        closestDist = d;
        targetId = id;
        target = p;
      }
    }

    // No players online: nothing to chase
    if (!target) continue;

    // 2. Walk toward that player, unless a wall is standing in the way
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const angle = Math.atan2(dy, dx);
    const spawnPadding = e.radius + 5;

    let blocked = false;
    for (let sIdx = structures.length - 1; sIdx >= 0; sIdx--) {
      const s = structures[sIdx];
      if (projectileHitsStructure(e.x, e.y, e.radius, s)) {
        // Enemy is pressed against a structure: it attacks the wall instead
        s.health -= ENEMY_STRUCTURE_DPS * dt;
        blocked = true;

        if (s.health <= 0) structures.splice(sIdx, 1);
        break;
      }
    }

    if (!blocked) {
      e.x += Math.cos(angle) * e.speed * dt;
      e.y += Math.sin(angle) * e.speed * dt;

      e.x = Math.max(spawnPadding, Math.min(WORLD_WIDTH - spawnPadding, e.x));
      e.y = Math.max(spawnPadding, Math.min(WORLD_HEIGHT - spawnPadding, e.y));
    }

    // 3. Touching a player: damage them (rate limited), then the enemy dies
    enemyHitCooldown[targetId] = enemyHitCooldown[targetId] || 0;
    if (enemyHitCooldown[targetId] > 0) enemyHitCooldown[targetId] -= dt;

    if (closestDist < PLAYER_RADIUS + e.radius && enemyHitCooldown[targetId] <= 0) {
      enemyHitCooldown[targetId] = 0.5;
      damagePlayer(targetId, ENEMY_CONTACT_DAMAGE); // killPlayer() handles the death + respawn

      // Remove the enemy so it can't sit on the player and instakill them
      enemies.splice(i, 1);
      continue;
    }
  }

  // The server controls the Final Boss. It shoots at the closest player within range
  // once per second, adding its shots to the same authoritative projectile list.
  if (boss.active) {
    let target = null;
    let closestDistance = Infinity;

    for (const id in players) {
      const player = players[id];
      const distance = Math.hypot(player.x - boss.x, player.y - boss.y);
      if (distance < closestDistance) {
        closestDistance = distance;
        target = player;
      }
    }

    if (target && closestDistance <= BOSS_SHOT_RANGE && now - boss.lastShot >= BOSS_SHOT_INTERVAL_MS) {
      const angle = Math.atan2(target.y - boss.y, target.x - boss.x);
      projectiles.push({
        id: nextProjectileId++,
        owner: 'BOSS',
        x: boss.x,
        y: boss.y,
        vx: Math.cos(angle) * BOSS_PROJECTILE_SPEED,
        vy: Math.sin(angle) * BOSS_PROJECTILE_SPEED
      });
      boss.lastShot = now;
    }
  }

  // Move bullets and check collisions
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    const isBossProjectile = b.owner === 'BOSS';
    const projectileRadius = isBossProjectile ? BOSS_PROJECTILE_RADIUS : PROJECTILE_RADIUS;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT) {
      projectiles.splice(i, 1);
      continue;
    }

    // Boss shots damage walls and players on the server; they do not hit enemies.
    if (isBossProjectile) {
      let hitStructure = false;
      for (let sIdx = structures.length - 1; sIdx >= 0; sIdx--) {
        const s = structures[sIdx];
        if (projectileHitsStructure(b.x, b.y, projectileRadius, s)) {
          s.health -= BOSS_PROJECTILE_STRUCTURE_DAMAGE;
          if (s.health <= 0) structures.splice(sIdx, 1);
          projectiles.splice(i, 1);
          hitStructure = true;
          break;
        }
      }
      if (hitStructure) continue;

      let hitPlayer = false;
      for (const id in players) {
        const player = players[id];
        const distance = Math.hypot(b.x - player.x, b.y - player.y);
        if (distance < PLAYER_RADIUS + projectileRadius) {
          damagePlayer(id, BOSS_PROJECTILE_DAMAGE);
          projectiles.splice(i, 1);
          hitPlayer = true;
          break;
        }
      }
      if (hitPlayer) continue;
      continue;
    }

    // Player/NPC projectile vs Structure collision
    let hitStructure = false;
    for (let sIdx = structures.length - 1; sIdx >= 0; sIdx--) {
      const s = structures[sIdx];
      if (projectileHitsStructure(b.x, b.y, projectileRadius, s)) {
        s.health -= PROJECTILE_DAMAGE;
        projectiles.splice(i, 1);
        hitStructure = true;

        if (s.health <= 0) {
          structures.splice(sIdx, 1);
        }
        break;
      }
    }
    if (hitStructure) continue;

    // Player/NPC projectile vs Enemy collision
    let hitEnemy = false;
    for (let eIdx = enemies.length - 1; eIdx >= 0; eIdx--) {
      const e = enemies[eIdx];
      const ex = b.x - e.x;
      const ey = b.y - e.y;

      if (Math.sqrt(ex * ex + ey * ey) < e.radius + projectileRadius) {
        e.health -= PROJECTILE_DAMAGE;
        projectiles.splice(i, 1);
        hitEnemy = true;

        if (e.health <= 0) enemies.splice(eIdx, 1);
        break;
      }
    }
    if (hitEnemy) continue;

    // Player/NPC projectile vs Player collision
    let hitPlayer = false;
    for (const id in players) {
      if (id === b.owner) continue;

      const player = players[id];
      const distance = Math.hypot(b.x - player.x, b.y - player.y);
      if (distance < PLAYER_RADIUS + projectileRadius) {
        damagePlayer(id, PROJECTILE_DAMAGE);
        projectiles.splice(i, 1);
        hitPlayer = true;
        break;
      }
    }
    if (hitPlayer) continue;

    // Only a player's own shot can damage the boss; NPC and boss shots cannot.
    if (boss.active && b.owner !== 'BOSS' && b.source !== 'npc' &&
        Math.hypot(b.x - boss.x, b.y - boss.y) < BOSS_RADIUS + projectileRadius) {
      boss.health -= PROJECTILE_DAMAGE;
      projectiles.splice(i, 1);

      if (boss.health <= 0) {
        boss.health = 0;
        boss.active = false;
        const killer = players[b.owner];
        io.emit(
          'world_event',
          `THE FINAL SAGA COMPLETE - The Boss has been defeated by ${killer ? killer.username : b.owner}!`
        );
      }
    }
  }

  // Broadcast current state to all clients
  io.emit('state', {
    players,
    projectiles,
    enemies,
    npcs,
    skeletons,
    resources,
    structures,
    campfires,
    boss
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});