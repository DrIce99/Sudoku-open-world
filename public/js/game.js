const AN = window.anime || null;
const pc = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const bit = v => 1 << (v - 1);
const mod = (v, c) => ((v % c) + c) % c;
const frame = () => new Promise(r => setTimeout(r, 0));

/* ========== DIFFICOLTA' ZONE (percentuale di celle rivelate) ========== */
const REVEAL = { easy: .40, mid: .32, hard: .24 };

/* ========== MONDO A ZONE (3x3 celle ciascuna) ========== */
let CELL = 52;

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

// Seed del mondo: deve coincidere con WORLD_SEED del server.
const worldSeed = 20260222;

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

    const lx = Number(msg.cx), ly = Number(msg.cy);
    if (![lx, ly].every(v => Number.isInteger(v) && v >= 0 && v <= 2)) return;

    const gx = zx * 3 + lx;
    const gy = zy * 3 + ly;

    const li = zLocal(gx, gy);
    const m = 1 << li;

    // Rimozione remota (es. attacco boss)
    if (Number(msg.val) === 0) {
        if (z.wr & m) {
            z.wr &= ~m;
            removeNum(gx, gy);

            if (zKey(zx, zy) === zKey(curZone.x, curZone.y)) {
                highlight();
            }
        }
        return;
    }

    // Non sovrascrivere numeri iniziali (givens) o già scritti; scarta valori errati
    if ((z.rev & m) || (z.wr & m) || z.v[li] !== Number(msg.val)) return;

    z.wr |= m;
    // "propri" anche i numeri scritti da noi in una sessione precedente (servono alle classi 4)
    if (msg.by && msg.by === myPlayerId) z.own |= m;
    else z.own &= ~m;
    // gli indizi della classe 5 non danno ricompense: la cella resta premiabile
    if (!msg.hint) z.claimed |= m;
    notesMask.delete(gx + "," + gy);
    renderNotes(gx, gy);

    // Fallback su colore chiaro visibile (#38bdf8) se il colore salvato è scuro o assente
    const displayColor = (msg.color && msg.color !== "#1d4ed8") ? msg.color : "#38bdf8";

    const el = createNum(gx, gy, msg.val, "written_other");
    if (el) el.style.color = displayColor;
    if (el) el.classList.toggle("hint", !!msg.hint);
    window.FX?.remoteNumber(gx, gy, displayColor);

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
            val: w.val,
            color: w.color,
            by: w.by,
            hint: w.hint
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

            // Blocchi non accessibili: disegnati come muro anche dentro la finestra attiva
            const wall = !isPlayableCell(ox + lx, oy + ly);
            el.classList.toggle("wall", wall);
            if (wall) continue;

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
    el.textContent = v; el.classList.remove("given", "written", "written_other"); el.classList.add(cls);
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
            own: 0,
            h0: 0,
            disc: false,
            diff: "empty",
            empty: true,
            claimed: 0
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
        own: 0,
        h0: 9 - pc(rev),
        disc: false,
        diff,
        empty: false,
        // celle che hanno già dato la ricompensa (anche se poi un boss ha cancellato il numero)
        claimed: 0
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

function ensureZoneForMovement(zx, zy) {
    if (!isPlayableZone(zx, zy)) return;

    if (!doneWindows.has(zKey(zx, zy))) {
        ensureWindow(zx, zy);
    }

    const z = getZone(zx, zy);
    if (z) z.disc = true;
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

// Sudoku 9x9 attivo (quello bloccato con R o l'arena del boss): serve al server per
// gli indizi della Rigenerazione (classe 5)
let lastSentView = "";
setInterval(() => {
    const v = winZone.x + "," + winZone.y;
    if (v === lastSentView || !ws || ws.readyState !== 1) return;
    lastSentView = v;
    ws.send(JSON.stringify({ type: "view", zx: winZone.x, zy: winZone.y }));
}, 500);

function placePlayer() {
    playerEl.style.left = player.x * CELL + "px";
    playerEl.style.top = player.y * CELL + "px";
    highlight();
    updateCoords(); // Aggiorna l'HUD delle coordinate
    sendPlayerMove(); // Notifica sempre il server dello spostamento
    scheduleSave();
}

// Salvataggio ritardato: raggruppa gli spostamenti ravvicinati in una sola richiesta.
let saveTimer = null;
function scheduleSave() {
    if (saveTimer || !worldInitialized) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (playerStats.isGuest) saveLocalPlayerStats();
        else savePlayerData();
    }, 3000);
}
// Posizione decisa dal server (spinta, cella occupata, teletrasporto nel party)
function forcePosition(x, y) {
    // il server conosce già questa posizione: niente messaggio "move" di ritorno
    lastSentX = x;
    lastSentY = y;

    const nz = zOf(x, y);
    if (follow) enterZone(nz.x, nz.y);
    else ensureZoneForMovement(nz.x, nz.y);

    player.x = x;
    player.y = y;
    curZone = nz;
    placePlayer();

    // portati fuori dalla vista bloccata con R (salto, portale, spinta): il blocco si scioglie
    if (!follow && !inLock(x, y) && !window.bossManager?.isBossFightActive()) toggleLock();

    if (follow) recenter(true);
    checkUnits();
}

