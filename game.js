const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Connect to the server
const socket = io();

// Snapshots sent by the server ~60 times a second
let serverPlayers = {};
let serverProjectiles = [];
let serverEnemies = [];
let serverNPCs = [];
let serverSkeletons = [];
let serverResources = [];
let serverStructures = [];
let serverCampfires = [];
let serverBoss = null;

let worldEventMessage = '';
let worldEventTimer = null;
const WORLD_EVENT_DURATION_MS = 10000;

socket.on('state', (state) => {
  serverPlayers = state.players || {};
  serverProjectiles = state.projectiles || [];
  serverEnemies = state.enemies || [];
  serverNPCs = state.npcs || [];
  serverSkeletons = state.skeletons || [];
  serverResources = state.resources || [];
  serverStructures = state.structures || [];
  serverCampfires = state.campfires || [];
  serverBoss = state.boss || null;
});

socket.on('world_event', (message) => {
  if (typeof message !== 'string') return;

  worldEventMessage = message;
  if (worldEventTimer !== null) clearTimeout(worldEventTimer);
  worldEventTimer = setTimeout(() => {
    worldEventMessage = '';
    worldEventTimer = null;
  }, WORLD_EVENT_DURATION_MS);
});

// World settings
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 1000;
const GRID_SIZE = 50;

// Biomes
const BIOMES = [
  { name: 'Forest',      x: 0,   y: 0,   w: 500, h: 1000, color: '#d4edcf', resource: 'tree', enemyType: 'forestGoblin',   freezing: false },
  { name: 'Ice Glacier', x: 500, y: 0,   w: 500, h: 500,  color: '#e1f1fa', resource: 'rock', enemyType: 'frostGolem',     freezing: true },
  { name: 'Desert',      x: 500, y: 500, w: 500, h: 500,  color: '#f2e4b8', resource: 'rock', enemyType: 'desertScorpion', freezing: false }
];

// Day/night settings
const DAY_LENGTH = 30;
const NIGHT_LENGTH = 30;
const CYCLE_LENGTH = DAY_LENGTH + NIGHT_LENGTH;
const NIGHT_OVERLAY_COLOR = 'rgba(0, 0, 10, 0.5)';

// Enemy settings (the server owns enemy positions, health and damage now;
// these values only drive how enemies are drawn on this client)
const ENEMY_TYPES = {
  forestGoblin:   { speed: 100, maxHealth: 50,  color: '#27ae60', radius: 14 },
  frostGolem:     { speed: 60,  maxHealth: 150, color: '#85c1e9', radius: 22 },
  desertScorpion: { speed: 180, maxHealth: 30,  color: '#d35400', radius: 10 }
};

// Boss appearance (boss state, health, and combat are authoritative on the server)
const BOSS_RADIUS = 56;
const BOSS_PROJECTILE_RADIUS = 8;
const BOSS_HEALTH_BAR_WIDTH = 400;
const BOSS_HEALTH_BAR_HEIGHT = 18;

// Player settings
const PLAYER_MAX_HEALTH = 100;
const PLAYER_MAX_TEMPERATURE = 100;
const FREEZE_RATE = 5;
const WARM_RATE = 10;
const COLD_DAMAGE_PER_SECOND = 5;

// Resource settings
const TREE_COUNT = 30;
const ROCK_COUNT = 20;
const RESOURCE_EDGE_MARGIN = 30;
const RESOURCE_MIN_SPACING = 10;
const RESOURCE_PLAYER_CLEARANCE = 60;
const RESOURCE_RESPAWN_MIN_DISTANCE = 200;
const GATHER_REACH = 15;

// Building settings
const WALL_WOOD_COST = 5;
const WALL_MAX_HEALTH = 50;
const WALL_WIDTH = 50;
const WALL_HEIGHT = 20;

// Campfire settings
const CAMPFIRE_WOOD_COST = 10;
const CAMPFIRE_STONE_COST = 5;
const CAMPFIRE_SIZE = 20;
const CAMPFIRE_WARMTH_RADIUS = 100;

// NPC appearance (NPC state and behavior are owned by the server)
const NPC_RADIUS = 16;
const NPC_COLOR = '#3498db';
const NPC_OUTLINE = '#1d6fa5';

