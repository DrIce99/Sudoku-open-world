// ==================== ABILITÀ DELLE CLASSI ====================
// Tutto è deciso dal server: il client manda solo { type: "ability", target? }
// (Spazio; clic per il Blink, rotella + Spazio per il Salto) e riceve lo stato da
// mostrare nell'HUD:
//   ability_state { key, name, kind, active, cooldownMs, activeMs, stored, cap, locked, message }
//   ability_fx    { kind, by, ... }              effetti visibili agli altri
//   shield        { amount, duration, from }     scudo della classe 9 (variante Scudo)
//   heal          { amount, from }               cure della classe 5
//   portals       { list: [{ a, b, color }] }    portali della classe 4 (variante Portale)
// Dai client arriva anche player_hit { dmg }: serve all'Accumulo (classe 2b).
//
// ATK nascosto: cresce con il livello del giocatore insieme agli HP, più il bonus ATK
// permanente guadagnato sconfiggendo i boss (p.bonus.atk, vedi server.js).
// Ogni livello della variante oltre il primo potenzia l'abilità del 5%.
// L'Amplificatore (9a) nel party potenzia del 50% le abilità degli altri, tranne 3a, 4, 6 e 9.

import { variantKey } from "./classes.js";
import { solutionAtCell, isPlayableZone, revealedMask, mod } from "./worldgen.js";

const FURY_UNLOCK_LEVEL = 5;        // livello giocatore per attivare la Furia (la passiva c'è subito)
const FURY_TICK_MS = 1500;
const FURY_BASE = 0.05, FURY_BONUS = 0.2;
const FURY_TOGGLE_LOCK_MS = 2000;   // dopo l'attivazione
const FURY_COOLDOWN_MS = 10000;     // dopo la disattivazione
const SACRIFICE_MULT = 2, SACRIFICE_COOLDOWN_MS = 5000;
const STORE_SHARE = 0.2, STORE_CAP_MULT = 10, STORE_COOLDOWN_MS = 8000;
const AURA_REDUCTION = 0.3, MAX_REDUCTION = 0.75;
const JUMP_RANGE = 45, JUMP_COOLDOWN_MS = 2500;
const HINT_EVERY_MS = 20000, REGEN_EVERY_MS = 3000, REGEN_SHARE = 0.03, HINT_COLOR = "#38b764";
const HEAL_SHARE = 0.15, HEAL_COOLDOWN_MS = 5000;
const SUPPORT_RADIUS = 9;           // "giocatori circostanti" per le classi 5
const BLINK_RANGE = 8, BLINK_COOLDOWN_MS = 3000;
const PARRY_WINDOW_MS = 400, PARRY_MISS_COOLDOWN_MS = 10000;
const COUNTER_MULT = 3.5, COUNTER_MS = 15000;
const STUN_MS = 5000, STUN_COOLDOWN_MS = 15000;
const SHIELD_SHARE = 0.1, SHIELD_MS = 30000;
const AMP_MULT = 1.5;
const AMP_EXCLUDED = new Set(["3a", "4a", "4b", "6a", "6b", "9a", "9b"]);

export const ABILITY_DEFS = {
    "1a": { name: "Furia", kind: "toggle" },
    "2a": { name: "Sacrificio", kind: "instant" },
    "2b": { name: "Accumulo", kind: "charge" },
    "3a": { name: "Bastione", kind: "passive" },
    "3b": { name: "Aura", kind: "passive" },
    "4a": { name: "Salto", kind: "target" },
    "4b": { name: "Portale", kind: "passive" },
    "5a": { name: "Rigenerazione", kind: "passive" },
    "5b": { name: "Cura", kind: "instant" },
    "6a": { name: "Passo libero", kind: "passive" },
    "6b": { name: "Blink", kind: "click" },
    "7a": { name: "Parry", kind: "instant" },
    "7b": { name: "Aura di risposta", kind: "shape" },
    "8a": { name: "Congelamento", kind: "instant" },
    "9a": { name: "Amplificatore", kind: "passive" },
    "9b": { name: "Scudo", kind: "passive" }
};

const COUNTER_SHAPES = ["box", "row", "col"];
const SHAPE_NAMES = { box: "3x3", row: "riga", col: "colonna" };

