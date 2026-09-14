const AN = window.anime || null;
const R = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = R(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; };
const pc = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const bit = v => 1 << (v - 1);
const mod = (v, c) => ((v % c) + c) % c;
const frame = () => new Promise(r => setTimeout(r, 0));

/* ========== DIFFICOLTA' (logica conservata per uso futuro) ==========
   Per cambiarla in futuro: window.setDifficolta("easy"|"mid"|"hard")    */
let difficolta = "easy";
const REVEAL = { easy: .40, mid: .32, hard: .24 };
window.setDifficolta = d => { if (REVEAL[d]) difficolta = d; };

/* ========== MOTORE SUDOKU (finestra 9x9) ========== */
const cells9 = []; for (let y = 0; y < 9; y++)for (let x = 0; x < 9; x++)cells9.push({ x, y, groups: [] });
const groups = [];
(function () {
    const add = l => { const id = groups.length; groups.push({ cells: l }); for (const c of l) cells9[c].groups.push(id); };
    for (let r = 0; r < 9; r++)add([...Array(9)].map((_, i) => r * 9 + i));
    for (let c = 0; c < 9; c++)add([...Array(9)].map((_, i) => i * 9 + c));
    for (let br = 0; br < 3; br++)for (let bc = 0; bc < 3; bc++) { const l = []; for (let rr = 0; rr < 3; rr++)for (let cc = 0; cc < 3; cc++)l.push((br * 3 + rr) * 9 + (bc * 3 + cc)); add(l); }
})();
function countSolutions(init, limit) {
    const vals = Uint8Array.from(init), gU = new Uint16Array(groups.length);
    for (let i = 0; i < 81; i++) { const v = vals[i]; if (!v) continue; for (const g of cells9[i].groups) { if (gU[g] & bit(v)) return limit; gU[g] |= bit(v); } }
    let nodes = 0, count = 0;
    function dfs() {
        if (count >= limit || nodes++ > 60000) { count = limit; return; }
        let best = -1, bm = 0, bc = 10;
        for (let i = 0; i < 81; i++) {
            if (vals[i]) continue; let m = 511; for (const g of cells9[i].groups) m &= ~gU[g];
            const c = pc(m); if (c < bc) { bc = c; best = i; bm = m; if (c <= 1) break; }
        }
        if (best < 0) { count++; return; } if (!bm) return;
        for (let v = 1; v <= 9; v++) {
            if (!(bm & bit(v))) continue;
            vals[best] = v; for (const g of cells9[best].groups) gU[g] |= bit(v);
            dfs();
            for (const g of cells9[best].groups) gU[g] &= ~bit(v); vals[best] = 0;
            if (count >= limit) return;
        }
    }
    dfs(); return count;
}
function solveWindow(fixed) {
    const vals = Uint8Array.from(fixed), gU = new Uint16Array(groups.length);
    for (let i = 0; i < 81; i++) {
        const v = vals[i];
        if (!v) continue;
        for (const g of cells9[i].groups) {
            if (gU[g] & bit(v)) return null; // Incongruenza rilevata nei vincoli fissi
            gU[g] |= bit(v);
        }
    }

    let iterations = 0;
    function dfs() {
        if (++iterations > 3000) return false; // Evita blocchi e ricorsione infinita
        let best = -1, bm = 0, bc = 10;
        for (let i = 0; i < 81; i++) {
            if (vals[i]) continue;
            let m = 511;
            for (const g of cells9[i].groups) m &= ~gU[g];
            const c = pc(m);
            if (c < bc) { bc = c; best = i; bm = m; if (c <= 1) break; }
        }
        if (best < 0) return true;
        if (!bm) return false;

        const o = [];
        for (let v = 1; v <= 9; v++) if (bm & bit(v)) o.push(v);
        shuffle(o);

        for (const v of o) {
            vals[best] = v;
            for (const g of cells9[best].groups) gU[g] |= bit(v);
            if (dfs()) return true;
            for (const g of cells9[best].groups) gU[g] &= ~bit(v);
            vals[best] = 0;
        }
        return false;
    }
    return dfs() ? vals : null;
}

/* ========== MONDO A ZONE (3x3 celle ciascuna) ========== */
let CELL = 52;