// Resource definitions
const RESOURCE_TYPES = {
  tree: { shape: 'circle', radius: 18, color: '#27ae60', outline: '#145a32', item: 'wood' },
  rock: { shape: 'square', radius: 14, color: '#5d6d7e', outline: '#2c3e50', item: 'stone' }
};

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const mouse = {
  x: canvas.width / 2 + 1,
  y: canvas.height / 2
};

class TimeOfDay {
  constructor() {
    this.cycleTime = 0;
  }

  update(dt) {
    this.cycleTime = (this.cycleTime + dt) % CYCLE_LENGTH;
  }

  isNight() {
    return this.cycleTime >= DAY_LENGTH;
  }

  secondsRemaining() {
    if (this.isNight()) {
      return Math.ceil(CYCLE_LENGTH - this.cycleTime);
    }
    return Math.ceil(DAY_LENGTH - this.cycleTime);
  }
}

const timeOfDay = new TimeOfDay();

class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.radius = 20;
    this.color = '#3498db';
    this.aimAngle = 0;
    this.barrelLength = 26;
    this.barrelWidth = 10;
    this.maxHealth = PLAYER_MAX_HEALTH;
    this.health = PLAYER_MAX_HEALTH;
    this.maxTemperature = PLAYER_MAX_TEMPERATURE;
    this.temperature = PLAYER_MAX_TEMPERATURE;
    this.inventory = { wood: 0, stone: 0 };
  }

  updateTemperature(dt) {
    if (isNearCampfire(this.x, this.y)) {
      this.temperature = Math.min(this.maxTemperature, this.temperature + WARM_RATE * dt);
      return;
    }

    const biome = getBiomeAt(this.x, this.y);
    if (biome.freezing) {
      this.temperature = Math.max(0, this.temperature - FREEZE_RATE * dt);
      if (this.temperature === 0) {
        this.health -= COLD_DAMAGE_PER_SECOND * dt;
      }
    } else {
      this.temperature = Math.min(this.maxTemperature, this.temperature + WARM_RATE * dt);
    }
  }

  angleTo(screenX, screenY) {
    const originX = this.x - camera.x;
    const originY = this.y - camera.y;
    return Math.atan2(screenY - originY, screenX - originX);
  }

  aim() {
    this.aimAngle = this.angleTo(mouse.x, mouse.y);
  }

  draw() {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.aimAngle);
    ctx.fillStyle = '#7f8c8d';
    ctx.fillRect(0, -this.barrelWidth / 2, this.barrelLength, this.barrelWidth);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2c3e50';
    ctx.strokeRect(0, -this.barrelWidth / 2, this.barrelLength, this.barrelWidth);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#2c3e50';
    ctx.stroke();

    const barWidth = 40;
    const barHeight = 5;
    const bx = this.x - barWidth / 2;

    // Enemy contact damage is applied by the server, so trust its health value
    const serverMe = (typeof serverPlayers !== 'undefined') ? serverPlayers[socket.id] : null;
    const health = getEffectiveHealth();
    const healthPct = Math.max(0, health) / this.maxHealth;
    const hy = this.y - this.radius - 12;
    ctx.fillStyle = '#333';
    ctx.fillRect(bx, hy, barWidth, barHeight);
    ctx.fillStyle = healthPct > 0.5 ? '#2ecc71' : healthPct > 0.25 ? '#f39c12' : '#e74c3c';
    ctx.fillRect(bx, hy, barWidth * healthPct, barHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(bx, hy, barWidth, barHeight);

    const temp = (serverMe && serverMe.temperature != null) ? serverMe.temperature : this.temperature;
    const tempPct = Math.max(0, temp) / this.maxTemperature;
    const ty = hy - barHeight - 2;
    ctx.fillStyle = '#333';
    ctx.fillRect(bx, ty, barWidth, barHeight);
    ctx.fillStyle = '#5dade2';
    ctx.fillRect(bx, ty, barWidth * tempPct, barHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(bx, ty, barWidth, barHeight);
  }
}

