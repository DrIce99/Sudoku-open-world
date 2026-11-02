// ==================== BOSS E SURVIVAL TRIAL (autoritativi sul server) ====================
// Il server decide spawn, vita, timer e attacchi; i client mostrano solo lo stato
// ricevuto. Così tutti i giocatori vedono gli stessi boss e combattono insieme.
//
// Messaggi verso i client (solo quelli nel mondo, non la home):
//   bosses          { list }                    stato di tutti i boss (4 volte al secondo)
//   boss_spawned    { boss }
//   boss_started    { bossId }                  la Survival Trial è iniziata
//   boss_telegraph  { bossId, attackId, cells, duration, dmgPct, minDmg }
//   boss_strike     { bossId, attackId, cells } il colpo cade: chi è sulle celle viene colpito
//   boss_hurt       { bossId, amount, unit }    riga/colonna/3x3/finestra completata
//   boss_defeated   { bossId, participants, xp }
//   boss_failed     { bossId }
//   boss_despawned  { bossId }
// Dai client: player_died { x, y } (serve alla Survival Trial).

import { randomUUID } from "crypto";
import { isPlayableZone, revealedMask, mod } from "./worldgen.js";

const TICK_MS = 100;
const STATE_EVERY_MS = 250;
const SPAWN_EVERY_MS = 30000;
const BOSSES_NEAR_PLAYER = 3;          // massimo di boss nei dintorni di un giocatore
const NEAR_BLOCKS = 25;                // "dintorni" in blocchi 3x3
const DESPAWN_AFTER_MS = 3 * 60 * 1000; // nessun giocatore vicino per questo tempo -> sparisce
const TRIAL_ABANDON_MS = 30000;        // Survival Trial iniziata ma vuota -> fallita
const DEFEAT_XP = 500;

const TYPES = {
    sudoku_hp: {
        name: "Sudoku Core Guardian",
        maxHp: 1200,
        attackInterval: 7000,
        telegraph: 1800,
        drunkAreas: 2,
        dmgPct: 0.25,
        minDmg: 10,
        regenPerSec: 15,       // sotto il 50% di celle piene
        decayPerSec: 30,       // sopra: 30 * (riempimento - 0.49) al secondo
        unitDamage: 120,
        windowDamage: 350
    },
    survival_trial: {
        name: "Survival Trial",
        maxHp: 1000,           // la barra rappresenta il tempo rimasto
        duration: 180,
        attackInterval: 4200,
        telegraph: 1400,
        drunkAreas: 3,
        dmgPct: 0.35,
        minDmg: 12,
        numberTime: 1,         // secondi tolti da ogni numero corretto nell'area
        unitTime: 6,
        windowTime: 20
    }
};