// SEED E IMMORTALI
let seed = Date.now();
let globalSolution = new Uint8Array(81);
let immortalMask = new Uint8Array(81);
function mulberry32(a) {
    return function () {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}
const stage = document.getElementById("stage"),
    worldEl = document.getElementById("world"), gridBg = document.getElementById("gridBg"),
    playerEl = document.getElementById("player"), activeBox = document.getElementById("activeBox");
const zones = new Map();
const cellEls = new Map(), notesEls = new Map(), notesMask = new Map();
const player = { x: 0, y: 0 };
const cam = { x: 1.5, y: 1.5 };
let follow = true, lockRect = null;
let curZone = { x: 0, y: 0 }, winZone = { x: 0, y: 0 }, mapMode = false, lastBlock = { bx: -99, by: -99 };
const doneUnits = new Set(), doneWindows = new Set();

const zKey = (x, y) => x + "," + y;
const zOf = (cx, cy) => ({ x: Math.floor(cx / 3), y: Math.floor(cy / 3) });
const zLocal = (cx, cy) => mod(cy, 3) * 3 + mod(cx, 3);
const getZone = (zx, zy) => zones.get(zKey(zx, zy));

/* ============================================================
   SAMURAI INFINITO — MASCHERA MONDO CON BLOCCHI 3x3 VUOTI
   ============================================================ */

// Ogni 4 blocchi c'è un corridoio verticale o orizzontale.
// Puoi cambiarlo con 3, 5, ecc., ma va cambiato anche lato server.
const EMPTY_PERIOD = 4;

// Seed del mondo. Se il server invia un seed, verrà usato quello.
let worldSeed = 20260222;

/* ============================================================
   PATTERN SAMURAI INFINITO (Sovrapposizione griglie 9x9)
   ============================================================ */

function isPlayableZone(zx, zy) {
    // Cerca se il blocco (zx, zy) fa parte di almeno una griglia 9x9 (3x3 blocchi)
    // Le origini delle griglie 9x9 si trovano sulle coordinate pari (2i, 2j) con (i + j) pari.
    for (let gx = zx - 2; gx <= zx; gx++) {
        if (mod(gx, 2) !== 0) continue;

        for (let gy = zy - 2; gy <= zy; gy++) {
            if (mod(gy, 2) !== 0) continue;

            // Un'origine (gx, gy) è valida se la somma delle sue coordinate di griglia è multiplo di 4
            if (mod(gx + gy, 4) === 0) {
                return true;
            }
        }
    }
    return false;
}

function isPlayableCell(cx, cy) {
    const zx = Math.floor(cx / 3);
    const zy = Math.floor(cy / 3);
    return isPlayableZone(zx, zy);
}

// Soluzione Sudoku infinita deterministica.
// Valida per finestre 9x9 allineate a blocchi 3x3.
function solutionAtCell(x, y) {
    const r = mod(y, 9);
    const c = mod(x, 9);
    return ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
}

// Hash deterministico per coordinate.
function hashCoord(x, y, salt = 0) {
    let h = worldSeed | 0;

    h = Math.imul(h ^ Math.imul(x | 0, 374761393), 668265263);
    h = Math.imul(h ^ Math.imul(y | 0, 19349663), 2246822519);
    h = Math.imul(h ^ Math.imul(salt | 0, 2654435761), 1597334677);

    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Celle "immortali" / givens fissi globali.
// Puoi regolare la percentuale cambiando 0.20.
function isImmortalCell(x, y) {
    return hashCoord(x, y, 11) < 0.20;
}

// Seed deterministico per ogni zona.
function zoneSeed(zx, zy) {
    let h = worldSeed | 0;

    h = Math.imul(h ^ Math.imul(zx | 0, 73856093), 668265263);
    h ^= Math.imul(zy | 0, 19349663);

    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;

    return h >>> 0;
}

// Finestra 9x9 attorno a una zona centrale.
// 0 = muro / blocco vuoto.
function buildViewSolution(centerZx, centerZy) {
    const out = new Uint8Array(81);

    const startX = (centerZx - 1) * 3;
    const startY = (centerZy - 1) * 3;

    for (let vy = 0; vy < 9; vy++) {
        for (let vx = 0; vx < 9; vx++) {
            const x = startX + vx;
            const y = startY + vy;
            const i = vy * 9 + vx;

            out[i] = isPlayableCell(x, y) ? solutionAtCell(x, y) : 0;
        }
    }

    return out;
}

/* ---------- sincronizzazione zone / scritture remote ---------- */

const pendingWrites = new Map();

// Invia la scoperta della zona al server
function requestZone(zx, zy) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: "fetch_zone",
            zoneKey: zKey(zx, zy),
            discover: true
        }));
    }
}

function applyRemoteWrite(msg) {
    const parts = String(msg.zoneKey).split(",");
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);

    const z = getZone(zx, zy);

    // Se la zona non è ancora stata generata, mette in coda la scrittura
    if (!z) {
        if (!pendingWrites.has(msg.zoneKey)) {
            pendingWrites.set(msg.zoneKey, []);
        }
        pendingWrites.get(msg.zoneKey).push(msg);
        return;
    }

    if (z.empty) return;

    let gx, gy;

    if (Number.isFinite(msg.gx) && Number.isFinite(msg.gy)) {
        gx = msg.gx;
        gy = msg.gy;
    } else {
        const lx = mod(Number(msg.cx), 3);
        const ly = mod(Number(msg.cy), 3);
        gx = zx * 3 + lx;
        gy = zy * 3 + ly;
    }

    const li = zLocal(gx, gy);
    const m = 1 << li;

    // Non sovrascrivere numeri iniziali (givens) o già scritti
    if ((z.rev & m) || (z.wr & m)) return;

    z.wr |= m;

    // Fallback su colore chiaro visibile (#38bdf8) se il colore salvato è scuro o assente
    const displayColor = (msg.color && msg.color !== "#1d4ed8") ? msg.color : "#38bdf8";

    const el = createNum(gx, gy, msg.val, "written_other");
    if (el) el.style.color = displayColor;

    if (zKey(zx, zy) === zKey(curZone.x, curZone.y)) {
        highlight();
    }
}

function applyRemoteWrites(zoneKey, writes) {
    const parts = String(zoneKey).split(",");
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);

    const z = getZone(zx, zy);
    if (!z || z.empty || !writes) return;

    for (const [k, w] of Object.entries(writes)) {
        const [lx, ly] = k.split(",").map(Number);

        applyRemoteWrite({
            zoneKey,
            cx: lx,
            cy: ly,
            gx: zx * 3 + lx,
            gy: zy * 3 + ly,
            val: w.val,
            color: w.color
        });
    }
}

function flushPendingWrites(zoneKey) {
    const list = pendingWrites.get(zoneKey);
    if (!list) return;

    pendingWrites.delete(zoneKey);
    list.forEach(applyRemoteWrite);
}

function cellShown(cx, cy) {
    const z = getZone(...Object.values(zOf(cx, cy)));
    if (!z) return 0;
    const li = zLocal(cx, cy), m = 1 << li;
    if ((z.rev & m) || (z.wr & m)) return z.v[li];
    return 0;
}
/* origine cella della FINESTRA ATTIVA = i 9 3x3 centrati su curZone */
const winOrigin = () => ({ ox: (winZone.x - 1) * 3, oy: (winZone.y - 1) * 3 });

/* ========== COLORI NUMERI & EVIDENZIAZIONE (3x3, riga, colonna, stessi numeri) ========== */
const numColors = {
    1: "var(--c1)", 2: "var(--c2)", 3: "var(--c3)",
    4: "var(--c4)", 5: "var(--c5)", 6: "var(--c6)",
    7: "var(--c7)", 8: "var(--c8)", 9: "var(--c9)"
};

const gridCells = [];
(function initGridCells() {
    activeBox.innerHTML = "";
    for (let ly = 0; ly < 9; ly++) {
        for (let lx = 0; lx < 9; lx++) {
            const div = document.createElement("div");
            div.className = "grid-cell";
            activeBox.appendChild(div);
            gridCells.push(div);
        }
    }
})();

function highlight(overrideNum = null) {
    const { ox, oy } = winOrigin();
    const plx = player.x - ox;
    const ply = player.y - oy;
    const pInWin = (plx >= 0 && plx < 9 && ply >= 0 && ply < 9);

    const valUnderPlayer = overrideNum !== null ? overrideNum : cellShown(player.x, player.y);

    if (valUnderPlayer && numColors[valUnderPlayer]) {
        document.documentElement.style.setProperty("--same-bg", numColors[valUnderPlayer]);
    }

    const pBoxX = pInWin ? Math.floor(plx / 3) : -1;
    const pBoxY = pInWin ? Math.floor(ply / 3) : -1;

    for (let ly = 0; ly < 9; ly++) {
        for (let lx = 0; lx < 9; lx++) {
            const idx = ly * 9 + lx;
            const el = gridCells[idx];
            el.classList.remove("hl", "same");

            if (pInWin) {
                const sameCol = (lx === plx);
                const sameRow = (ly === ply);
                const sameBox = (Math.floor(lx / 3) === pBoxX && Math.floor(ly / 3) === pBoxY);

                if (sameRow || sameCol || sameBox) {
                    el.classList.add("hl");
                }
            }

            const cx = ox + lx;
            const cy = oy + ly;
            const val = cellShown(cx, cy);

            if (valUnderPlayer && val === valUnderPlayer) {
                el.classList.add("same");
            }
        }
    }
}