function inLock(x, y) { return !lockRect || (x >= lockRect.x0 && x <= lockRect.x1 && y >= lockRect.y0 && y <= lockRect.y1); }
function bump() {
    if (AN) AN({ targets: playerEl, translateX: [0, -3, 3, 0], duration: 160 });
    window.FX?.bump();
}
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

        if (cellShown(nx, ny) !== 0 && !window.Abilities?.canEnter(nx, ny)) {
            bump();
            return;
        }

        window.FX?.step(player.x, player.y, dx, dy);
        player.x = nx;
        player.y = ny;
        placePlayer();

        curZone = nz;

        if (follow) recenter(true);

        checkUnits();
        return;
    }

    // Passo libero (classe 6): si cammina sopra i numeri; Tank (classe 3): sopra i 3
    if (cellShown(nx, ny) !== 0 && !window.Abilities?.canEnter(nx, ny)) {
        bump();
        return;
    }

    window.FX?.step(player.x, player.y, dx, dy);
    player.x = nx;
    player.y = ny;
    placePlayer();
}
function toggleLock() {
    // Durante la bossfight il blocco manuale è completamente disattivato
    if (window.bossManager && window.bossManager.isBossFightActive()) {
        return;
    }

    follow = !follow;
    if (!follow) {
        lockRect = { x0: (curZone.x - 1) * 3, y0: (curZone.y - 1) * 3, x1: (curZone.x - 1) * 3 + 8, y1: (curZone.y - 1) * 3 + 8 };
        activeBox.classList.add("locked");
        document.getElementById("lockBadge").style.display = "block";
    } else {
        lockRect = null;
        activeBox.classList.remove("locked");
        document.getElementById("lockBadge").style.display = "none";
        curZone = zOf(player.x, player.y);
        if (ensureWindow(curZone.x, curZone.y)) toast("Nuova zona generata!");
        recenter(true);
        checkUnits();
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
function toggleNotes() {
    notesMode = !notesMode;
    toast(notesMode ? "Note a matita: ON" : "Note a matita: OFF");
}
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
            const nz = zOf(nx, ny);

            // Se il salto numerico cambia zona, genera il mondo come fa il movimento normale
            if (nz.x !== curZone.x || nz.y !== curZone.y) {
                if (follow) {
                    enterZone(nz.x, nz.y);
                } else if (!(window.bossManager && window.bossManager.isBossFightActive())) {
                    ensureZoneForMovement(nz.x, nz.y);
                }
            }

            window.FX?.dash(player.x, player.y, nx, ny);
            player.x = nx;
            player.y = ny;
            placePlayer();

            if (nz.x !== curZone.x || nz.y !== curZone.y) {
                curZone = nz;

                const z = getZone(nz.x, nz.y);
                if (z) z.disc = true;

                if (follow) recenter(true);

                checkUnits();
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
function doWrite(z, li, d) {
    const cx = player.x;
    const cy = player.y;

    if (!isPlayableCell(cx, cy) || z.empty) return;

    z.wr |= 1 << li;
    z.own |= 1 << li;

    // XP solo la prima volta che la cella viene completata: riscrivere un numero
    // cancellato da un boss non dà di nuovo la ricompensa
    const fresh = !(z.claimed & (1 << li));
    z.claimed |= 1 << li;

    notesMask.delete(cx + "," + cy);
    renderNotes(cx, cy);

    const el = createNum(cx, cy, d, "written");
    window.FX?.numberPlaced(cx, cy, d, el, fresh);

    playerStats.stats.placedNumbers++;
    sendWrite(cx, cy, d);

    if (fresh) gainXp(5);
    checkUnits();
    highlight();
    // L'effetto sui boss (vita / timer) lo calcola il server alla ricezione della scrittura
}
function sendWrite(cx, cy, d) {
    if (!ws || ws.readyState !== 1) return;
    const z = zOf(cx, cy);
    ws.send(JSON.stringify({
        type: "write",
        zoneKey: zKey(z.x, z.y),
        cx: mod(cx, 3),
        cy: mod(cy, 3),
        val: d,
        color: myColor
    }));
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
            // (righe e colonne dipendono anche dall'origine della finestra)
            if (t === "row") {
                uk = `row|${ox},${oy + idx}`;
            } else if (t === "col") {
                uk = `col|${ox + idx},${oy}`;
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

                const m = 1 << zLocal(cx, cy);
                if ((z.wr & m) && (z.own & m)) {
                    write = true;
                }
            }

            if (hasWall || !full) continue;

            // Registra la chiave globale per evitare premi duplicati al movimento
            doneUnits.add(uk);

            // Nessun premio XP se non hai scritto tu almeno un numero dell'unità
            // (solo givens o numeri di altri giocatori)
            if (!write) continue;

            gainXp(20);

            toast(
                "+20 XP — " +
                (t === "row" ? "riga" : t === "col" ? "colonna" : "3×3") +
                " completata!",
                "gold"
            );

            window.FX?.unitClear(t, cellsU);
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

                    if ((z.wr & m) && (z.own & m)) {
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
    playerStats.stats.completedSudokus++;
    if (!playerStats.isGuest) savePlayerData();
    const w = document.getElementById("win");
    document.getElementById("winTxt").textContent = "+150 XP · Livello " + level;
    window.FX?.sudokuComplete();
    // La card arriva dopo la scritta "SUDOKU!" per non sovrapporsi all'effetto
    const delay = window.FX ? 1300 : 0;
    setTimeout(() => {
        w.classList.remove("hide");
        if (AN) AN({ targets: "#win .card", scale: [.6, 1], opacity: [0, 1], duration: 450, easing: "steps(6)" });
    }, delay);
    setTimeout(() => w.classList.add("hide"), 3200 + delay);
}
document.getElementById("againBtn").onclick = () => document.getElementById("win").classList.add("hide");

/* ========== VITA / XP ========== */
let level = 1, xp = 0, xpNeed = 100, maxHp = 100, hp = 100, baseAtk = 10;

function xpNeedForLevel(l) {
    return Math.round(100 * Math.pow(1.5, Math.max(1, l) - 1));
}

// Bonus permanenti dalla sconfitta dei boss (ATK) e delle Survival Trial (HP), divisi
// fra chi ha contribuito. Arrivano dal server (messaggio "bonus" e /api/player).
let bonusHp = 0, bonusAtk = 0;

function maxHpForLevel(l) {
    return Math.round(100 * Math.pow(1.05, Math.max(1, l) - 1) + bonusHp);
}

function baseAtkForLevel(l) {
    return 10 + Math.floor((Math.max(1, l) - 1) * 2) + bonusAtk;
}

function applyBonus(msg) {
    bonusAtk = Number(msg.atk) || 0;
    bonusHp = Number(msg.hp) || 0;
    const oldMax = maxHp;
    maxHp = maxHpForLevel(level);
    baseAtk = baseAtkForLevel(level);
    // la vita massima in più si riceve anche come vita attuale
    if (maxHp > oldMax) hp = Math.min(maxHp, hp + (maxHp - oldMax));
    updateBars();

    const el = document.getElementById("hudBonus");
    if (el) {
        el.hidden = !(bonusAtk || bonusHp);
        el.textContent = `ATK +${+bonusAtk.toFixed(1)} · HP +${+bonusHp.toFixed(1)}`;
    }

    const g = msg.gained;
    if (g) {
        const label = g.field === "atk" ? "ATK" : "HP";
        const split = g.split > 1 ? ` (diviso fra ${g.split})` : "";
        toast(`Bonus sconfitta: +${g.amount} ${label}${split}`, "gold");
        window.FX?.banner(`+${g.amount} ${label}`, { cls: "gold", sub: "BONUS PERMANENTE", dur: 1600 });
    }
}

function applyDerivedStats() {
    xpNeed = xpNeedForLevel(level);
    maxHp = maxHpForLevel(level);
    baseAtk = baseAtkForLevel(level);

    if (!Number.isFinite(hp) || hp <= 0 || hp > maxHp) {
        hp = maxHp;
    }
}
const hpFill = document.getElementById("hpFill"), xpFill = document.getElementById("xpFill"), lvlEl = document.getElementById("lvl");
function updateBars() {
    hpFill.style.width = Math.max(0, hp / maxHp * 100) + "%";
    window.Abilities?.renderShield();
    xpFill.style.width = Math.min(100, xp / xpNeed * 100) + "%";
    lvlEl.textContent = "LV " + level;
    const hpText = document.getElementById("hpText");
    if (hpText) hpText.textContent = Math.max(0, hp) + " / " + maxHp;
    // HP e livello vengono mostrati ai compagni di party
    window.Social?.reportStats(hp, maxHp, level);
}
function gainXp(n) {
    xp += n;

    if (AN) {
        AN({
            targets: "#xpFill",
            scaleY: [1.6, 1],
            duration: 260,
            easing: "easeOutQuad"
        });
    }

    while (xp >= xpNeed) {
        xp -= xpNeed;
        level++;

        xpNeed = xpNeedForLevel(level);
        maxHp = maxHpForLevel(level);
        baseAtk = baseAtkForLevel(level);

        hp = maxHp;
        levelUpFx();
    }

    updateBars();
}
function levelUpFx() {
    toast("LIVELLO " + level + "!", "gold");
    window.FX?.levelUp(level);
    if (AN) AN({
        targets: "#xpFill",
        backgroundColor: ["#a3e635", "#22c55e"],
        duration: 500,
        easing: "easeOutQuad"
    });
}
function wrongNumber() {
    const dmg = Math.round(maxHp * 0.15);
    hp -= dmg;
    window.FX?.wrong(player.x, player.y, dmg);
    toast("Numero errato! −HP", "bad");
    playerStats.stats.wrongPlacements++;
    if (hp <= 0) respawn();
    updateBars();
}
function respawn() {
    window.FX?.ko();
    hp = maxHp;
    playerStats.deaths++;

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

                    if (!isPlayableCell(cx, cy) || !inLock(cx, cy)) continue;

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

            ctxMap.strokeStyle = "#1a1c2c";
            ctxMap.lineWidth = 2;
            ctxMap.strokeRect(screenX, screenY, mapBlockSize - 2, mapBlockSize - 2);
        }
    }

    // Posizione del giocatore
    const playerBlockX = player.x / 3;
    const playerBlockY = player.y / 3;

    const playerScreenX = mapCenterX + (playerBlockX - centerZx) * mapBlockSize;
    const playerScreenY = mapCenterY + (playerBlockY - centerZy) * mapBlockSize;

    const ps = Math.round(Math.max(4, mapBlockSize / 4));
    ctxMap.fillStyle = "#1a1c2c";
    ctxMap.fillRect(playerScreenX - ps - 3, playerScreenY - ps - 3, ps * 2 + 6, ps * 2 + 6);
    ctxMap.fillStyle = "#ffcd75";
    ctxMap.fillRect(playerScreenX - ps, playerScreenY - ps, ps * 2, ps * 2);
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
    // Pannello amici/party aperto: i tasti non muovono il giocatore
    if (window.Social?.isOpen()) return;
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
    if (k === "r") {
        // Durante la bossfight il blocco manuale viene completamente inibito
        if (window.bossManager && window.bossManager.isBossFightActive()) {
            return;
        }

        toggleLock();
        return;
    }
    if (k === "n") { toggleNotes(); return; }
    if (k === " ") { window.Abilities?.use(); e.preventDefault(); return; }
    if (k === "c") { window.Social?.open("search"); e.preventDefault(); return; }
    if (k === "f") { window.Social?.open("friends"); return; }
    if (k === "p") { window.Social?.open("party"); return; }
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
    window.bossManager?.relayout();
    applyCamera();
    highlight();
}
window.addEventListener("resize", fit);
async function newWorld(resetProgress = true) {
    curZone = { x: 0, y: 0 };
    winZone = { x: 0, y: 0 };

    document.getElementById("win").classList.add("hide");
    document.getElementById("phase").textContent = "Genero il mondo samurai…";
    document.getElementById("bar").style.width = "30%";

    await frame();

    zones.clear();
    cellEls.clear();
    notesEls.clear();
    notesMask.clear();

    doneUnits.clear();
    doneWindows.clear();

    worldEl.querySelectorAll(".num,.notesAbs,.zone-refl").forEach(e => e.remove());

    if (resetProgress) {
        level = 1;
        xp = 0;
    }

    applyDerivedStats();

    if (resetProgress) {
        hp = maxHp;
    }
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
let myPlayerId = null;
// Colore con cui GLI ALTRI ti vedono (marker + numeri che scrivi).
// Deve essere diverso dal blu del TUO player/numeri (var(--user) = #1d4ed8 in CSS),
// altrimenti tutti i giocatori sembrano avere lo stesso colore agli occhi altrui.
// Il server assegna il colore (messaggio "init"), stabile per ogni playerId
let myColor = "#7dd3fc"; // azzurro più chiaro
const otherPlayersEls = new Map();
let worldInitialized = false;

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
        el.classList.toggle("party", !!window.Social?.isPartyMember(p.playerId));
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

// ==========================================
// SISTEMA SALVATAGGIO PLAYER (Locale + DB)
// ==========================================
let playerStats = {
    name: "",
    isGuest: false,
    level: 1,
    xp: 0,
    deaths: 0,
    stats: {
        completedSudokus: 0,
        placedNumbers: 0,
        wrongPlacements: 0
    },
    futureFeatures: {} // Per le classi/boss future
};

// Carica dati locali salvati
function loadLocalPlayerStats() {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem('infiniteDokuStats')); } catch { /* dati corrotti: si riparte */ }
    if (!parsed || typeof parsed !== "object") return;

    playerStats = { ...playerStats, ...parsed, stats: { ...playerStats.stats, ...parsed.stats } };

    // Aggiorniamo le variabili di gioco coi dati locali, validandoli
    level = Math.max(1, Math.floor(Number(playerStats.level) || 1));
    xp = Math.max(0, Math.floor(Number(playerStats.xp) || 0));
    applyDerivedStats();
    hp = maxHp;
    updateBars();
}

function saveLocalPlayerStats() {
    playerStats.level = level;
    playerStats.xp = xp;
    try { localStorage.setItem('infiniteDokuStats', JSON.stringify(playerStats)); } catch { /* storage non disponibile */ }
}

// Salva la partita quando la pagina viene chiusa o nascosta. "beforeunload" non è
// affidabile (non parte su mobile e con la cache avanti/indietro), quindi si usa
// "pagehide" + "visibilitychange" con una richiesta keepalive che sopravvive alla
// chiusura. La sessione è un cookie, quindi viaggia con la richiesta (same-origin).
function saveOnExit() {
    saveLocalPlayerStats();

    if (!worldInitialized || playerStats.isGuest) return;

    const payload = JSON.stringify({
        level,
        xp,
        x: player.x,
        y: player.y,
        deaths: playerStats.deaths,
        stats: playerStats.stats
    });

    fetch('/api/save-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
    }).catch(() => navigator.sendBeacon('/api/save-stats', new Blob([payload], { type: 'application/json' })));
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveOnExit();
});