class Structure {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.width = WALL_WIDTH;
    this.height = WALL_HEIGHT;
    this.maxHealth = WALL_MAX_HEALTH;
    this.health = WALL_MAX_HEALTH;
    this.color = '#8b5a2b';
    this.outline = '#5a3a1a';
  }

  collidesWith(cx, cy, radius) {
    const halfW = this.width / 2;
    const halfH = this.height / 2;
    const closestX = Math.max(this.x - halfW, Math.min(cx, this.x + halfW));
    const closestY = Math.max(this.y - halfH, Math.min(cy, this.y + halfH));
    return Math.hypot(cx - closestX, cy - closestY) < radius;
  }

  draw() {
    const left = this.x - this.width / 2;
    const top = this.y - this.height / 2;

    ctx.fillStyle = this.color;
    ctx.fillRect(left, top, this.width, this.height);
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.outline;
    ctx.strokeRect(left, top, this.width, this.height);

    if (this.health < this.maxHealth) {
      const pct = Math.max(0, this.health) / this.maxHealth;
      const barY = top - 8;
      ctx.fillStyle = '#333';
      ctx.fillRect(left, barY, this.width, 4);
      ctx.fillStyle = pct > 0.5 ? '#2ecc71' : pct > 0.25 ? '#f39c12' : '#e74c3c';
      ctx.fillRect(left, barY, this.width * pct, 4);
    }
  }
}

class Campfire {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = CAMPFIRE_SIZE;
    this.warmthRadius = CAMPFIRE_WARMTH_RADIUS;
    this.color = '#e67e22';
    this.outline = '#b95c0c';
    this.glowColor = 'rgba(243, 156, 18, 0.18)';
  }

  warms(px, py) {
    return Math.hypot(px - this.x, py - this.y) <= this.warmthRadius;
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.warmthRadius, 0, Math.PI * 2);
    ctx.fillStyle = this.glowColor;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(243, 156, 18, 0.4)';
    ctx.stroke();

    const half = this.size / 2;
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - half, this.y - half, this.size, this.size);
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.outline;
    ctx.strokeRect(this.x - half, this.y - half, this.size, this.size);
  }
}

// Enemies are simulated on the server now, so there is no local Enemy class.
// The server broadcasts [{ id, type, x, y, radius, speed, health, maxHealth, color }]
// and drawServerEnemies() below renders exactly what the server reports.

class Resource {
  constructor(type, x, y) {
    const def = RESOURCE_TYPES[type] || RESOURCE_TYPES.tree;
    this.type = type;
    this.x = x;
    this.y = y;
    this.radius = def.radius;
    this.shape = def.shape;
    this.color = def.color;
    this.outline = def.outline;
    this.item = def.item;
  }

  draw() {
    ctx.fillStyle = this.color;
    ctx.strokeStyle = this.outline;
    ctx.lineWidth = 3;

    if (this.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      const size = this.radius * 2;
      ctx.fillRect(this.x - this.radius, this.y - this.radius, size, size);
      ctx.strokeRect(this.x - this.radius, this.y - this.radius, size, size);
    }
  }
}

const player = new Player(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
const campfires = [];

// Enemies are spawned, moved and damaged by the server (one every 3 seconds at a
// random point on the map, typed by the biome of that point), so this client no
// longer spawns or updates them - it only draws serverEnemies.

function getBiomeAt(x, y) {
  for (const b of BIOMES) {
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
      return b;
    }
  }
  return BIOMES[0];
}

function tryCraftCampfire() {
  if (player.inventory.wood < CAMPFIRE_WOOD_COST) return false;
  if (player.inventory.stone < CAMPFIRE_STONE_COST) return false;

  const worldX = mouse.x + camera.x;
  const worldY = mouse.y + camera.y;

  if (worldX < 0 || worldX > WORLD_WIDTH || worldY < 0 || worldY > WORLD_HEIGHT) return false;

  player.inventory.wood -= CAMPFIRE_WOOD_COST;
  player.inventory.stone -= CAMPFIRE_STONE_COST;
  campfires.push(new Campfire(worldX, worldY));
  return true;
}

function isNearCampfire(x, y) {
  for (const c of campfires) {
    if (c.warms(x, y)) return true;
  }
  return false;
}