/* ---------- camera & finestra attiva ---------- */
function applyCamera() {
    const px = cam.x * CELL, py = cam.y * CELL;
    worldEl.style.transform = `translate(${Math.round(innerWidth / 2 - px)}px,${Math.round(innerHeight / 2 - py)}px)`;
    gridBg.style.backgroundPosition = `${mod(innerWidth / 2 - px - 1, CELL)}px ${mod(innerHeight / 2 - py - 1, CELL)}px`;
}
function camTo(x, y, dur = 300) {
    if (!AN) { cam.x = x; cam.y = y; applyCamera(); return; }
    AN({ targets: cam, x, y, duration: dur, easing: "easeOutQuad", update: applyCamera });
}
function setActiveBlock(bx, by, force) {
    if (!force && lastBlock.bx === bx && lastBlock.by === by) return;
    lastBlock = { bx, by };
    activeBox.style.left = bx * 3 * CELL + "px";
    activeBox.style.top = by * 3 * CELL + "px";
}
function recenter(animate) {
    winZone = { x: curZone.x, y: curZone.y };
    const t = { x: winZone.x * 3 + 1.5, y: winZone.y * 3 + 1.5 };
    setActiveBlock(winZone.x - 1, winZone.y - 1);
    if (animate) camTo(t.x, t.y); else { cam.x = t.x; cam.y = t.y; applyCamera(); }
    highlight();
}

/* ---------- generazione procedurale ---------- */
function createNum(cx, cy, v, cls) {
    const k = cx + "," + cy; let el = cellEls.get(k);
    if (!el) {
        el = document.createElement("div"); el.className = "num"; el.style.left = cx * CELL + "px"; el.style.top = cy * CELL + "px";
        worldEl.appendChild(el); cellEls.set(k, el);
    }
    el.textContent = v; el.classList.remove("given", "written"); el.classList.add(cls);
    return el;
}
function removeNum(cx, cy) { const k = cx + "," + cy; const el = cellEls.get(k); if (el) { el.remove(); cellEls.delete(k); } }
// Genera (se non esiste già) i dati e la resa visiva di UNA singola zona 3x3.
// Usata sia da ensureWindow (esplorazione locale) sia quando arriva una
// notifica "zone_discovered" da un altro player per una zona non ancora vista.
function genSingleZone(tzx, tzy) {
    const key = zKey(tzx, tzy);
    const existing = getZone(tzx, tzy);
    if (existing) return existing;

    const ox = tzx * 3;
    const oy = tzy * 3;

    const playable = isPlayableZone(tzx, tzy);

    // Riflesso visivo della zona.
    const reflEl = document.createElement("div");
    reflEl.className = "zone-refl";
    reflEl.style.left = ox * CELL + "px";
    reflEl.style.top = oy * CELL + "px";
    worldEl.appendChild(reflEl);

    // ZONA VUOTA / MURO
    if (!playable) {
        reflEl.classList.add("empty");

        const z = {
            v: new Uint8Array(9),
            rev: 0,
            wr: 0,
            h0: 0,
            disc: false,
            diff: "empty",
            empty: true
        };
        zones.set(key, z);

        requestZone(tzx, tzy);
        flushPendingWrites(key);
        return z;
    }

    // ZONA GIOCABILE
    const rng = mulberry32(zoneSeed(tzx, tzy));

    const roll = rng();
    let diff = "easy";
    if (roll > 0.7) diff = "hard";
    else if (roll > 0.4) diff = "mid";

    reflEl.classList.add(diff);

    const v = new Uint8Array(9);
    let rev = 0;

    const p = REVEAL[diff];

    for (let ly = 0; ly < 3; ly++) {
        for (let lx = 0; lx < 3; lx++) {
            const worldX = ox + lx;
            const worldY = oy + ly;
            const li = ly * 3 + lx;

            const val = solutionAtCell(worldX, worldY);
            v[li] = val;

            const immortal = isImmortalCell(worldX, worldY);

            if (immortal || rng() < p) {
                rev |= 1 << li;
                createNum(worldX, worldY, val, "given");
            }
        }
    }

    const z = {
        v,
        rev,
        wr: 0,
        h0: 9 - pc(rev),
        disc: false,
        diff,
        empty: false
    };
    zones.set(key, z);

    requestZone(tzx, tzy);
    flushPendingWrites(key);
    return z;
}

function ensureWindow(zx, zy) {
    if (doneWindows.has(zKey(zx, zy))) return false;

    const missing = [];

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const tzx = zx + dx;
            const tzy = zy + dy;

            if (!getZone(tzx, tzy)) {
                missing.push({ dx, dy });
            }
        }
    }

    if (!missing.length) return false;

    for (const m of missing) {
        genSingleZone(zx + m.dx, zy + m.dy);
    }

    return true;
}
function windowGivens(zx, zy) {
    const g = new Uint8Array(81);
    for (let dy = -1; dy <= 1; dy++)for (let dx = -1; dx <= 1; dx++) {
        const z = getZone(zx + dx, zy + dy); if (!z) continue;
        const ox = (zx + dx) * 3, oy = (zy + dy) * 3;
        for (let ly = 0; ly < 3; ly++)for (let lx = 0; lx < 3; lx++) {
            const m = 1 << (ly * 3 + lx);
            if ((z.rev & m) || (z.wr & m)) g[(oy + ly - (zy - 1) * 3) * 9 + (ox + lx - (zx - 1) * 3)] = z.v[ly * 3 + lx];
        }
    }
    return g;
}
function fixWindow(zx, zy) {
    // DISABILITATO: I numeri sono prefissati (immortali), non generiamo aiuti extra
    return;
}
function enterZone(zx, zy, dx = 0, dy = 0) {
    // Zona vuota: non si genera e non si entra.
    if (!isPlayableZone(zx, zy)) {
        highlight();
        return;
    }

    if (!follow || doneWindows.has(zKey(zx, zy))) {
        highlight();
        return;
    }

    const created = ensureWindow(zx, zy);

    const z = getZone(zx, zy);
    if (z) z.disc = true;

    if (created) toast("Nuova zona generata!");

    highlight();
}

