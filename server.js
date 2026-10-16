const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files directly from the root directory
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

// Every connected player, keyed by socket ID
const players = {};

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

  if (enemies.length > MAX_ENEMIES) enemies.shift();
}

setInterval(spawnEnemy, ENEMY_SPAWN_INTERVAL_MS);

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