// Keyboard input
const keys = { w: false, a: false, s: false, d: false };

function sendMovement() {
  socket.emit('movement', {
    up: keys.w,
    down: keys.s,
    left: keys.a,
    right: keys.d
  });
}

window.addEventListener('keydown', (e) => {

  const key = e.key.toLowerCase();
  if (key in keys) keys[key] = true;

  // E gathers resources from the server
  if (key === 'e' && !e.repeat) {
    socket.emit('gather');
  }

  // B builds a structure on the server
  if (key === 'b' && !e.repeat) {
    const worldX = mouse.x + camera.x;
    const worldY = mouse.y + camera.y;
    socket.emit('build', { x: worldX, y: worldY });
  }

  // C builds a campfire on the server
  if (key === 'c' && !e.repeat) {
    const worldX = mouse.x + camera.x;
    const worldY = mouse.y + camera.y;
    socket.emit('build_campfire', { x: worldX, y: worldY });
  }

  // R asks the server to recruit the closest nearby idle NPC
  if (key === 'r' && !e.repeat) socket.emit('recruit');
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key in keys) keys[key] = false;
});

window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  sendMovement();
});

// Mouse input
function updateMouse(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - rect.left) * (canvas.width / rect.width);
  mouse.y = (e.clientY - rect.top) * (canvas.height / rect.height);
}

window.addEventListener('mousemove', updateMouse);

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  updateMouse(e);

  const angle = player.angleTo(mouse.x, mouse.y);
  socket.emit('shoot', angle);
});

// Camera
const camera = {
  x: 0,
  y: 0,
  follow(target) {
    this.x = target.x - canvas.width / 2;
    this.y = target.y - canvas.height / 2;
  }
};

function getEffectiveHealth() {
  const me = serverPlayers[socket.id];
  return (me && me.health != null) ? Math.max(0, me.health) : PLAYER_MAX_HEALTH;
}

function syncLocalPlayer() {
  const me = serverPlayers[socket.id];
  if (!me) return;

  player.x = me.x;
  player.y = me.y;
  player.color = me.color;
  if (me.inventory) player.inventory = me.inventory;
  if (me.temperature != null) player.temperature = me.temperature;
  if (me.health != null) player.health = Math.max(0, me.health);
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x <= WORLD_WIDTH; x += GRID_SIZE) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_HEIGHT);
  }

  for (let y = 0; y <= WORLD_HEIGHT; y += GRID_SIZE) {
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD_WIDTH, y);
  }

  ctx.stroke();
}