/* ========== GIOCATORE ========== */
function updateCoords() {
    const elX = document.getElementById("coordX");
    const elY = document.getElementById("coordY");
    const elZ = document.getElementById("coordZ");
    if (elX) elX.textContent = player.x;
    if (elY) elY.textContent = player.y;
    if (elZ) elZ.textContent = `Zona: ${Math.floor(player.x / 3)}, ${Math.floor(player.y / 3)}`;
}

let lastSentX = null;
let lastSentY = null;

// Funzione helper per inviare la posizione solo quando cambia realmente
function sendPlayerMove() {
    if (ws && ws.readyState === 1 && (player.x !== lastSentX || player.y !== lastSentY)) {
        lastSentX = player.x;
        lastSentY = player.y;
        ws.send(JSON.stringify({
            type: "move",
            x: player.x,
            y: player.y
        }));
    }
}

function placePlayer() {
    playerEl.style.left = player.x * CELL + "px";
    playerEl.style.top = player.y * CELL + "px";
    highlight();
    updateCoords(); // Aggiorna l'HUD delle coordinate
    sendPlayerMove(); // Notifica sempre il server dello spostamento
}
function inLock(x, y) { return !lockRect || (x >= lockRect.x0 && x <= lockRect.x1 && y >= lockRect.y0 && y <= lockRect.y1); }
function bump() { if (AN) AN({ targets: playerEl, translateX: [0, -3, 3, 0], duration: 160 }); }
function tryMove(dx, dy) {
    const nx = player.x + dx;
    const ny = player.y + dy;

    if (!inLock(nx, ny)) {
        bump();
        return;
    }

    // NUOVO: blocca movimento nei blocchi vuoti.
    if (!isPlayableCell(nx, ny)) {
        bump();
        return;
    }

    const nz = zOf(nx, ny);

    if (nz.x !== curZone.x || nz.y !== curZone.y) {
        enterZone(nz.x, nz.y, dx, dy);

        // Dopo l'eventuale generazione, ricontrolla.
        if (!isPlayableCell(nx, ny)) {
            bump();
            return;
        }

        if (cellShown(nx, ny) !== 0) {
            bump();
            return;
        }

        player.x = nx;
        player.y = ny;
        placePlayer();

        curZone = nz;

        if (follow) recenter(true);

        checkUnits();
        return;
    }

    if (cellShown(nx, ny) !== 0) {
        bump();
        return;
    }

    player.x = nx;
    player.y = ny;
    placePlayer();
}
function toggleLock() {
    follow = !follow;
    if (!follow) {
        lockRect = { x0: (curZone.x - 1) * 3, y0: (curZone.y - 1) * 3, x1: (curZone.x - 1) * 3 + 8, y1: (curZone.y - 1) * 3 + 8 };
        activeBox.classList.add("locked");
        document.getElementById("lockBadge").style.display = "block";
    } else {
        lockRect = null; activeBox.classList.remove("locked");
        document.getElementById("lockBadge").style.display = "none";
        curZone = zOf(player.x, player.y);
        // MODIFICA: Non chiamiamo enterZone qui per evitare che lo sblocco generi numeri extra dal nulla
        recenter(true);
        checkUnits();
        highlight();
    }
}

/* ========== NUMERI ========== */
let notesMode = false;
function renderNotes(cx, cy) {
    const k = cx + "," + cy, m = notesMask.get(k) || 0;
    let el = notesEls.get(k);
    if (!m) { if (el) { el.remove(); notesEls.delete(k); } return; }
    if (!el) {
        el = document.createElement("div"); el.className = "notesAbs";
        el.style.left = cx * CELL + "px"; el.style.top = cy * CELL + "px";
        for (let i = 1; i <= 9; i++) { const e = document.createElement("i"); e.textContent = i; el.appendChild(e); }
        worldEl.appendChild(el); notesEls.set(k, el);
    }
    [...el.children].forEach((e, i) => e.style.display = (m & bit(i + 1)) ? "flex" : "none");
}
function toggleNotes() { notesMode = !notesMode; padNotes.classList.toggle("on", notesMode); }
function pressDigit(d) {
    // Non puoi scrivere o usare numeri dentro un muro.
    if (!isPlayableCell(player.x, player.y)) {
        bump();
        return;
    }

    if (notesMode) {
        if (cellShown(player.x, player.y) !== 0) return;

        const k = player.x + "," + player.y;
        const m = (notesMask.get(k) || 0) ^ bit(d);

        if (m) notesMask.set(k, m);
        else notesMask.delete(k);

        renderNotes(player.x, player.y);
        return;
    }

    // Movimento verso cella adiacente che contiene quel numero.
    const dirs = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0]
    ];

    for (const [dx, dy] of dirs) {
        const nx = player.x + dx;
        const ny = player.y + dy;

        if (!inLock(nx, ny)) continue;

        // Non puoi saltare in una zona vuota.
        if (!isPlayableCell(nx, ny)) continue;

        if (cellShown(nx, ny) === d) {
            player.x = nx;
            player.y = ny;
            placePlayer();

            const nz = zOf(nx, ny);

            if (nz.x !== curZone.x || nz.y !== curZone.y) {
                curZone = nz;

                const z = getZone(nz.x, nz.y);
                if (z) z.disc = true;

                if (follow) recenter(true);
            }

            return;
        }
    }

    // Scrittura nella cella attuale.
    if (cellShown(player.x, player.y) === 0) {
        const z = getZone(curZone.x, curZone.y);
        const li = zLocal(player.x, player.y);

        if (z && !z.empty && z.v[li] === d) {
            doWrite(z, li, d);
            return;
        }

        wrongNumber();
        return;
    }

    // Sei su una cella già numerata: input ignorato.
    bump();
}
const cy0 = () => player.y;
function doWrite(z, li, d) {
    const cx = player.x;
    const cy = player.y;

    if (!isPlayableCell(cx, cy) || z.empty) return;

    z.wr |= 1 << li;

    const k = cx + "," + cy;

    notesMask.delete(k);
    renderNotes(cx, cy);

    const el = createNum(cx, cy, d, "written");

    if (AN) {
        AN({
            targets: el,
            scale: [.3, 1.25, 1],
            duration: 300,
            easing: "easeOutBack"
        });
    }

    gainXp(5);
    checkUnits();
    highlight();
}
function eraseCur() {
    const cx = player.x;
    const cy = player.y;
    const k = cx + "," + cy;

    if (!isPlayableCell(cx, cy)) return;

    // Le note a matita restano cancellabili liberamente.
    if (notesMask.has(k)) {
        notesMask.delete(k);
        renderNotes(cx, cy);
        return;
    }

    // I numeri scritti (propri o altrui) sono PERMANENTI una volta inseriti:
    // niente cancellazione, né locale né di conseguenza sul server.
    highlight();
}