window.addEventListener("pagehide", () => {
    saveOnExit();

    // Chiude subito il socket: il server libera il giocatore senza aspettare il timeout
    // e il client non tenta di riconnettersi mentre la pagina sta sparendo.
    closing = true;
    if (ws) ws.close(1000);
});

// Pagina ripristinata dalla cache avanti/indietro: lo stato (mondo, socket) è vecchio.
window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
});

// ==========================================
// AVVIO PARTITA — l'autenticazione è già avvenuta su /login (sessione server).
// All'arrivo su /game chiediamo al server chi siamo e partiamo di conseguenza,
// senza più mostrare uno schermo di login dentro al gioco.
// ==========================================
async function initGame() {
    try {
        const res = await fetch("/api/player");
        const resData = await res.json();

        if (resData.status !== "success") {
            window.location.href = "/login";
            return;
        }

        const data = resData.data || {};

        myName = data.username || data.name || "Giocatore";
        myPlayerId = data.playerId || null;

        const usernameHud = document.getElementById("hud-username");
        if (usernameHud) usernameHud.innerText = myName;

        if (data.isGuest) {
            startOfflineMode(data);
            return;
        }

        createPlayerIdBadge(myPlayerId || myName);
        loadSelectedClass();

        playerStats = { ...playerStats, ...data };
        bonusAtk = Number(data.bonus?.atk) || 0;
        bonusHp = Number(data.bonus?.hp) || 0;

        // Applica progresso reale prima di newWorld(false)
        level = Math.max(1, Math.floor(Number(data.level) || 1));
        xp = Math.max(0, Math.floor(Number(data.xp) || 0));

        applyDerivedStats();
        hp = maxHp;

        const pos = data.currentPosition || {};
        const savedX = Number.isFinite(pos.x) ? pos.x : null;
        const savedY = Number.isFinite(pos.y) ? pos.y : null;

        updateBars();
        fit();

        await newWorld(false);
        worldInitialized = true;

        updateBars();

        if (savedX !== null && savedY !== null) {
            player.x = savedX;
            player.y = savedY;
            curZone = zOf(player.x, player.y);

            enterZone(curZone.x, curZone.y);
            placePlayer();
            recenter(false);
        }

        connectWebSocket();
    } catch (err) {
        console.warn("Errore caricamento sessione, avvio in modalità offline:", err);
        startOfflineMode();
    }
}