function drawWorld() {
  for (const b of BIOMES) {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  drawGrid();

  ctx.strokeStyle = '#555';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
}

function drawPlayers() {
  for (const id in serverPlayers) {
    if (id === socket.id) continue;

    const p = serverPlayers[id];
    ctx.beginPath();
    ctx.arc(p.x, p.y, player.radius, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.stroke();

    const barWidth = 40;
    const barHeight = 5;
    const bx = p.x - barWidth / 2;
    const by = p.y - player.radius - 12;
    const pct = Math.max(0, (p.health != null ? p.health : PLAYER_MAX_HEALTH)) / PLAYER_MAX_HEALTH;

    ctx.fillStyle = '#333';
    ctx.fillRect(bx, by, barWidth, barHeight);
    ctx.fillStyle = pct > 0.5 ? '#2ecc71' : pct > 0.25 ? '#f39c12' : '#e74c3c';
    ctx.fillRect(bx, by, barWidth * pct, barHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(bx, by, barWidth, barHeight);
  }

  if (serverPlayers[socket.id]) player.draw();
}

function drawServerProjectiles() {
  for (const sp of serverProjectiles) {
    const isBossProjectile = sp.owner === 'BOSS';
    const radius = isBossProjectile ? BOSS_PROJECTILE_RADIUS : 5;

    ctx.beginPath();
    ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isBossProjectile ? '#e056fd' : '#f1c40f';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = isBossProjectile ? '#68078c' : '#b7950b';
    ctx.stroke();
  }
}

function drawServerBoss() {
  const boss = serverBoss;
  if (!boss || !boss.active) return;

  const radius = BOSS_RADIUS;
  const maxHealth = Math.max(1, boss.maxHealth || 2000);
  const health = Math.max(0, Math.min(maxHealth, boss.health || 0));
  const healthPercent = health / maxHealth;

  // Large, dark-purple body, drawn in world coordinates like the rest of the scene.
  ctx.beginPath();
  ctx.arc(boss.x, boss.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#24132f';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#6c3483';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(boss.x, boss.y, radius * 0.66, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(171, 97, 207, 0.7)';
  ctx.stroke();

  ctx.save();
  ctx.fillStyle = '#f5eef8';
  ctx.font = 'bold 17px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FINAL BOSS', boss.x, boss.y);
  ctx.restore();

  const barWidth = BOSS_HEALTH_BAR_WIDTH;
  const barHeight = BOSS_HEALTH_BAR_HEIGHT;
  const barX = boss.x - barWidth / 2;
  const barY = boss.y - radius - 34;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = '#8e44ad';
  ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#1b0d22';
  ctx.strokeRect(barX, barY, barWidth, barHeight);

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`BOSS ${health} / ${maxHealth}`, boss.x, barY - 4);
  ctx.restore();
}

// Render NPCs from the authoritative server state.
function drawServerNPCs() {
  for (const npc of serverNPCs) {
    const radius = npc.radius || NPC_RADIUS;

    ctx.beginPath();
    ctx.arc(npc.x, npc.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = NPC_COLOR;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = NPC_OUTLINE;
    ctx.stroke();

    if (npc.state === 'recruited') {
      const labelY = npc.y - radius - 5;
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText('Follower', npc.x, labelY);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('Follower', npc.x, labelY);
      ctx.restore();
    }
  }
}

// Render the server's enemies (Goblin / Scorpion / Golem) with their live health
function drawServerEnemies() {
  for (const e of serverEnemies) {
    const def = ENEMY_TYPES[e.type] || ENEMY_TYPES.forestGoblin;
    const radius = e.radius || def.radius;
    const color = e.color || def.color;
    const maxHealth = e.maxHealth || def.maxHealth;

    // Body (green goblin, orange scorpion, light blue golem)
    ctx.beginPath();
    ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.stroke();

    // Small health bar above the enemy, straight from the server state
    const barWidth = Math.max(24, radius * 2);
    const barHeight = 4;
    const bx = e.x - barWidth / 2;
    const by = e.y - radius - 9;
    const pct = Math.max(0, Math.min(1, (e.health != null ? e.health : maxHealth) / maxHealth));

    ctx.fillStyle = '#333';
    ctx.fillRect(bx, by, barWidth, barHeight);
    ctx.fillStyle = pct > 0.5 ? '#2ecc71' : pct > 0.25 ? '#f39c12' : '#e74c3c';
    ctx.fillRect(bx, by, barWidth * pct, barHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(bx, by, barWidth, barHeight);
  }
}

// Render server resources (trees / rocks)
function drawResources() {
  for (const r of serverResources) {
    const def = RESOURCE_TYPES[r.type] || RESOURCE_TYPES.tree;
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.outline;
    ctx.lineWidth = 3;

    if (def.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(r.x, r.y, def.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      const size = def.radius * 2;
      ctx.fillRect(r.x - def.radius, r.y - def.radius, size, size);
      ctx.strokeRect(r.x - def.radius, r.y - def.radius, size, size);
    }
  }
}

// Render server structures (walls)
function drawStructures() {
  for (const s of serverStructures) {
    const w = s.width || WALL_WIDTH;
    const h = s.height || WALL_HEIGHT;
    const left = s.x - w / 2;
    const top = s.y - h / 2;

    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(left, top, w, h);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#5a3a1a';
    ctx.strokeRect(left, top, w, h);

    if (s.health < (s.maxHealth || WALL_MAX_HEALTH)) {
      const pct = Math.max(0, s.health) / (s.maxHealth || WALL_MAX_HEALTH);
      const barY = top - 8;
      ctx.fillStyle = '#333';
      ctx.fillRect(left, barY, w, 4);
      ctx.fillStyle = pct > 0.5 ? '#2ecc71' : pct > 0.25 ? '#f39c12' : '#e74c3c';
      ctx.fillRect(left, barY, w * pct, 4);
    }
  }
}

function drawNightOverlay() {
  if (!timeOfDay.isNight()) return;
  ctx.fillStyle = NIGHT_OVERLAY_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// HUD: fixed to top left of screen
function drawHUD() {
  const padding = 12;
  const lineHeight = 24;
  const lines = 4;
  const panelWidth = 150;
  const panelHeight = padding * 2 + lineHeight * lines - 4;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(10, 10, panelWidth, panelHeight);

  // Look up local player inventory via socket.id
  const me = serverPlayers[socket.id];
  const wood = me && me.inventory ? me.inventory.wood : player.inventory.wood;
  const stone = me && me.inventory ? me.inventory.stone : player.inventory.stone;
  const temp = me && me.temperature != null ? me.temperature : player.temperature;

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Wood: ' + wood, 10 + padding, 10 + padding);
  ctx.fillText('Stone: ' + stone, 10 + padding, 10 + padding + lineHeight);
  ctx.fillText('Temp: ' + Math.round(temp), 10 + padding, 10 + padding + lineHeight * 2);

  const night = timeOfDay.isNight();
  ctx.fillStyle = night ? '#85c1e9' : '#f7dc6f';
  ctx.fillText(
    (night ? 'NIGHT ' : 'DAY ') + timeOfDay.secondsRemaining() + 's',
    10 + padding,
    10 + padding + lineHeight * 3
  );
}

function drawWorldEvent() {
  if (!worldEventMessage) return;

  const maxWidth = canvas.width * 0.9;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  let fontSize = Math.min(64, Math.max(22, Math.floor(canvas.width / 18)));
  let lines = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const wrapMessage = () => {
    const words = worldEventMessage.split(/\s+/);
    const wrapped = [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        wrapped.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) wrapped.push(line);
    return wrapped;
  };

  do {
    ctx.font = `900 ${fontSize}px Georgia, serif`;
    lines = wrapMessage();
    const lineHeight = Math.ceil(fontSize * 1.18);
    if (lines.length * lineHeight <= canvas.height * 0.8 || fontSize <= 22) break;
    fontSize -= 2;
  } while (fontSize >= 22);

  const lineHeight = Math.ceil(fontSize * 1.18);
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, fontSize / 10);
  ctx.strokeStyle = 'rgba(24, 12, 0, 0.95)';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = 'rgba(255, 215, 0, 0.55)';
  ctx.shadowBlur = 18;

  for (let i = 0; i < lines.length; i++) {
    const y = firstY + i * lineHeight;
    ctx.strokeText(lines[i], centerX, y, maxWidth);
    ctx.fillText(lines[i], centerX, y, maxWidth);
  }

  ctx.restore();
}

function update(dt) {
  timeOfDay.update(dt);
  sendMovement();
  syncLocalPlayer();
  camera.follow(player);
  player.aim();
}

function render() {
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  drawWorld();

  for (const sk of serverSkeletons) {
    const half = 12;
    ctx.beginPath();
    ctx.moveTo(sk.x - half, sk.y - half);
    ctx.lineTo(sk.x + half, sk.y + half);
    ctx.moveTo(sk.x + half, sk.y - half);
    ctx.lineTo(sk.x - half, sk.y + half);
    ctx.lineCap = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#555';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  for (const c of serverCampfires) {
    const radius = c.warmthRadius || CAMPFIRE_WARMTH_RADIUS;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 235, 59, 0.2)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(243, 156, 18, 0.4)';
    ctx.stroke();

    const size = c.size || CAMPFIRE_SIZE;
    const half = size / 2;
    ctx.fillStyle = '#e67e22';
    ctx.fillRect(c.x - half, c.y - half, size, size);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#b95c0c';
    ctx.strokeRect(c.x - half, c.y - half, size, size);
  }
  drawResources();
  drawStructures();
  drawServerBoss();
  drawServerNPCs();
  drawServerEnemies();
  drawServerProjectiles();
  drawPlayers();
  ctx.restore();

  drawNightOverlay();
  drawHUD();
  drawWorldEvent();
}

let lastTime = performance.now();

function gameLoop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  update(dt);
  render();
  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);