/* ========== UNITA' DELLA FINESTRA ATTIVA (9 righe, 9 colonne, 9 box) ========== */
function unitInfo(t, idx) {
    const { ox, oy } = winOrigin();
    const out = [];
    for (let i = 0; i < 9; i++) {
        let lx, ly;
        if (t === "row") { lx = i; ly = idx; }
        else if (t === "col") { lx = idx; ly = i; }
        else { lx = (idx % 3) * 3 + (i % 3); ly = Math.floor(idx / 3) * 3 + Math.floor(i / 3); }
        out.push([ox + lx, oy + ly]);
    }
    return out;
}
function checkUnits() {
    const { ox, oy } = winOrigin();

    for (const t of ["row", "col", "box"]) {
        for (let idx = 0; idx < 9; idx++) {

            // Genera una chiave GLOBALE e univoca invece di una basata su curZone
            let uk = "";
            if (t === "row") {
                const globalY = oy + idx;
                uk = `row|${globalY}`;
            } else if (t === "col") {
                const globalX = ox + idx;
                uk = `col|${globalX}`;
            } else {
                const globalZx = (winZone.x - 1) + (idx % 3);
                const globalZy = (winZone.y - 1) + Math.floor(idx / 3);
                uk = `box|${globalZx},${globalZy}`;
            }

            // Se l'unità globale è già stata premiata, la ignora
            if (doneUnits.has(uk)) continue;

            const cellsU = unitInfo(t, idx);

            let full = true;
            let write = false;
            let hasWall = false;

            for (const [cx, cy] of cellsU) {
                if (!isPlayableCell(cx, cy)) {
                    hasWall = true;
                    break;
                }

                const z = getZone(...Object.values(zOf(cx, cy)));

                if (!z || z.empty || cellShown(cx, cy) === 0) {
                    full = false;
                    break;
                }

                if (z.wr & (1 << zLocal(cx, cy))) {
                    write = true;
                }
            }

            if (hasWall || !full) continue;

            // Registra la chiave globale per evitare premi duplicati al movimento
            doneUnits.add(uk);

            // Completata solo da numeri iniziali (givens): nessun premio XP
            if (!write) continue;

            gainXp(20);

            toast(
                "+20 XP — " +
                (t === "row" ? "riga" : t === "col" ? "colonna" : "3×3") +
                " completata!",
                "gold"
            );

            const els = [];
            for (const [cx, cy] of cellsU) {
                els.push(cellEls.get(cx + "," + cy));
            }

            if (AN) {
                AN({
                    targets: els.filter(Boolean),
                    keyframes: [
                        { scale: 1 },
                        { scale: 1.03, backgroundColor: "rgba(255,255,255,0.2)" },
                        { scale: 1 }
                    ],
                    duration: 400,
                    easing: "easeOutQuad",
                    delay: AN.stagger(10)
                });
            }
        }
    }

    // Controllo completamento della finestra attiva 9x9
    const windowKey = winZone.x + "," + winZone.y;
    if (!doneWindows.has(windowKey)) {
        let full = true;
        let write = false;
        let hasPlayable = false;

        outer:
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const z = getZone(winZone.x + dx, winZone.y + dy);

                if (!z) {
                    full = false;
                    break outer;
                }

                if (z.empty) continue;

                hasPlayable = true;

                for (let li = 0; li < 9; li++) {
                    const m = 1 << li;

                    if (!(z.rev & m) && !(z.wr & m)) {
                        full = false;
                        break outer;
                    }

                    if (z.wr & m) {
                        write = true;
                    }
                }
            }
        }

        if (hasPlayable && full) {
            doneWindows.add(windowKey);

            if (write) {
                gainXp(150);
                showWin();
            }
        }
    }
}

function showWin() {
    const w = document.getElementById("win");
    document.getElementById("winTxt").textContent = "+150 XP · Livello " + level;
    w.classList.remove("hide");
    if (AN) AN({ targets: "#win .card", scale: [.6, 1], opacity: [0, 1], duration: 450, easing: "easeOutBack" });
    setTimeout(() => w.classList.add("hide"), 3200);
}
document.getElementById("againBtn").onclick = () => document.getElementById("win").classList.add("hide");

/* ========== VITA / XP ========== */
let level = 1, xp = 0, xpNeed = 100, maxHp = 100, hp = 100;
const hpFill = document.getElementById("hpFill"), xpFill = document.getElementById("xpFill"), lvlEl = document.getElementById("lvl");
function updateBars() {
    hpFill.style.width = Math.max(0, hp / maxHp * 100) + "%";
    xpFill.style.width = Math.min(100, xp / xpNeed * 100) + "%";
    lvlEl.textContent = "LV " + level;
    const hpText = document.getElementById("hpText");
    if (hpText) hpText.textContent = Math.max(0, hp) + " / " + maxHp;
}
function gainXp(n) {
    xp += n;
    if (AN) AN({ targets: "#xpFill", scaleY: [1.6, 1], duration: 260, easing: "easeOutQuad" });
    while (xp >= xpNeed) {
        xp -= xpNeed; level++;
        xpNeed = Math.round(100 * Math.pow(1.5, level - 1));
        maxHp = Math.round(maxHp * 1.05); hp = maxHp;
        levelUpFx();
    }
    updateBars();
}
function levelUpFx() {
    toast("LIVELLO " + level + "!", "gold");
    if (AN) AN({
        targets: "#xpFill",
        backgroundColor: ["#a3e635", "#22c55e"],
        duration: 500,
        easing: "easeOutQuad"
    });
}
function wrongNumber() {
    hp -= Math.round(maxHp * 0.15);
    const v = document.getElementById("vignette");
    if (AN) {
        AN({ targets: v, keyframes: [{ opacity: 1 }, { opacity: 0, duration: 500 }], easing: "easeOutQuad" });
        AN({ targets: stage, translateX: [0, -10, 10, -6, 6, 0], duration: 340 });
        AN({ targets: hpFill, keyframes: [{ backgroundColor: "#ffffff" }, { backgroundColor: "#ef4444" }], duration: 500 });
    } else {
        v.style.opacity = 1; setTimeout(() => v.style.opacity = 0, 350);
    }
    toast("Numero errato! −HP", "bad");
    if (hp <= 0) respawn();
    updateBars();
}
function respawn() {
    hp = maxHp;

    let best = null;
    let bd = 1e9;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const tzx = curZone.x + dx;
            const tzy = curZone.y + dy;

            if (!isPlayableZone(tzx, tzy)) continue;

            const z = getZone(tzx, tzy);
            if (!z || z.empty) continue;

            const ox = tzx * 3;
            const oy = tzy * 3;

            for (let li = 0; li < 9; li++) {
                const m = 1 << li;

                if (!(z.rev & m) && !(z.wr & m)) {
                    const cx = ox + li % 3;
                    const cy = oy + (li / 3 | 0);

                    if (!isPlayableCell(cx, cy)) continue;

                    const d =
                        Math.abs(cx - curZone.x * 3 - 1) +
                        Math.abs(cy - curZone.y * 3 - 1);

                    if (d < bd) {
                        bd = d;
                        best = [cx, cy];
                    }
                }
            }
        }
    }

    if (best) {
        player.x = best[0];
        player.y = best[1];
        placePlayer();

        curZone = zOf(player.x, player.y);
        recenter(false);
    }

    toast("Sei esausto… riposo e rinascita!", "bad");
    updateBars();
}