export function createAbilitySystem({ players, bossSystem, zoneState, broadcast, sendJson, partyMates, forceMove, occupantAt, nearestFree, broadcastPlayers }) {
    const worldPlayers = () => Object.values(players).filter(p => !p.lobby);
    const keyOf = p => p.cls ? variantKey(p.cls.classId, p.cls.variant) : null;
    const atkOf = p => 10 + 2 * (Math.max(1, p.level || 1) - 1) + (p.bonus?.atk || 0);
    const power = p => 1 + 0.05 * (Math.max(1, p.cls?.level || 1) - 1);
    const amp = p => !AMP_EXCLUDED.has(keyOf(p)) && partyMates(p).some(m => m !== p && keyOf(m) === "9a") ? AMP_MULT : 1;
    const strength = p => power(p) * amp(p);
    const ab = p => p.ab ??= { cooldownUntil: 0, active: false, activeSince: 0, stored: 0, furyTimer: 0, hintTimer: 0, regenTimer: 0 };
    const near = (p, q, r = SUPPORT_RADIUS) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= r;

    const cellKey = (x, y) => [`${Math.floor(x / 3)},${Math.floor(y / 3)}`, `${mod(x, 3)},${mod(y, 3)}`];
    const writeAt = (x, y) => { const [zk, ck] = cellKey(x, y); return zoneState(zk).writes[ck] || null; };

    // Valore mostrato in una cella (numero iniziale o scritto), 0 se vuota
    const valueAt = (x, y) => bossSystem.cellFilled(x, y) ? solutionAtCell(x, y) : 0;

    function eraseCell(x, y) {
        const [zoneKey, ck] = cellKey(x, y);
        delete zoneState(zoneKey).writes[ck];
        const [cx, cy] = ck.split(",").map(Number);
        broadcast({ type: "write", zoneKey, cx, cy, val: 0, color: null });
    }

    // Numeri di valore `val` scritti da p ancora presenti in un rettangolo di celle
    function ownNumbersIn(x0, y0, x1, y1, p, val) {
        const out = [];
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const w = writeAt(x, y);
            if (w && w.val === val && w.by === p.playerId) out.push({ x, y });
        }
        return out;
    }
    const ownNumbers = (b, p, val) => ownNumbersIn(b.bx * 3, b.by * 3, b.bx * 3 + 8, b.by * 3 + 8, p, val);

    /* ---------------- stato per l'HUD ---------------- */
    function state(p, message = null, error = false) {
        const key = keyOf(p);
        const def = ABILITY_DEFS[key];
        if (!key) return { key: null, kind: "none", message, error };
        if (!def) return { key, kind: "soon", name: "In arrivo", message, error };
        const a = ab(p), now = Date.now();
        return {
            key, name: def.name, kind: def.kind,
            active: a.active,
            cooldownMs: Math.max(0, a.cooldownUntil - now),
            activeMs: a.active ? now - a.activeSince : 0,
            stored: Math.round(a.stored),
            cap: key === "2b" ? Math.round(atkOf(p) * STORE_CAP_MULT * strength(p)) : null,
            locked: key === "1a" && (p.level || 1) < FURY_UNLOCK_LEVEL ? FURY_UNLOCK_LEVEL : null,
            shape: key === "7b" && p.counter && p.counter.until > now ? SHAPE_NAMES[p.counter.shape] : null,
            message, error
        };
    }

    const sendState = (p, message, error) => sendJson(p, { type: "ability_state", ...state(p, message, error) });
    const fail = (p, message) => sendState(p, message, true);

    function setClass(p, cls) {
        p.cls = cls;
        p.ab = null;
        p.counter = null;
        sendState(p);
        broadcastPortalsIfChanged();
    }

    /* ---------------- attivazione ---------------- */
    function use(p, target = null) {
        const key = keyOf(p);
        const a = ab(p), now = Date.now();
        const b = bossSystem.bossAt(p.x, p.y);

        if (!key) return fail(p, "Scegli una classe in home (CLASSI & GACHA)");
        if (!ABILITY_DEFS[key]) return fail(p, "Abilità di questa classe in arrivo");
        if (ABILITY_DEFS[key].kind === "passive") return fail(p, "Abilità passiva: è sempre attiva");

        if (key === "1a") {
            if ((p.level || 1) < FURY_UNLOCK_LEVEL) return fail(p, `La Furia si sblocca al livello ${FURY_UNLOCK_LEVEL}`);
            if (a.active) {
                if (now - a.activeSince < FURY_TOGGLE_LOCK_MS) return fail(p, "Aspetta un attimo prima di disattivarla");
                a.active = false;
                a.cooldownUntil = now + FURY_COOLDOWN_MS;
                return sendState(p, "Furia disattivata");
            }
            if (now < a.cooldownUntil) return fail(p, "Furia in ricarica");
            a.active = true;
            a.activeSince = now;
            broadcast({ type: "ability_fx", kind: "fury", by: p.playerId, x: p.x, y: p.y });
            return sendState(p, "FURIA! Danni +, ma subisci il 50% in più");
        }

        // Aura di risposta: Spazio cambia la forma dell'ultima aura (nessuna ricarica)
        if (key === "7b") {
            const c = p.counter;
            if (!c || c.until < now) return fail(p, "Scrivi un 7 nell'arena di un boss per creare l'aura");
            c.shape = COUNTER_SHAPES[(COUNTER_SHAPES.indexOf(c.shape) + 1) % COUNTER_SHAPES.length];
            return sendState(p, `Aura di risposta: ${SHAPE_NAMES[c.shape]}`);
        }

        if (now < a.cooldownUntil) return fail(p, "Abilità in ricarica");

        if (key === "2a") {
            if (!b) return fail(p, "Usala nell'arena di un boss");
            const cells = ownNumbers(b, p, 2);
            if (!cells.length) return fail(p, "Non hai 2 nell'arena da sacrificare");
            cells.forEach(c => eraseCell(c.x, c.y));
            broadcast({ type: "ability_fx", kind: "sacrifice", by: p.playerId, cells });
            bossSystem.damageBoss(b, atkOf(p) * SACRIFICE_MULT * cells.length * strength(p), p, "sacrifice");
            a.cooldownUntil = now + SACRIFICE_COOLDOWN_MS;
            return sendState(p, `Sacrificati ${cells.length} numeri 2`);
        }

        if (key === "2b") {
            if (!a.active) {
                a.active = true;
                a.activeSince = now;
                a.stored = 0;
                return sendState(p, "Accumulo: i danni subiti dai giocatori si caricano");
            }
            if (!b) return fail(p, "Rilascia l'accumulo dentro l'arena di un boss");
            const dmg = Math.min(a.stored, atkOf(p) * STORE_CAP_MULT * strength(p));
            a.active = false;
            a.stored = 0;
            a.cooldownUntil = now + STORE_COOLDOWN_MS;
            if (dmg > 0) {
                broadcast({ type: "ability_fx", kind: "release", by: p.playerId, x: p.x, y: p.y, amount: Math.round(dmg) });
                bossSystem.damageBoss(b, dmg, p, "release");
            }
            return sendState(p, dmg > 0 ? `Rilasciati ${Math.round(dmg)} danni` : "Nessun danno accumulato");
        }

        if (key === "4a") {
            const tx = Number(target?.x), ty = Number(target?.y);
            if (!Number.isInteger(tx) || !Number.isInteger(ty)) return fail(p, "Nessun 4 da raggiungere qui vicino (rotella per scegliere)");
            if (valueAt(tx, ty) !== 4) return fail(p, "Puoi saltare solo su un 4");
            if (!near(p, { x: tx, y: ty }, JUMP_RANGE)) return fail(p, "Quel 4 è troppo lontano");
            if (occupantAt(tx, ty, p)) return fail(p, "Il 4 è occupato da un altro giocatore");
            broadcast({ type: "ability_fx", kind: "jump", by: p.playerId, from: { x: p.x, y: p.y }, to: { x: tx, y: ty } });
            forceMove(p, tx, ty, "teleport");
            broadcastPlayers();
            a.cooldownUntil = now + JUMP_COOLDOWN_MS;
            return sendState(p);
        }

        if (key === "5b") {
            const hurt = worldPlayers().filter(q => near(p, q) && q.maxHp && q.hp < q.maxHp);
            if (!hurt.length) return fail(p, "Nessuno da curare qui vicino");
            const fives = ownNumbersIn(p.x - SUPPORT_RADIUS, p.y - SUPPORT_RADIUS, p.x + SUPPORT_RADIUS, p.y + SUPPORT_RADIUS, p, 5);
            if (!fives.length) return fail(p, "Non hai 5 qui vicino da sacrificare");
            // quanti 5 servono per curare del tutto il più ferito (al massimo quelli disponibili)
            const perNumber = (p.maxHp || 100) * HEAL_SHARE * strength(p);
            const needed = Math.max(...hurt.map(q => q.maxHp - q.hp));
            const used = fives.slice(0, Math.min(fives.length, Math.ceil(needed / perNumber)));
            const amount = Math.round(used.length * perNumber);
            used.forEach(c => eraseCell(c.x, c.y));
            broadcast({ type: "ability_fx", kind: "heal", by: p.playerId, cells: used });
            hurt.forEach(q => heal(q, amount, p));
            a.cooldownUntil = now + HEAL_COOLDOWN_MS;
            return sendState(p, `Sacrificati ${used.length} numeri 5: +${amount} HP a ${hurt.length} giocatori`);
        }

        if (key === "6b") {
            const tx = Number(target?.x), ty = Number(target?.y);
            if (!Number.isInteger(tx) || !Number.isInteger(ty)) return fail(p, "Clicca una cella del sudoku per il Blink");
            // dentro il sudoku attivo: l'arena del boss, oppure le celle vicine al giocatore
            const inside = b ? bossSystem.containsCell(b, tx, ty) : near(p, { x: tx, y: ty }, BLINK_RANGE);
            if (!inside) return fail(p, "Puoi fare Blink solo dentro il sudoku attivo");
            if (!isPlayableZone(Math.floor(tx / 3), Math.floor(ty / 3))) return fail(p, "Lì c'è un muro");
            if (occupantAt(tx, ty, p)) return fail(p, "La cella è occupata");
            broadcast({ type: "ability_fx", kind: "blink", by: p.playerId, from: { x: p.x, y: p.y }, to: { x: tx, y: ty } });
            forceMove(p, tx, ty, "blink");
            broadcastPlayers();
            a.cooldownUntil = now + BLINK_COOLDOWN_MS;
            return sendState(p);
        }

        if (key === "7a") {
            const pending = b && bossSystem.pendingAttack(b);
            const onTarget = pending?.cells.some(c => c.x === p.x && c.y === p.y);
            // fuori dall'attacco: nessuna penalità
            if (!onTarget) return fail(p, "Nessun colpo da parare: premi quando stai per essere colpito");
            if (pending.strikeAt - now > PARRY_WINDOW_MS) {
                a.cooldownUntil = now + PARRY_MISS_COOLDOWN_MS;
                return fail(p, "Troppo presto! Parry in ricarica");
            }
            pending.parried.add(p.playerId);
            broadcast({ type: "ability_fx", kind: "parry", by: p.playerId, x: p.x, y: p.y });
            bossSystem.damageBoss(b, atkOf(p) * pending.cells.length * strength(p), p, "parry");
            return sendState(p, "PARRY!");
        }

        if (key === "8a") {
            if (!b) return fail(p, "Usala nell'arena di un boss");
            bossSystem.stun(b, STUN_MS * amp(p), p);
            a.cooldownUntil = now + STUN_COOLDOWN_MS;
            return sendState(p, "Boss congelato!");
        }
    }

    function heal(q, amount, from) {
        if (!q.maxHp || q.hp >= q.maxHp || !(amount > 0)) return;
        q.hp = Math.min(q.maxHp, q.hp + amount);
        sendJson(q, { type: "heal", amount, from: from.name });
    }

    /* ---------------- passive ---------------- */

    // Indizio della Rigenerazione (5a): il numero giusto in una cella vuota del sudoku attivo:
    // l'arena del boss in cui si trova, altrimenti il 9x9 attivo del client (p.view, quello
    // bloccato con R), mai dentro l'arena di un boss in cui non si combatte
    function placeHint(p) {
        const b = bossSystem.bossAt(p.x, p.y);
        const pzx = Math.floor(p.x / 3), pzy = Math.floor(p.y / 3);
        const v = p.view && Math.abs(p.view.zx - pzx) <= 1 && Math.abs(p.view.zy - pzy) <= 1 ? p.view : { zx: pzx, zy: pzy };
        const [x0, y0] = b ? [b.bx * 3, b.by * 3] : [(v.zx - 1) * 3, (v.zy - 1) * 3];
        const empty = [];
        for (let y = y0; y < y0 + 9; y++) for (let x = x0; x < x0 + 9; x++) {
            const zx = Math.floor(x / 3), zy = Math.floor(y / 3);
            if (!isPlayableZone(zx, zy) || (revealedMask(zx, zy) & (1 << (mod(y, 3) * 3 + mod(x, 3)))) || writeAt(x, y)) continue;
            if (bossSystem.bossAt(x, y) !== b) continue;
            empty.push({ x, y });
        }
        if (!empty.length) return;
        const c = empty[Math.floor(Math.random() * empty.length)];
        const val = solutionAtCell(c.x, c.y);
        const [zoneKey, ck] = cellKey(c.x, c.y);
        // non è un "proprio" numero e non conta come danno: niente ricompense, niente effetti boss
        zoneState(zoneKey).writes[ck] = { val, color: HINT_COLOR, by: null, hint: true };
        const [cx, cy] = ck.split(",").map(Number);
        broadcast({ type: "write", zoneKey, cx, cy, val, color: HINT_COLOR, by: null, hint: true });
    }

    function tick(dt) {
        for (const p of worldPlayers()) {
            const key = keyOf(p);
            const a = ab(p);

            if (key === "1a") {
                a.furyTimer += dt;
                if (a.furyTimer < FURY_TICK_MS) continue;
                a.furyTimer = 0;
                const b = bossSystem.bossAt(p.x, p.y);
                if (!b) continue;
                const n = ownNumbers(b, p, 1).length;
                if (!n) continue;
                const coef = FURY_BASE + (a.active ? FURY_BONUS : 0);
                bossSystem.damageBoss(b, atkOf(p) * coef * n * strength(p), p, "fury");
            }

            if (key === "5a") {
                a.hintTimer += dt;
                a.regenTimer += dt;
                if (a.hintTimer >= HINT_EVERY_MS / amp(p)) {
                    a.hintTimer = 0;
                    placeHint(p);
                }
                if (a.regenTimer >= REGEN_EVERY_MS) {
                    a.regenTimer = 0;
                    const amount = Math.max(1, Math.round((p.maxHp || 100) * REGEN_SHARE * strength(p)));
                    worldPlayers().filter(q => near(p, q)).forEach(q => heal(q, amount, p));
                }
            }
        }

        // aure di risposta scadute
        for (const p of worldPlayers()) {
            if (p.counter && p.counter.until < Date.now()) {
                p.counter = null;
                sendState(p);
            }
        }
        broadcastPortalsIfChanged();
    }

    let last = Date.now();
    setInterval(() => {
        const now = Date.now();
        tick(now - last);
        last = now;
    }, 100);

    /* ---------------- portali (4b) ---------------- */
    // Gli ultimi due 4 scritti da un giocatore con la variante Portale, finché esistono entrambi
    function activePortals() {
        const list = [];
        for (const p of worldPlayers()) {
            if (keyOf(p) !== "4b" || p.anchors?.length !== 2) continue;
            const [a, b] = p.anchors;
            const ok = [a, b].every(c => { const w = writeAt(c.x, c.y); return w && w.val === 4 && w.by === p.playerId; });
            if (ok) list.push({ a, b, color: p.color, owner: p.playerId });
        }
        return list;
    }

    let portalSig = "";
    function broadcastPortalsIfChanged() {
        const list = activePortals();
        const sig = JSON.stringify(list);
        if (sig === portalSig) return;
        portalSig = sig;
        broadcast({ type: "portals", list });
    }
    const portalsSnapshot = () => ({ type: "portals", list: activePortals() });

    // Chi arriva su un capo del portale esce dall'altro (cella libera più vicina se occupato)
    function onMoved(p) {
        for (const portal of activePortals()) {
            const [from, to] = portal.a.x === p.x && portal.a.y === p.y ? [portal.a, portal.b]
                : portal.b.x === p.x && portal.b.y === p.y ? [portal.b, portal.a] : [null, null];
            if (!from) continue;
            const spot = occupantAt(to.x, to.y, p) ? nearestFree(to.x, to.y, p) : to;
            broadcast({ type: "ability_fx", kind: "portal", by: p.playerId, from, to: spot });
            forceMove(p, spot.x, spot.y, "portal");
            return true;
        }
        return false;
    }

    /* ---------------- eventi dal mondo ---------------- */

    // Un giocatore è stato colpito: chi sta accumulando (2b) nella stessa arena si carica
    function onPlayerHit(p, dmg) {
        const b = bossSystem.bossAt(p.x, p.y);
        if (!b || !(dmg > 0)) return;
        for (const q of worldPlayers()) {
            const a = q.ab;
            if (keyOf(q) !== "2b" || !a?.active || bossSystem.bossAt(q.x, q.y) !== b) continue;
            a.stored += dmg * STORE_SHARE * strength(q);
            sendState(q);
        }
    }

    function onWrite(p, x, y, val) {
        const key = keyOf(p);

        // Scudo (9b): protegge tutti nell'arena (o il party, fuori)
        if (key === "9b" && val === 9) {
            const amount = Math.round((p.maxHp || 100) * SHIELD_SHARE * power(p));
            const b = bossSystem.bossAt(p.x, p.y);
            const targets = b ? worldPlayers().filter(q => bossSystem.containsCell(b, q.x, q.y)) : partyMates(p);
            for (const q of targets) sendJson(q, { type: "shield", amount, duration: SHIELD_MS, from: p.name });
        }

        // Portale (4b): ogni 4 diventa un'ancora; le ultime due formano il portale
        if (key === "4b" && val === 4) {
            p.anchors = [...(p.anchors || []), { x, y }].slice(-2);
            broadcastPortalsIfChanged();
            if (p.anchors.length === 2) sendState(p, "Portale aperto tra i tuoi ultimi due 4");
            else sendState(p, "Ancora piazzata: scrivi un altro 4 per aprire il portale");
        }

        // Aura di risposta (7b): un 7 nell'arena crea l'aura (Spazio ne cambia la forma)
        if (key === "7b" && val === 7) {
            const b = bossSystem.bossAt(x, y);
            if (b) {
                p.counter = { bossId: b.id, x, y, shape: "box", until: Date.now() + COUNTER_MS };
                sendState(p, "Aura di risposta 3x3: Spazio per cambiare forma");
            }
        }
    }

    // Celle coperte da un'aura di risposta
    function counterRect(b, c) {
        if (c.shape === "row") return { x0: b.bx * 3, x1: b.bx * 3 + 8, y0: c.y, y1: c.y };
        if (c.shape === "col") return { x0: c.x, x1: c.x, y0: b.by * 3, y1: b.by * 3 + 8 };
        const zx = Math.floor(c.x / 3) * 3, zy = Math.floor(c.y / 3) * 3;
        return { x0: zx, x1: zx + 2, y0: zy, y1: zy + 2 };
    }

    const countersIn = b => worldPlayers().filter(q => keyOf(q) === "7b" && q.counter?.bossId === b.id && q.counter.until > Date.now());

    // Il colpo del boss cade: le aure di risposta colpite gli restituiscono il danno
    function onStrike(b, cells) {
        for (const q of countersIn(b)) {
            const r = counterRect(b, q.counter);
            const hits = cells.filter(c => c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1).length;
            if (!hits) continue;
            q.counter = null;
            sendState(q, `Aura di risposta: ${hits} celle colpite!`);
            broadcast({ type: "ability_fx", kind: "counter", by: q.playerId, rect: r });
            bossSystem.damageBoss(b, atkOf(q) * COUNTER_MULT * hits * strength(q), q, "counter");
        }
    }

    // Protezioni attive nell'arena al momento di un colpo (vedi bossServer.js)
    function strikeMods(b) {
        const inside = worldPlayers().filter(q => bossSystem.containsCell(b, q.x, q.y));
        const bastion = inside.some(q => keyOf(q) === "3a");
        const auras = inside
            .filter(q => keyOf(q) === "3b" && valueAt(q.x, q.y) === 3)
            .map(q => ({ x: q.x, y: q.y, reduction: Math.min(MAX_REDUCTION, AURA_REDUCTION * strength(q)) }));
        const rage = inside.filter(q => keyOf(q) === "1a" && q.ab?.active).map(q => q.playerId);
        const counters = countersIn(b).map(q => ({ ...counterRect(b, q.counter), color: q.color }));
        return { bastion, auras, rage, counters, protectValues: bastion ? [3] : [] };
    }

    return { use, setClass, sendState, onPlayerHit, onWrite, onMoved, onStrike, strikeMods, portalsSnapshot };
}