export function createBossSystem({ zoneState, worldPlayers, broadcast }) {
    const bosses = new Map();
    let spawnTimer = 0, stateTimer = 0, hadBosses = false;

    /* ---------------- geometria ---------------- */
    const containsCell = (b, x, y) => x >= b.bx * 3 && x < b.bx * 3 + 9 && y >= b.by * 3 && y < b.by * 3 + 9;
    const containsBlock = (b, zx, zy) => zx >= b.bx && zx < b.bx + 3 && zy >= b.by && zy < b.by + 3;
    const center = b => ({ x: b.bx * 3 + 4.5, y: b.by * 3 + 4.5 });

    function cellFilled(x, y) {
        const zx = Math.floor(x / 3), zy = Math.floor(y / 3);
        const lx = mod(x, 3), ly = mod(y, 3);
        if (revealedMask(zx, zy) & (1 << (ly * 3 + lx))) return true;
        return !!zoneState(`${zx},${zy}`).writes[`${lx},${ly}`];
    }

    function fillRatio(b) {
        let n = 0;
        for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (cellFilled(b.bx * 3 + x, b.by * 3 + y)) n++;
        return n / 81;
    }

    const playersInside = b => worldPlayers().filter(p => containsCell(b, p.x, p.y));

    function view(b) {
        return {
            id: b.id, type: b.type, name: b.name, bx: b.bx, by: b.by,
            hp: Math.round(b.hp), maxHp: b.maxHp,
            timeLeft: b.timeLeft ?? null, duration: b.duration ?? null, started: !!b.started
        };
    }

    /* ---------------- spawn ---------------- */
    function isSpawnAreaValid(bx, by) {
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
            if (!isPlayableZone(bx + dx, by + dy)) return false;
            for (const other of bosses.values()) if (containsBlock(other, bx + dx, by + dy)) return false;
        }
        // nessun giocatore deve trovarsi già dentro l'area
        return !worldPlayers().some(p => p.x >= bx * 3 && p.x < bx * 3 + 9 && p.y >= by * 3 && p.y < by * 3 + 9);
    }

    function spawnNear(p, type) {
        const pzx = Math.floor(p.x / 3), pzy = Math.floor(p.y / 3);
        for (let i = 0; i < 50; i++) {
            const dist = 5 + Math.random() * 15;
            const angle = Math.random() * Math.PI * 2;
            const bx = Math.floor(pzx + Math.cos(angle) * dist);
            const by = Math.floor(pzy + Math.sin(angle) * dist);
            if (Math.hypot(bx - pzx, by - pzy) < 5 || !isSpawnAreaValid(bx, by)) continue;
            return spawn(type, bx, by);
        }
        return null;
    }

    function spawn(type, bx, by) {
        const t = TYPES[type];
        const now = Date.now();
        const b = {
            id: randomUUID(), type, name: t.name, bx, by,
            maxHp: t.maxHp, hp: t.maxHp,
            attackTimer: 0, attacking: false,
            units: new Set(), windowDone: false,
            participants: new Set(),
            lastNearby: now
        };
        if (type === "survival_trial") {
            b.duration = t.duration;
            b.timeLeft = t.duration;
            b.started = false;
            b.emptySince = null;
        }
        bosses.set(b.id, b);
        broadcast({ type: "boss_spawned", boss: view(b) });
        return b;
    }

    function trySpawn() {
        const players = worldPlayers();
        if (!players.length) return;
        // un giocatore a caso: se ha pochi boss nei dintorni, ne nasce uno vicino a lui
        const p = players[Math.floor(Math.random() * players.length)];
        const near = [...bosses.values()].filter(b =>
            Math.hypot(b.bx + 1.5 - p.x / 3, b.by + 1.5 - p.y / 3) < NEAR_BLOCKS).length;
        if (near >= BOSSES_NEAR_PLAYER) return;
        spawnNear(p, Math.random() < 0.5 ? "sudoku_hp" : "survival_trial");
    }

    /* ---------------- esito ---------------- */
    function defeat(b) {
        if (!bosses.delete(b.id)) return;
        broadcast({ type: "boss_defeated", bossId: b.id, participants: [...b.participants], xp: DEFEAT_XP });
    }

    function fail(b) {
        if (!bosses.delete(b.id)) return;
        broadcast({ type: "boss_failed", bossId: b.id });
    }

    function damage(b, amount) {
        b.hp = Math.max(0, b.hp - amount);
        if (b.hp <= 0) defeat(b);
    }

    function reduceTime(b, seconds) {
        b.timeLeft = Math.max(0, b.timeLeft - seconds);
        b.hp = b.timeLeft / b.duration * b.maxHp;
        if (b.timeLeft <= 0) defeat(b);
    }

    function startTrial(b) {
        if (b.started) return;
        b.started = true;
        broadcast({ type: "boss_started", bossId: b.id });
    }

    /* ---------------- attacchi ---------------- */
    function lineCells(b) {
        const isRow = Math.random() < 0.5;
        const index = Math.floor(Math.random() * 9);
        return Array.from({ length: 9 }, (_, i) => ({
            x: b.bx * 3 + (isRow ? i : index),
            y: b.by * 3 + (isRow ? index : i)
        }));
    }

    // "Passeggiata dell'ubriaco": aree contigue di 6 celle
    function drunkCells(b, areas) {
        const cells = [];
        for (let a = 0; a < areas; a++) {
            let cx = Math.floor(Math.random() * 9), cy = Math.floor(Math.random() * 9);
            const visited = new Set();
            while (visited.size < 6) {
                const key = cx + "," + cy;
                if (!visited.has(key)) {
                    visited.add(key);
                    cells.push({ x: b.bx * 3 + cx, y: b.by * 3 + cy });
                }
                const [dx, dy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][Math.floor(Math.random() * 4)];
                cx = Math.max(0, Math.min(8, cx + dx));
                cy = Math.max(0, Math.min(8, cy + dy));
            }
        }
        return cells;
    }

    function attack(b) {
        const t = TYPES[b.type];
        const cells = Math.random() < 0.5 ? lineCells(b) : drunkCells(b, t.drunkAreas);
        const attackId = randomUUID();
        b.attacking = true;

        broadcast({ type: "boss_telegraph", bossId: b.id, attackId, cells, duration: t.telegraph, dmgPct: t.dmgPct, minDmg: t.minDmg });

        setTimeout(() => {
            b.attacking = false;
            b.attackTimer = 0;
            if (!bosses.has(b.id)) {
                broadcast({ type: "boss_strike", bossId: b.id, attackId, cells, cancelled: true });
                return;
            }
            // prima il colpo (i client decidono se sono stati colpiti), poi i numeri cancellati
            broadcast({ type: "boss_strike", bossId: b.id, attackId, cells });
            for (const { x, y } of cells) {
                const zx = Math.floor(x / 3), zy = Math.floor(y / 3);
                const lx = mod(x, 3), ly = mod(y, 3);
                const zone = zoneState(`${zx},${zy}`);
                // i numeri iniziali (comprese le celle immortali) non sono "writes": restano
                if (!zone.writes[`${lx},${ly}`]) continue;
                delete zone.writes[`${lx},${ly}`];
                broadcast({ type: "write", zoneKey: `${zx},${zy}`, cx: lx, cy: ly, val: 0, color: null });
            }
        }, t.telegraph);
    }

    /* ---------------- ciclo ---------------- */
    function tick(dt) {
        const now = Date.now();

        spawnTimer += dt;
        if (spawnTimer >= SPAWN_EVERY_MS) {
            spawnTimer = 0;
            trySpawn();
        }

        const players = worldPlayers();
        for (const b of [...bosses.values()]) {
            const t = TYPES[b.type];
            const inside = players.filter(p => containsCell(b, p.x, p.y));
            const c = center(b);
            if (players.some(p => Math.abs(p.x - c.x) < 60 && Math.abs(p.y - c.y) < 60)) b.lastNearby = now;
            inside.forEach(p => b.participants.add(p.playerId));

            if (b.type === "sudoku_hp") {
                // la vita cambia solo mentre qualcuno sta combattendo
                if (inside.length) {
                    const ratio = fillRatio(b);
                    if (ratio < 0.5) b.hp = Math.min(b.maxHp, b.hp + t.regenPerSec * dt / 1000);
                    else damage(b, t.decayPerSec * (ratio - 0.49) * dt / 1000);
                    if (!bosses.has(b.id)) continue;
                }
            } else {
                if (!b.started && inside.length) startTrial(b);
                if (b.started) {
                    reduceTime(b, dt / 1000);
                    if (!bosses.has(b.id)) continue;
                    if (inside.length) b.emptySince = null;
                    else if (!b.emptySince) b.emptySince = now;
                    else if (now - b.emptySince > TRIAL_ABANDON_MS) { fail(b); continue; }
                }
            }

            if (inside.length && !b.attacking) {
                b.attackTimer += dt;
                if (b.attackTimer >= t.attackInterval) attack(b);
            }

            if (!inside.length && !b.started && now - b.lastNearby > DESPAWN_AFTER_MS) {
                bosses.delete(b.id);
                broadcast({ type: "boss_despawned", bossId: b.id });
            }
        }

        stateTimer += dt;
        if (stateTimer >= STATE_EVERY_MS && (bosses.size || hadBosses)) {
            stateTimer = 0;
            hadBosses = bosses.size > 0;
            broadcast({ type: "bosses", list: [...bosses.values()].map(view) });
        }
    }

    let last = Date.now();
    setInterval(() => {
        const now = Date.now();
        tick(now - last);
        last = now;
    }, TICK_MS);

    /* ---------------- eventi dal mondo ---------------- */

    // Un numero corretto è stato scritto in (x, y) da p
    function onWrite(x, y, p) {
        for (const b of [...bosses.values()]) {
            if (!containsCell(b, x, y)) continue;
            const t = TYPES[b.type];
            b.participants.add(p.playerId);

            if (b.type === "survival_trial") {
                startTrial(b);
                reduceTime(b, t.numberTime);
                if (!bosses.has(b.id)) continue;
            }

            // Righe / colonne / 3x3 dell'area completate: ognuna conta una sola volta
            const x0 = b.bx * 3, y0 = b.by * 3;
            const bx = x0 + Math.floor((x - x0) / 3) * 3, by = y0 + Math.floor((y - y0) / 3) * 3;
            const units = [
                ["row", `row|${y}`, Array.from({ length: 9 }, (_, i) => [x0 + i, y])],
                ["col", `col|${x}`, Array.from({ length: 9 }, (_, i) => [x, y0 + i])],
                ["box", `box|${bx},${by}`, Array.from({ length: 9 }, (_, i) => [bx + i % 3, by + Math.floor(i / 3)])]
            ];
            for (const [unit, key, cells] of units) {
                if (b.units.has(key) || !cells.every(([cx, cy]) => cellFilled(cx, cy))) continue;
                b.units.add(key);
                reward(b, unit, b.type === "sudoku_hp" ? t.unitDamage : t.unitTime);
                if (!bosses.has(b.id)) break;
            }
            if (bosses.has(b.id) && !b.windowDone && fillRatio(b) === 1) {
                b.windowDone = true;
                reward(b, "window", b.type === "sudoku_hp" ? t.windowDamage : t.windowTime);
            }
        }
    }

    function reward(b, unit, amount) {
        broadcast({ type: "boss_hurt", bossId: b.id, amount, unit });
        if (b.type === "sudoku_hp") damage(b, amount);
        else reduceTime(b, amount);
    }

    // Un giocatore è morto: se era l'unico dentro una Survival Trial, la prova fallisce
    function onPlayerDied(p, x, y) {
        for (const b of [...bosses.values()]) {
            if (b.type !== "survival_trial" || !b.started || !containsCell(b, x, y)) continue;
            const others = playersInside(b).filter(o => o.playerId !== p.playerId);
            if (!others.length) fail(b);
        }
    }

    // Stato iniziale per chi entra nel mondo
    const snapshot = () => ({ type: "bosses", list: [...bosses.values()].map(view) });

    // Id del boss nella cui arena si trova la cella (null se fuori da ogni arena)
    function arenaAt(x, y) {
        for (const b of bosses.values()) if (containsCell(b, x, y)) return b.id;
        return null;
    }

    return { onWrite, onPlayerDied, snapshot, arenaAt, cellFilled };
}