/* ========== TOAST / CONFETTI ========== */
function toast(msg, cls) {
    const t = document.createElement("div"); t.className = "toast" + (cls ? " " + cls : ""); t.textContent = msg;
    document.getElementById("toasts").appendChild(t);
    if (AN) AN({
        targets: t, translateY: [-12, 0], opacity: [0, 1], duration: 250, easing: "easeOutQuad",
        complete: () => AN({ targets: t, opacity: 0, translateY: -10, delay: 1600, duration: 400, complete: () => t.remove() })
    });
    else setTimeout(() => t.remove(), 2000);
}

/* ========== MAPPA ========== */
const mapWrap = document.getElementById("mapWrap"), mapC = document.getElementById("mapC"), ctx = mapC.getContext("2d");
const view = { cx: 0, cy: 0, zoom: 26 };
function openMap() { mapMode = true; mapWrap.style.display = "block"; view.cx = curZone.x; view.cy = curZone.y; drawMinimap(); }
function closeMap() { mapMode = false; mapWrap.style.display = "none"; }
function zoneProgress(z) {
    if (!z.h0) return 1;
    const hidden = pc((~(z.rev | z.wr)) & 511);
    return 1 - hidden / z.h0;
}
function drawMinimap() {
    const mapCanvas = document.getElementById("mapC");
    if (!mapCanvas) return;
    const ctxMap = mapCanvas.getContext("2d");

    mapCanvas.width = mapWrap.clientWidth || window.innerWidth;
    mapCanvas.height = mapWrap.clientHeight || window.innerHeight;

    ctxMap.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

    const mapBlockSize = view.zoom || 26;
    const mapCenterX = mapCanvas.width / 2;
    const mapCenterY = mapCanvas.height / 2;

    const centerZx = view.cx;
    const centerZy = view.cy;

    const rangeX = Math.ceil(mapCanvas.width / (2 * mapBlockSize)) + 1;
    const rangeY = Math.ceil(mapCanvas.height / (2 * mapBlockSize)) + 1;

    for (let zx = Math.floor(centerZx - rangeX); zx <= Math.ceil(centerZx + rangeX); zx++) {
        for (let zy = Math.floor(centerZy - rangeY); zy <= Math.ceil(centerZy + rangeY); zy++) {

            if (!isPlayableZone(zx, zy)) continue;

            const z = getZone(zx, zy);

            // 1. FILTRO SCOPERTA: Disegna solo se la zona esiste ed è stata scoperta
            if (!z || !z.disc) continue;

            const screenX = mapCenterX + (zx - centerZx) * mapBlockSize;
            const screenY = mapCenterY + (zy - centerZy) * mapBlockSize;

            // 2. GRADIENTE VERDE: Calcola il progresso (da 0.0 a 1.0)
            const progress = zoneProgress(z);

            // Transizione HSL: da verde chiarissimo (0%) a verde pieno/scuro (100%)
            const saturation = Math.round(35 + progress * 55); // da 35% a 90%
            const lightness = Math.round(92 - progress * 50);  // da 92% a 42%
            const fillColor = `hsl(142, ${saturation}%, ${lightness}%)`;

            // Disegna il blocco 3x3
            ctxMap.fillStyle = fillColor;
            ctxMap.fillRect(screenX, screenY, mapBlockSize - 2, mapBlockSize - 2);

            ctxMap.strokeStyle = "#94a3b8";
            ctxMap.lineWidth = 1;
            ctxMap.strokeRect(screenX, screenY, mapBlockSize - 2, mapBlockSize - 2);
        }
    }

    // Posizione del giocatore
    const playerBlockX = player.x / 3;
    const playerBlockY = player.y / 3;

    const playerScreenX = mapCenterX + (playerBlockX - centerZx) * mapBlockSize;
    const playerScreenY = mapCenterY + (playerBlockY - centerZy) * mapBlockSize;

    ctxMap.fillStyle = "#ef4444";
    ctxMap.beginPath();
    ctxMap.arc(playerScreenX, playerScreenY, Math.max(3, mapBlockSize / 5), 0, Math.PI * 2);
    ctxMap.fill();
}
mapWrap.addEventListener("wheel", e => {
    e.preventDefault();
    view.zoom = Math.max(8, Math.min(120, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); drawMinimap();
}, { passive: false });

/* ========== INPUT ========== */
document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        return;
    }
    const k = e.key.toLowerCase();
    if (mapMode) {
        if (k === "m" || k === "escape") { closeMap(); return; }
        const pan = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] }[k];
        if (pan) { view.cx += pan[0] * Math.max(1, 20 / view.zoom); view.cy += pan[1] * Math.max(1, 20 / view.zoom); drawMinimap(); e.preventDefault(); return; }
        if (k === "q" || k === "-") { view.zoom = Math.max(8, view.zoom / 1.2); drawMinimap(); return; }
        if (k === "e" || k === "+" || k === "=") { view.zoom = Math.min(120, view.zoom * 1.2); drawMinimap(); return; }
        return;
    }
    if (k === "tab") {
        e.preventDefault();
        const tips = document.getElementById("tips");
        tips.style.display = tips.style.display === "none" ? "block" : "none";
        return;
    }
    if (k === "m") { openMap(); return; }
    if (k === "r") { toggleLock(); return; }
    if (k === "n") { toggleNotes(); return; }
    const mv = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] }[k];
    if (mv) { tryMove(mv[0], mv[1]); e.preventDefault(); return; }
    if (k >= "1" && k <= "9") { pressDigit(+k); e.preventDefault(); return; }
    if (k === "backspace" || k === "delete" || k === "0") { eraseCur(); e.preventDefault(); return; }
});