initGame();

// Gestione avvio completo in modalità locale (utenti ospiti / fallback)
function startOfflineMode(data) {
    myName = (data && (data.username || data.name)) || "Giocatore Offline";

    // Carica i dati salvati in localStorage (progressi offline locali)
    loadLocalPlayerStats();
    playerStats.isGuest = true; // forzato dopo il merge: un ospite resta un ospite

    myPlayerId = data?.playerId || myPlayerId || `Guest#${Math.floor(1000 + Math.random() * 9000)}`;
    createPlayerIdBadge(myPlayerId);

    // Se esiste una connessione WS aperta, la chiude in modo pulito
    if (ws) {
        try { ws.close(); } catch (e) { }
        ws = null;
    }

    fit();
    newWorld();
    worldInitialized = true;

    toast("Modalità Offline Attiva", "gold");
}

// Connessione WebSocket con riconnessione automatica
let reconnectDelay = 1000;
let closing = false;
function connectWebSocket() {
    if (ws) return;

    // Se l'utente è un ospite o la rete non è disponibile, evita del tutto la connessione
    if (playerStats.isGuest || !navigator.onLine) {
        console.log("Modalità offline: sincronizzazione WebSocket disabilitata.");
        return;
    }

    try {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            reconnectDelay = 1000;
            ws.send(JSON.stringify({
                type: "join",
                name: myName,
                playerId: myPlayerId,
                color: myColor,
                x: player.x,
                y: player.y
            }));

            lastSentX = player.x;
            lastSentY = player.y;
            lastSentView = "";
            window.Social?.onConnected();

            for (const key of zones.keys()) {
                const [zx, zy] = key.split(',').map(Number);
                requestZone(zx, zy);
            }
        };

        ws.onclose = (e) => {
            ws = null;
            updateOtherPlayers([]);
            window.Social?.onDisconnected();
            window.bossManager?.clear();

            // 4000 = lo stesso account è entrato da un'altra scheda: non riconnettersi
            if (closing) return;
            if (e.code === 4000) {
                toast("Sei entrato da un'altra scheda: questa è disconnessa", "bad");
                return;
            }

            setTimeout(connectWebSocket, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };

        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            window.Social?.onMessage(msg);
            window.bossManager?.onMessage(msg);
            window.Abilities?.onMessage(msg);

            if (msg.type === "init") {
                myId = msg.myId;
                if (msg.myColor) myColor = msg.myColor;

                if (msg.myPlayerId) {
                    myPlayerId = msg.myPlayerId;
                    createPlayerIdBadge(myPlayerId);
                }
            }
            else if (msg.type === "players") {
                updateOtherPlayers(msg.data);
            }
            else if (msg.type === "forced_move") {
                const from = { x: player.x, y: player.y };
                forcePosition(msg.x, msg.y);
                window.FX?.forcedMove(from, msg.x, msg.y, msg.reason, msg.by);
            }
            else if (msg.type === "move_rejected") {
                // la cella è occupata da un giocatore che non si può spingere
                forcePosition(msg.x, msg.y);
                bump();
            }
            else if (msg.type === "pushed_other") {
                window.FX?.pushedOther();
            }
            else if (msg.type === "bonus") {
                applyBonus(msg);
            }
            else if (msg.type === "wallet") {
                updateWallet(msg.currency, msg.gained, msg.note);
            }
            else if (msg.type === "write") {
                applyRemoteWrite(msg);
                if (mapMode) drawMinimap();
            }
            else if (msg.type === "zone_info") {
                const [zx, zy] = String(msg.zoneKey).split(',').map(Number);
                const z = getZone(zx, zy);
                if (z && msg.claimed) z.claimed |= msg.claimed;
                if (z && msg.writes) applyRemoteWrites(msg.zoneKey, msg.writes);
                if (mapMode) drawMinimap();
            }
        };
    } catch (e) {
        console.warn("WebSocket non disponibile, fallback offline.", e);
        ws = null;
    }
}