/* ========== AVVIO ========== */
function fit() {
    CELL = Math.max(36, Math.min(72, Math.floor(Math.min(innerWidth, innerHeight) / 9)));
    document.documentElement.style.setProperty("--cell", CELL + "px");
    gridBg.style.backgroundSize = CELL + "px " + CELL + "px";
    setActiveBlock(lastBlock.bx, lastBlock.by, true);
    applyCamera();
    highlight();
}
window.addEventListener("resize", fit);
async function newWorld() {
    curZone = { x: 0, y: 0 };
    winZone = { x: 0, y: 0 };

    document.getElementById("win").classList.add("hide");
    document.getElementById("phase").textContent = "Genero il mondo samurai…";
    document.getElementById("bar").style.width = "30%";

    await frame();

    // Seed del mondo. Se il server lo invia, può essere aggiornato prima di newWorld.
    seed = worldSeed;

    // Per compatibilità con eventuali parti che leggono ancora globalSolution.
    globalSolution = buildViewSolution(0, 0);

    // Maschera immortali per la finestra iniziale.
    immortalMask = new Uint8Array(81);

    const startX = -3;
    const startY = -3;

    for (let vy = 0; vy < 9; vy++) {
        for (let vx = 0; vx < 9; vx++) {
            const x = startX + vx;
            const y = startY + vy;
            const i = vy * 9 + vx;

            if (isPlayableCell(x, y) && isImmortalCell(x, y)) {
                immortalMask[i] = 1;
            }
        }
    }

    zones.clear();
    cellEls.clear();
    notesEls.clear();
    notesMask.clear();

    doneUnits.clear();
    doneWindows.clear();

    worldEl.querySelectorAll(".num,.notesAbs,.zone-refl").forEach(e => e.remove());

    level = 1;
    xp = 0;
    xpNeed = 100;
    maxHp = 100;
    hp = 100;
    notesMode = false;

    follow = true;
    lockRect = null;

    activeBox.classList.remove("locked");
    document.getElementById("lockBadge").style.display = "none";

    // Genera la finestra iniziale centrata sulla zona 0,0.
    enterZone(0, 0);

    const z = getZone(0, 0);

    let px = 1;
    let py = 1;

    if (z) {
        let found = false;

        // Cerca una cella libera vicino al centro della zona 0,0.
        for (let r = 0; r < 3 && !found; r++) {
            for (let ly = 0; ly < 3 && !found; ly++) {
                for (let lx = 0; lx < 3 && !found; lx++) {
                    if (Math.max(Math.abs(lx - 1), Math.abs(ly - 1)) !== r) continue;

                    const m = 1 << (ly * 3 + lx);

                    if (!(z.rev & m) && !(z.wr & m)) {
                        px = lx;
                        py = ly;
                        found = true;
                    }
                }
            }
        }

        // Fallback.
        if (!found) {
            px = 1;
            py = 1;
        }
    }

    player.x = px;
    player.y = py;

    placePlayer();

    curZone = zOf(player.x, player.y);

    document.getElementById("bar").style.width = "100%";

    await frame();

    fit();
    recenter(false);

    document.getElementById("loader").classList.add("hide");

    updateBars();
    checkUnits();

    if (AN) {
        AN({
            targets: playerEl,
            scale: [0, 1],
            duration: 500,
            easing: "easeOutBack"
        });
    }
}

// ====== LOGICA MULTIPLAYER ======
let ws;
let myId = null;
let myName = "";
// Colore con cui GLI ALTRI ti vedono (marker + numeri che scrivi).
// Deve essere diverso dal blu del TUO player/numeri (var(--user) = #1d4ed8 in CSS),
// altrimenti tutti i giocatori sembrano avere lo stesso colore agli occhi altrui.
let myColor = "#7dd3fc"; // azzurro più chiaro
const otherPlayersEls = new Map();
let worldInitialized = false;

document.getElementById("loginBtn").onclick = () => {
    firebase.auth().signInWithPopup(provider).then((result) => {
        document.getElementById("usernameArea").style.display = "block";
    }).catch((error) => {
        alert("Errore di login: " + error.message);
    });
};

// Renderizza gli altri giocatori in tempo reale con il nome sopra
function updateOtherPlayers(list) {
    const currentIds = new Set();
    list.forEach(p => {
        if (p.id === myId) return;
        currentIds.add(p.id);

        let el = otherPlayersEls.get(p.id);
        if (!el) {
            el = document.createElement("div");
            el.className = "other-player";
            el.innerHTML = `<span class="p-name"></span>`;
            worldEl.appendChild(el);
            otherPlayersEls.set(p.id, el);
        }

        el.style.setProperty('--p-color', p.color || '#38bdf8');
        el.style.left = p.x * CELL + "px";
        el.style.top = p.y * CELL + "px";

        const nameTag = el.querySelector(".p-name");
        if (nameTag) nameTag.textContent = p.name || "Guest";
    });

    // Rimuove i giocatori disconnessi
    for (const [id, el] of otherPlayersEls) {
        if (!currentIds.has(id)) {
            el.remove();
            otherPlayersEls.delete(id);
        }
    }
}

// Modifica doWrite per inviare il numero scritto
const originalDoWrite = doWrite;
doWrite = function (z, li, d) {
    if (!isPlayableCell(player.x, player.y) || z.empty) return;

    originalDoWrite(z, li, d);

    playerStats.numbersWritten++;
    saveLocalPlayerStats();

    if (ws && ws.readyState === 1) {
        const gx = player.x;
        const gy = player.y;

        const lx = mod(gx, 3);
        const ly = mod(gy, 3);

        ws.send(JSON.stringify({
            type: "write",
            zoneKey: zKey(curZone.x, curZone.y),
            cx: lx,
            cy: ly,
            gx,
            gy,
            val: d,
            color: myColor
        }));
    }
};