// Frammenti (valuta del gacha) nell'HUD
function updateWallet(currency, gained = 0, note = null) {
    const el = document.getElementById("hudGems");
    if (!el) return;
    el.textContent = "◆ " + currency;
    el.parentElement.hidden = false;
    if (gained) {
        window.FX?.floatText(player.x, player.y + 0.4, `+${gained} ◆`, "gem");
        if (note) toast(`+${gained} ◆ — completato: ${note}`, "gold");
        el.classList.remove("bump");
        void el.offsetWidth;
        el.classList.add("bump");
    }
}

// Classe scelta in home (le abilità arriveranno classe per classe)
async function loadSelectedClass() {
    try {
        const data = await (await fetch("/api/classes")).json();
        if (data.status !== "success") return;
        const el = document.getElementById("hudClass");
        const row = el.parentElement;
        row.hidden = false;
        updateWallet(data.currency);
        const sel = data.selected && data.classes.find(c => c.id === data.selected.classId);
        const v = sel?.variants.find(v => v.id === data.selected.variant);
        if (!sel || !v) {
            el.textContent = "NESSUNA CLASSE";
            return;
        }
        el.textContent = `${sel.id} · ${v.name.toUpperCase()} LV ${v.level}`;
        el.style.setProperty("--cls", sel.color);
    } catch (err) {
        console.warn("Classe non disponibile:", err);
    }
}

// UI Badge per ID Giocatore nell'angolo dello schermo
function createPlayerIdBadge(idText) {
    let badge = document.getElementById("playerIdBadge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "playerIdBadge";
        document.body.appendChild(badge);
    }
    badge.textContent = `ID: ${idText}`;
}

// Funzione di salvataggio unificata del player, tramite la sessione server
// (l'utente è già autenticato lato server: non serve più passare l'uid).
function savePlayerData() {
    if (playerStats.isGuest) return;

    fetch("/api/save-progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            x: player.x,
            y: player.y,
            level,
            xp
        })
    }).catch((err) => console.warn("Salvataggio progressi fallito:", err));

    saveLocalPlayerStats();
}

let lastFrameTime = performance.now();

function gameLoop(now) {
    const deltaTime = now - lastFrameTime;
    lastFrameTime = now;

    if (window.bossManager) {
        window.bossManager.update(deltaTime);
    }

    requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

// Salvataggio periodico dei progressi (ogni 20s) per chi resta a lungo in partita.
// Il salvataggio "di emergenza" alla chiusura pagina è invece gestito via
// sendBeacon su /api/save-stats, più affidabile di una fetch in beforeunload.
setInterval(() => {
    if (!worldInitialized) return;
    if (playerStats.isGuest) saveLocalPlayerStats();
    else savePlayerData();
}, 20000);