// ==========================================
// SISTEMA SALVATAGGIO PLAYER (Locale + DB)
// ==========================================
let playerStats = {
    id: null,
    name: "",
    level: 1,
    xp: 0,
    deaths: 0,
    numbersWritten: 0,
    futureFeatures: {} // Per le classi/boss future
};

// Carica dati locali salvati
function loadLocalPlayerStats() {
    const saved = localStorage.getItem('infiniteDokuStats');
    if (saved) {
        const parsed = JSON.parse(saved);
        playerStats = { ...playerStats, ...parsed };
        // Aggiorniamo le variabili di gioco coi dati locali
        level = playerStats.level;
        xp = playerStats.xp;
        // Aggiorna UI
        updateBars();
    }
}

function saveLocalPlayerStats() {
    playerStats.level = level;
    playerStats.xp = xp;
    localStorage.setItem('infiniteDokuStats', JSON.stringify(playerStats));
}

// Salva su Firebase quando il giocatore chiude/aggiorna la pagina
window.addEventListener('beforeunload', () => {
    saveLocalPlayerStats();

    const user = (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth().currentUser : null;
    if (user) {
        playerStats.id = user.uid;
        playerStats.name = myName;

        const payload = JSON.stringify({ uid: user.uid, stats: playerStats });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('http://localhost:8080/save-stats', blob);
    }
});

// Modifica wrongNumber per tracciare le morti
const originalRespawn = respawn;
respawn = function () {
    playerStats.deaths++;
    saveLocalPlayerStats();
    originalRespawn();
};

// Inizializza al login
document.getElementById("startGameBtn").onclick = () => {
    myName = document.getElementById("usernameInput").value || "Guest";
    const user = (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth().currentUser : null;

    if (!user) {
        startOfflineMode();
        return;
    }

    document.getElementById("loginScreen").style.display = "none";
    createPlayerIdBadge(user.uid);

    firebase.database().ref("users/" + user.uid).once("value")
        .then(async (snapshot) => {
            let savedX = null;
            let savedY = null;

            if (snapshot.exists()) {
                const data = snapshot.val();

                playerStats = { ...playerStats, ...data };
                level = data.level || 1;
                xp = data.xp || 0;
                hp = data.hp || 100;
                maxHp = data.maxHp || 100;

                if (data.x !== undefined && data.y !== undefined) {
                    savedX = data.x;
                    savedY = data.y;
                }
            } else {
                savePlayerData();
            }

            updateBars();

            fit();
            await newWorld();
            worldInitialized = true;

            // Se il giocatore ha coordinate salvate, le imposta e genera le zone circostanti
            if (savedX !== null && savedY !== null) {
                player.x = savedX;
                player.y = savedY;
                curZone = zOf(player.x, player.y);
                
                // Forza la generazione locale delle zone attorno alla posizione salvata
                enterZone(curZone.x, curZone.y);
                
                placePlayer();
                recenter(false);
            }

            connectWebSocket();
        })
        .catch((err) => {
            console.warn("Errore caricamento Firebase, avvio locale:", err);
            startOfflineMode();
        });
};

// Helper per avviare la partita in locale
function startOfflineMode() {
    myName = document.getElementById("usernameInput")?.value || "Giocatore Offline";
    document.getElementById("loginScreen").style.display = "none";

    loadLocalPlayerStats();
    fit();
    newWorld();
    worldInitialized = true;
    toast("Modalità Offline", "gold");
}

// Gestione pulsante Offline
const offlineBtn = document.getElementById("offlineBtn");
if (offlineBtn) {
    offlineBtn.onclick = () => {
        startOfflineMode();
    };
}

// Connessione WebSocket separata e sicura contro i crash offline
// Inizializzazione WebSocket con ascolto eventi in tempo reale
function connectWebSocket() {
    try {
        ws = new WebSocket("ws://localhost:8080");

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: "join",
                name: myName,
                color: myColor,
                x: player.x,
                y: player.y
            }));
            lastSentX = player.x;
            lastSentY = player.y;

            // Richiede al server le scritture salvate per tutte le zone attualmente in memoria
            for (const key of zones.keys()) {
                const [zx, zy] = key.split(',').map(Number);
                requestZone(zx, zy);
            }
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === "init") {
                myId = msg.myId;
            }
            else if (msg.type === "players") {
                updateOtherPlayers(msg.data);
            }
            else if (msg.type === "write") {
                applyRemoteWrite(msg);
                if (mapMode) drawMinimap();
            }
            // NOTA: zone_info carica solo le scritture (numbers), la scoperta della zona resta personale
            else if (msg.type === "zone_info") {
                const [zx, zy] = msg.zoneKey.split(',').map(Number);
                const z = getZone(zx, zy);
                if (z && msg.writes) {
                    applyRemoteWrites(msg.zoneKey, msg.writes);
                }
                if (mapMode) drawMinimap();
            }
        };
    } catch (e) {
        console.warn("WebSocket non disponibile, modalità offline attiva.", e);
    }
}

// UI Badge per ID Giocatore nell'angolo dello schermo
function createPlayerIdBadge(idText) {
    let badge = document.getElementById("playerIdBadge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "playerIdBadge";
        badge.style.cssText = "position:fixed; bottom:12px; right:12px; background:rgba(15,23,42,0.85); color:#94a3b8; padding:6px 12px; border-radius:8px; font-size:12px; font-family:monospace; border:1px solid #334155; z-index:1000; pointer-events:none;";
        document.body.appendChild(badge);
    }
    badge.textContent = `ID: ${idText}`;
}

// Funzione di Salvataggio unificata del Player su Firebase RTDB
function savePlayerData() {
    const user = (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth().currentUser : null;
    if (!user) return;

    playerStats.id = user.uid;
    playerStats.name = myName;
    playerStats.x = player.x;
    playerStats.y = player.y;
    playerStats.level = level;
    playerStats.xp = xp;
    playerStats.hp = hp;
    playerStats.maxHp = maxHp;

    firebase.database().ref("users/" + user.uid).update(playerStats);
    saveLocalPlayerStats();
}

// Gestione messaggi ricevuti dal WebSocket
function handleServerMessages(msg) {
    if (msg.type === "zone_info") {
        const z = getZone(...parseZoneKey(msg.zoneKey));
        if (z) {
            if (msg.disc) z.disc = true;
            if (msg.writes) applyRemoteWrites(msg.zoneKey, msg.writes);
        }
    }
}

// Auto-Salvataggio su eventi chiave e prima della chiusura pagina
window.addEventListener('beforeunload', savePlayerData);