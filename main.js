const AN = window.anime || null;
const pc = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const bit = v => 1 << (v - 1);
const mod = (v, c) => ((v % c) + c) % c;
const frame = () => new Promise(r => setTimeout(r, 0));

// Indirizzo del server multiplayer (WebSocket).
const SERVER_HOST = "localhost:8080";

// Posizionamento in celle indipendente da CELL: al resize basta aggiornare --cell.
const px = n => `calc(var(--cell) * ${n})`;

/* ========== DIFFICOLTA' ZONE (percentuale di celle rivelate) ========== */
const REVEAL = { easy: .40, mid: .32, hard: .24 };

/* ========== MONDO A ZONE (3x3 celle ciascuna) ========== */
let CELL = 52;

// Seed del mondo: deve coincidere su tutti i client (generazione deterministica).
const WORLD_SEED = 20260222;

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
let curZone = { x: 0, y: 0 }, winZone = { x: 0, y: 0 }, mapMode = false;
let worldReady = false;
const doneUnits = new Set(), doneWindows = new Set();

const zKey = (x, y) => x + "," + y;
const zOf = (cx, cy) => ({ x: Math.floor(cx / 3), y: Math.floor(cy / 3) });
const zLocal = (cx, cy) => mod(cy, 3) * 3 + mod(cx, 3);
const getZone = (zx, zy) => zones.get(zKey(zx, zy));
const zoneOfCell = (cx, cy) => { const z = zOf(cx, cy); return getZone(z.x, z.y); };

function parseZoneKey(key) {
    const [x, y] = String(key).split(",").map(Number);
    return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

/* ============================================================
   PATTERN SAMURAI INFINITO (Sovrapposizione griglie 9x9)
   Deve restare identico a quello del server.
   ============================================================ */

function isPlayableZone(zx, zy) {
    // Il blocco (zx, zy) è giocabile se fa parte di almeno una griglia 9x9 (3x3 blocchi).
    // Le origini delle griglie hanno coordinate pari con somma multipla di 4.
    for (let gx = zx - 2; gx <= zx; gx++) {
        if (mod(gx, 2) !== 0) continue;
        for (let gy = zy - 2; gy <= zy; gy++) {
            if (mod(gy, 2) !== 0) continue;
            if (mod(gx + gy, 4) === 0) return true;
        }
    }
    return false;
}

function isPlayableCell(cx, cy) {
    return isPlayableZone(Math.floor(cx / 3), Math.floor(cy / 3));
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
    let h = WORLD_SEED | 0;

    h = Math.imul(h ^ Math.imul(x | 0, 374761393), 668265263);
    h = Math.imul(h ^ Math.imul(y | 0, 19349663), 2246822519);
    h = Math.imul(h ^ Math.imul(salt | 0, 2654435761), 1597334677);

    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Celle "immortali" / givens fissi globali.
function isImmortalCell(x, y) {
    return hashCoord(x, y, 11) < 0.20;
}

// Seed deterministico per ogni zona.
function zoneSeed(zx, zy) {
    let h = WORLD_SEED | 0;

    h = Math.imul(h ^ Math.imul(zx | 0, 73856093), 668265263);
    h ^= Math.imul(zy | 0, 19349663);

    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;

    return h >>> 0;
}

/* ---------- sincronizzazione zone / scritture remote ---------- */

// Chiede al server stato e scritture della zona (e la segna come scoperta).
function requestZone(key) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "fetch_zone", zoneKey: key, discover: true }));
    }
}

// Applica una scrittura arrivata dal server (lx/ly locali alla zona).
// Le scritture di zone non ancora generate vengono ignorate: arriveranno
// con la risposta "zone_info" quando la zona verrà generata.
function applyRemoteWrite(zx, zy, lx, ly, val, color) {
    const z = getZone(zx, zy);
    if (!z || z.empty) return;
    if (!Number.isInteger(lx) || !Number.isInteger(ly) || lx < 0 || lx > 2 || ly < 0 || ly > 2) return;

    const li = ly * 3 + lx, m = 1 << li;

    // Non sovrascrivere givens o numeri già scritti; scarta valori non corretti.
    if ((z.rev & m) || (z.wr & m) || z.v[li] !== val) return;

    z.wr |= m;

    const gx = zx * 3 + lx, gy = zy * 3 + ly;
    notesMask.delete(zKey(gx, gy));
    renderNotes(gx, gy);

    const el = createNum(gx, gy, val, "written_other");
    if (color) el.style.color = color;

    highlight();
}

function applyRemoteWrites(zx, zy, writes) {
    for (const [k, w] of Object.entries(writes || {})) {
        const [lx, ly] = k.split(",").map(Number);
        if (w) applyRemoteWrite(zx, zy, lx, ly, Number(w.val), w.color);
    }
}

function cellShown(cx, cy) {
    const z = zoneOfCell(cx, cy);
    if (!z) return 0;
    const li = zLocal(cx, cy), m = 1 << li;
    if ((z.rev & m) || (z.wr & m)) return z.v[li];
    return 0;
}
/* origine cella della FINESTRA ATTIVA = i 9 3x3 centrati su winZone */
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
    for (let i = 0; i < 81; i++) {
        const div = document.createElement("div");
        div.className = "grid-cell";
        activeBox.appendChild(div);
        gridCells.push(div);
    }
})();

function highlight() {
    const { ox, oy } = winOrigin();
    const plx = player.x - ox;
    const ply = player.y - oy;
    const pInWin = (plx >= 0 && plx < 9 && ply >= 0 && ply < 9);

    const valUnderPlayer = cellShown(player.x, player.y);

    if (valUnderPlayer) {
        document.documentElement.style.setProperty("--same-bg", numColors[valUnderPlayer]);
    }

    const pBoxX = Math.floor(plx / 3);
    const pBoxY = Math.floor(ply / 3);

    for (let ly = 0; ly < 9; ly++) {
        for (let lx = 0; lx < 9; lx++) {
            const el = gridCells[ly * 9 + lx];
            const sameBox = Math.floor(lx / 3) === pBoxX && Math.floor(ly / 3) === pBoxY;
            el.classList.toggle("hl", pInWin && (lx === plx || ly === ply || sameBox));
            el.classList.toggle("same", !!valUnderPlayer && cellShown(ox + lx, oy + ly) === valUnderPlayer);
        }
    }
}

/* ---------- camera & finestra attiva ---------- */
function applyCamera() {
    const cx = cam.x * CELL, cy = cam.y * CELL;
    worldEl.style.transform = `translate(${Math.round(innerWidth / 2 - cx)}px,${Math.round(innerHeight / 2 - cy)}px)`;
    gridBg.style.backgroundPosition = `${mod(innerWidth / 2 - cx - 1, CELL)}px ${mod(innerHeight / 2 - cy - 1, CELL)}px`;
}
function camTo(x, y, dur = 300) {
    if (!AN) { cam.x = x; cam.y = y; applyCamera(); return; }
    AN.remove(cam);
    AN({ targets: cam, x, y, duration: dur, easing: "easeOutQuad", update: applyCamera });
}
function recenter(animate) {
    winZone = { x: curZone.x, y: curZone.y };
    const t = { x: winZone.x * 3 + 1.5, y: winZone.y * 3 + 1.5 };
    activeBox.style.left = px((winZone.x - 1) * 3);
    activeBox.style.top = px((winZone.y - 1) * 3);
    if (animate) camTo(t.x, t.y);
    else { if (AN) AN.remove(cam); cam.x = t.x; cam.y = t.y; applyCamera(); }
    highlight();
}

/* ---------- generazione procedurale ---------- */
function createNum(cx, cy, v, cls) {
    const k = zKey(cx, cy); let el = cellEls.get(k);
    if (!el) {
        el = document.createElement("div"); el.className = "num"; el.style.left = px(cx); el.style.top = px(cy);
        worldEl.appendChild(el); cellEls.set(k, el);
    }
    el.textContent = v; el.classList.remove("given", "written", "written_other"); el.classList.add(cls);
    return el;
}

// Genera (se non esiste già) i dati e la resa visiva di UNA singola zona 3x3.
// La generazione è deterministica: la stessa zona risulta identica su tutti i client.
function genSingleZone(tzx, tzy) {
    const key = zKey(tzx, tzy);
    const existing = zones.get(key);
    if (existing) return existing;

    const ox = tzx * 3;
    const oy = tzy * 3;

    const playable = isPlayableZone(tzx, tzy);

    // Riflesso visivo della zona.
    const reflEl = document.createElement("div");
    reflEl.className = "zone-refl";
    reflEl.style.left = px(ox);
    reflEl.style.top = px(oy);
    worldEl.appendChild(reflEl);

    // ZONA VUOTA / MURO
    if (!playable) {
        reflEl.classList.add("empty");

        const z = { v: new Uint8Array(9), rev: 0, wr: 0, h0: 0, disc: true, diff: "empty", empty: true };
        zones.set(key, z);
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

            // Attenzione: l'ordine delle chiamate a rng() determina i givens,
            // non va cambiato o il mondo diventa diverso tra versioni del client.
            if (isImmortalCell(worldX, worldY) || rng() < p) {
                rev |= 1 << li;
                createNum(worldX, worldY, val, "given");
            }
        }
    }

    // Una zona generata è stata vista: conta come scoperta (anche per la mappa).
    const z = { v, rev, wr: 0, h0: 9 - pc(rev), disc: true, diff, empty: false };
    zones.set(key, z);

    requestZone(key);
    return z;
}

// Genera le zone mancanti della finestra 3x3 di zone centrata su (zx, zy).
// Ritorna true se almeno una zona giocabile è stata creata.
function ensureWindow(zx, zy) {
    let created = false;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (getZone(zx + dx, zy + dy)) continue;
            if (!genSingleZone(zx + dx, zy + dy).empty) created = true;
        }
    }
    return created;
}

/* ========== GIOCATORE ========== */
function updateCoords() {
    document.getElementById("coordX").textContent = player.x;
    document.getElementById("coordY").textContent = player.y;
    document.getElementById("coordZ").textContent = `Zona: ${curZone.x}, ${curZone.y}`;
}

let lastSentX = null;
let lastSentY = null;

// Invia la posizione solo quando cambia realmente
function sendPlayerMove() {
    if (ws && ws.readyState === 1 && (player.x !== lastSentX || player.y !== lastSentY)) {
        lastSentX = player.x;
        lastSentY = player.y;
        ws.send(JSON.stringify({ type: "move", x: player.x, y: player.y }));
    }
}

function placePlayer() {
    playerEl.style.left = px(player.x);
    playerEl.style.top = px(player.y);
    highlight();
    updateCoords();
    sendPlayerMove();
    scheduleSave();
}

// Unico punto in cui il giocatore cambia posizione: gestisce cambio zona,
// generazione della nuova finestra e ricentraggio della camera.
function moveTo(nx, ny, animate = true) {
    player.x = nx;
    player.y = ny;

    const nz = zOf(nx, ny);
    const zoneChanged = nz.x !== curZone.x || nz.y !== curZone.y;
    curZone = nz;

    if (zoneChanged && follow) {
        if (ensureWindow(nz.x, nz.y)) toast("Nuova zona generata!");
        recenter(animate);
    }

    placePlayer();
}

function inLock(x, y) { return !lockRect || (x >= lockRect.x0 && x <= lockRect.x1 && y >= lockRect.y0 && y <= lockRect.y1); }
function bump() { if (AN) AN({ targets: playerEl, translateX: [0, -3, 3, 0], duration: 160 }); }

// Una cella è raggiungibile se è nel lock, non è un muro e la sua zona esiste.
function canEnter(x, y) {
    if (!inLock(x, y) || !isPlayableCell(x, y)) return false;
    const z = zOf(x, y);
    genSingleZone(z.x, z.y);
    return true;
}

function tryMove(dx, dy) {
    const nx = player.x + dx;
    const ny = player.y + dy;

    if (!canEnter(nx, ny) || cellShown(nx, ny) !== 0) {
        bump();
        return;
    }

    moveTo(nx, ny);
}
function toggleLock() {
    follow = !follow;
    if (!follow) {
        const { ox, oy } = winOrigin();
        lockRect = { x0: ox, y0: oy, x1: ox + 8, y1: oy + 8 };
        activeBox.classList.add("locked");
        document.getElementById("lockBadge").style.display = "block";
    } else {
        lockRect = null; activeBox.classList.remove("locked");
        document.getElementById("lockBadge").style.display = "none";
        curZone = zOf(player.x, player.y);
        // Mentre il mondo era bloccato il giocatore può essere arrivato al bordo:
        // la nuova finestra può richiedere zone non ancora generate.
        if (ensureWindow(curZone.x, curZone.y)) toast("Nuova zona generata!");
        recenter(true);
    }
}

/* ========== NUMERI ========== */
let notesMode = false;
function renderNotes(cx, cy) {
    const k = zKey(cx, cy), m = notesMask.get(k) || 0;
    let el = notesEls.get(k);
    if (!m) { if (el) { el.remove(); notesEls.delete(k); } return; }
    if (!el) {
        el = document.createElement("div"); el.className = "notesAbs";
        el.style.left = px(cx); el.style.top = px(cy);
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
    if (notesMode) {
        if (cellShown(player.x, player.y) !== 0) return;

        const k = zKey(player.x, player.y);
        const m = (notesMask.get(k) || 0) ^ bit(d);

        if (m) notesMask.set(k, m);
        else notesMask.delete(k);

        renderNotes(player.x, player.y);
        return;
    }

    // Movimento verso cella adiacente che contiene quel numero.
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = player.x + dx;
        const ny = player.y + dy;

        if (canEnter(nx, ny) && cellShown(nx, ny) === d) {
            moveTo(nx, ny);
            return;
        }
    }

    // Sei su una cella già numerata: input ignorato.
    if (cellShown(player.x, player.y) !== 0) {
        bump();
        return;
    }

    // Scrittura nella cella attuale.
    const z = zoneOfCell(player.x, player.y);
    const li = zLocal(player.x, player.y);

    if (z && !z.empty && z.v[li] === d) doWrite(z, li, d);
    else wrongNumber();
}
function doWrite(z, li, d) {
    const cx = player.x;
    const cy = player.y;

    z.wr |= 1 << li;

    notesMask.delete(zKey(cx, cy));
    renderNotes(cx, cy);

    const el = createNum(cx, cy, d, "written");
    if (AN) AN({ targets: el, scale: [.3, 1.25, 1], duration: 300, easing: "easeOutBack" });

    stats.numbersWritten++;
    sendWrite(cx, cy, d);

    gainXp(5);
    checkCompletion(cx, cy);
    highlight();
    scheduleSave();
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
    // Solo le note a matita sono cancellabili: i numeri scritti (propri o altrui)
    // sono permanenti.
    const k = zKey(player.x, player.y);
    if (notesMask.delete(k)) renderNotes(player.x, player.y);
}

/* ========== UNITA' DELLA FINESTRA ATTIVA (9 righe, 9 colonne, 9 box) ========== */
function unitCells(t, idx) {
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

// Chiave globale dell'unità: righe e colonne dipendono anche dalla posizione
// della finestra (la stessa y in due finestre diverse è una riga diversa).
function unitKey(t, idx) {
    const { ox, oy } = winOrigin();
    if (t === "row") return `row|${ox},${oy + idx}`;
    if (t === "col") return `col|${ox + idx},${oy}`;
    return `box|${winZone.x - 1 + (idx % 3)},${winZone.y - 1 + Math.floor(idx / 3)}`;
}

const unitFull = cells => cells.every(([cx, cy]) => isPlayableCell(cx, cy) && cellShown(cx, cy) !== 0);

// Premia le unità completate dalla scrittura appena fatta in (cx, cy).
function checkCompletion(cx, cy) {
    const { ox, oy } = winOrigin();
    const lx = cx - ox, ly = cy - oy;
    if (lx < 0 || lx > 8 || ly < 0 || ly > 8) return;

    const units = [["row", ly], ["col", lx], ["box", Math.floor(ly / 3) * 3 + Math.floor(lx / 3)]];

    for (const [t, idx] of units) {
        const uk = unitKey(t, idx);
        if (doneUnits.has(uk)) continue;

        const cellsU = unitCells(t, idx);
        if (!unitFull(cellsU)) continue;

        doneUnits.add(uk);
        gainXp(20);
        toast("+20 XP — " + (t === "row" ? "riga" : t === "col" ? "colonna" : "3×3") + " completata!", "gold");

        if (AN) {
            AN({
                targets: cellsU.map(([x, y]) => cellEls.get(zKey(x, y))).filter(Boolean),
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

    // Completamento della finestra attiva 9x9
    const windowKey = zKey(winZone.x, winZone.y);
    if (doneWindows.has(windowKey)) return;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const z = getZone(winZone.x + dx, winZone.y + dy);
            if (!z) return;
            if (!z.empty && pc(z.rev | z.wr) !== 9) return;
        }
    }

    doneWindows.add(windowKey);
    gainXp(150);
    showWin();
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
const stats = { deaths: 0, numbersWritten: 0 };
const xpNeedFor = lv => Math.round(100 * Math.pow(1.5, lv - 1));
const hpFill = document.getElementById("hpFill"), xpFill = document.getElementById("xpFill"), lvlEl = document.getElementById("lvl");
function updateBars() {
    hpFill.style.width = Math.max(0, hp / maxHp * 100) + "%";
    xpFill.style.width = Math.min(100, xp / xpNeed * 100) + "%";
    lvlEl.textContent = "LV " + level;
    document.getElementById("hpText").textContent = Math.max(0, hp) + " / " + maxHp;
}
function gainXp(n) {
    xp += n;
    if (AN) AN({ targets: "#xpFill", scaleY: [1.6, 1], duration: 260, easing: "easeOutQuad" });
    while (xp >= xpNeed) {
        xp -= xpNeed; level++;
        xpNeed = xpNeedFor(level);
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
    scheduleSave();
}
function respawn() {
    hp = maxHp;
    stats.deaths++;

    // Cella libera più vicina al centro della zona corrente (rispettando il lock).
    let best = null;
    let bd = Infinity;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const tzx = curZone.x + dx;
            const tzy = curZone.y + dy;

            const z = getZone(tzx, tzy);
            if (!z || z.empty) continue;

            for (let li = 0; li < 9; li++) {
                if ((z.rev | z.wr) & (1 << li)) continue;

                const cx = tzx * 3 + li % 3;
                const cy = tzy * 3 + (li / 3 | 0);
                if (!inLock(cx, cy)) continue;

                const d = Math.abs(cx - curZone.x * 3 - 1) + Math.abs(cy - curZone.y * 3 - 1);
                if (d < bd) {
                    bd = d;
                    best = [cx, cy];
                }
            }
        }
    }

    if (best) moveTo(best[0], best[1], false);

    toast("Sei esausto… riposo e rinascita!", "bad");
}

/* ========== TOAST ========== */
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
const mapWrap = document.getElementById("mapWrap"), mapC = document.getElementById("mapC");
const view = { cx: 0, cy: 0, zoom: 26 };
function openMap() { mapMode = true; mapWrap.style.display = "block"; view.cx = curZone.x; view.cy = curZone.y; drawMinimap(); }
function closeMap() { mapMode = false; mapWrap.style.display = "none"; }
function zoneProgress(z) {
    if (!z.h0) return 1;
    const hidden = pc((~(z.rev | z.wr)) & 511);
    return 1 - hidden / z.h0;
}
function drawMinimap() {
    const ctxMap = mapC.getContext("2d");

    mapC.width = mapWrap.clientWidth || window.innerWidth;
    mapC.height = mapWrap.clientHeight || window.innerHeight;

    ctxMap.clearRect(0, 0, mapC.width, mapC.height);

    const size = view.zoom;
    const midX = mapC.width / 2;
    const midY = mapC.height / 2;

    const rangeX = Math.ceil(mapC.width / (2 * size)) + 1;
    const rangeY = Math.ceil(mapC.height / (2 * size)) + 1;

    for (let zx = Math.floor(view.cx - rangeX); zx <= Math.ceil(view.cx + rangeX); zx++) {
        for (let zy = Math.floor(view.cy - rangeY); zy <= Math.ceil(view.cy + rangeY); zy++) {
            const z = getZone(zx, zy);

            // Disegna solo le zone giocabili già scoperte
            if (!z || z.empty || !z.disc) continue;

            const screenX = midX + (zx - view.cx) * size;
            const screenY = midY + (zy - view.cy) * size;

            // Gradiente verde in base al progresso: da verde chiarissimo a verde pieno
            const progress = zoneProgress(z);
            const saturation = Math.round(35 + progress * 55);
            const lightness = Math.round(92 - progress * 50);

            ctxMap.fillStyle = `hsl(142, ${saturation}%, ${lightness}%)`;
            ctxMap.fillRect(screenX, screenY, size - 2, size - 2);

            ctxMap.strokeStyle = "#94a3b8";
            ctxMap.lineWidth = 1;
            ctxMap.strokeRect(screenX, screenY, size - 2, size - 2);
        }
    }

    // Posizione del giocatore (centro della sua cella)
    const playerScreenX = midX + ((player.x + .5) / 3 - view.cx) * size;
    const playerScreenY = midY + ((player.y + .5) / 3 - view.cy) * size;

    ctxMap.fillStyle = "#ef4444";
    ctxMap.beginPath();
    ctxMap.arc(playerScreenX, playerScreenY, Math.max(3, size / 5), 0, Math.PI * 2);
    ctxMap.fill();
}
mapWrap.addEventListener("wheel", e => {
    e.preventDefault();
    view.zoom = Math.max(8, Math.min(120, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); drawMinimap();
}, { passive: false });

/* ========== INPUT ========== */
const DIRS = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
document.addEventListener("keydown", e => {
    if (!worldReady || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    const k = e.key.toLowerCase();
    if (mapMode) {
        if (k === "m" || k === "escape") { closeMap(); return; }
        const pan = DIRS[k];
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
    const mv = DIRS[k];
    if (mv) { tryMove(mv[0], mv[1]); e.preventDefault(); return; }
    if (/^[1-9]$/.test(k)) { pressDigit(+k); e.preventDefault(); return; }
    if (k === "backspace" || k === "delete" || k === "0") { eraseCur(); e.preventDefault(); return; }
});

/* ========== AVVIO ========== */
function fit() {
    CELL = Math.max(36, Math.min(72, Math.floor(Math.min(innerWidth, innerHeight) / 9)));
    document.documentElement.style.setProperty("--cell", CELL + "px");
    gridBg.style.backgroundSize = CELL + "px " + CELL + "px";
    applyCamera();
    if (mapMode) drawMinimap();
}
window.addEventListener("resize", fit);

// Prima cella libera vicino al centro della zona (0,0).
function defaultSpawn() {
    const z = getZone(0, 0);
    for (let r = 0; r < 2; r++) {
        for (let ly = 0; ly < 3; ly++) {
            for (let lx = 0; lx < 3; lx++) {
                if (Math.max(Math.abs(lx - 1), Math.abs(ly - 1)) !== r) continue;
                if (!((z.rev | z.wr) & (1 << (ly * 3 + lx)))) return [lx, ly];
            }
        }
    }
    return [1, 1];
}

async function newWorld(spawn) {
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

    notesMode = false;
    follow = true;
    lockRect = null;
    activeBox.classList.remove("locked");
    document.getElementById("lockBadge").style.display = "none";

    ensureWindow(0, 0);

    const [sx, sy] = spawn && isPlayableCell(spawn[0], spawn[1]) ? spawn : defaultSpawn();
    player.x = sx;
    player.y = sy;
    curZone = zOf(sx, sy);
    ensureWindow(curZone.x, curZone.y);

    document.getElementById("bar").style.width = "100%";

    await frame();

    fit();
    recenter(false);
    placePlayer();

    document.getElementById("loader").classList.add("hide");
    updateBars();

    if (AN) AN({ targets: playerEl, scale: [0, 1], duration: 500, easing: "easeOutBack" });
}

// ==========================================
// SALVATAGGIO PLAYER (Locale + Firebase)
// ==========================================
const LOCAL_KEY = "infiniteDokuStats";
let onlineMode = false;
let saveTimer = null;

const currentUser = () => (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth().currentUser : null;

function snapshotStats() {
    return {
        name: myName, level, xp, hp, maxHp,
        deaths: stats.deaths, numbersWritten: stats.numbersWritten,
        x: player.x, y: player.y
    };
}

// Ripristina le statistiche salvate (locali o da Firebase), validandole.
function applyStats(data) {
    if (!data) return;
    const int = (v, def) => Number.isInteger(v) ? v : def;
    level = Math.max(1, int(data.level, 1));
    xpNeed = xpNeedFor(level);
    xp = Math.max(0, Math.min(xpNeed - 1, int(data.xp, 0)));
    maxHp = Math.max(1, int(data.maxHp, 100));
    hp = int(data.hp, maxHp);
    if (hp <= 0 || hp > maxHp) hp = maxHp;
    stats.deaths = Math.max(0, int(data.deaths, 0));
    stats.numbersWritten = Math.max(0, int(data.numbersWritten, 0));
}
const savedSpawn = data => data && Number.isInteger(data.x) && Number.isInteger(data.y) ? [data.x, data.y] : null;

function loadLocalStats() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { return null; }
}

function savePlayerData() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!worldReady) return;

    const data = snapshotStats();
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch { /* storage non disponibile */ }

    const user = currentUser();
    if (onlineMode && user) {
        firebase.database().ref("users/" + user.uid).update({ id: user.uid, ...data })
            .catch(err => console.warn("Salvataggio Firebase fallito:", err));
    }
}

// Salvataggio raggruppato: evita una scrittura su Firebase a ogni passo.
function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(savePlayerData, 2000);
}

// "beforeunload" non garantisce il completamento di richieste asincrone:
// si salva appena la pagina viene nascosta (cambio tab, chiusura, mobile).
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") savePlayerData(); });
window.addEventListener("pagehide", savePlayerData);

// ====== LOGICA MULTIPLAYER ======
let ws = null;
let myId = null;
let myName = "";
// Colore con cui GLI ALTRI ti vedono (marker + numeri che scrivi).
// Deve essere diverso dal blu del TUO player/numeri (var(--user) in CSS).
const myColor = "#7dd3fc";
const otherPlayersEls = new Map();
let reconnectDelay = 1000;
let started = false;

document.getElementById("loginBtn").onclick = () => {
    firebase.auth().signInWithPopup(provider).then(() => {
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

        el.style.setProperty("--p-color", p.color || "#38bdf8");
        el.style.left = px(p.x);
        el.style.top = px(p.y);
        el.querySelector(".p-name").textContent = p.name || "Guest";
    });

    // Rimuove i giocatori disconnessi
    for (const [id, el] of otherPlayersEls) {
        if (!currentIds.has(id)) {
            el.remove();
            otherPlayersEls.delete(id);
        }
    }
}

async function startGame(saved) {
    document.getElementById("loginScreen").style.display = "none";
    applyStats(saved);
    fit();
    await newWorld(savedSpawn(saved));
    worldReady = true;
}

document.getElementById("startGameBtn").onclick = async () => {
    const user = currentUser();
    if (started) return;
    if (!user) { startOfflineMode(); return; }
    started = true;

    myName = document.getElementById("usernameInput").value.trim() || "Guest";

    let saved = null;
    try {
        const snapshot = await firebase.database().ref("users/" + user.uid).once("value");
        saved = snapshot.val();
        onlineMode = true;
    } catch (err) {
        console.warn("Errore caricamento Firebase, avvio locale:", err);
        started = false;
        startOfflineMode();
        return;
    }

    createPlayerIdBadge(user.uid);
    await startGame(saved);
    savePlayerData();
    connectWebSocket();
};

// Avvia la partita in locale (nessun multiplayer, salvataggio solo nel browser)
async function startOfflineMode() {
    if (started) return;
    started = true;
    myName = document.getElementById("usernameInput").value.trim() || "Giocatore Offline";
    await startGame(loadLocalStats());
    toast("Modalità Offline", "gold");
}

document.getElementById("offlineBtn").onclick = startOfflineMode;

function handleServerMessage(msg) {
    if (msg.type === "init") {
        myId = msg.myId;
    }
    else if (msg.type === "players") {
        updateOtherPlayers(msg.data || []);
    }
    else if (msg.type === "write") {
        const z = parseZoneKey(msg.zoneKey);
        if (!z) return;
        applyRemoteWrite(z.x, z.y, Number(msg.cx), Number(msg.cy), Number(msg.val), msg.color);
        if (mapMode) drawMinimap();
    }
    else if (msg.type === "zone_discovered") {
        const z = parseZoneKey(msg.zoneKey);
        if (!z) return;
        // Generazione deterministica: la zona risulta identica su tutti i client,
        // così la scoperta si riflette subito anche su chi non è passato di lì.
        genSingleZone(z.x, z.y).disc = true;
        if (mapMode) drawMinimap();
    }
    else if (msg.type === "zone_info") {
        const z = parseZoneKey(msg.zoneKey);
        if (!z) return;
        applyRemoteWrites(z.x, z.y, msg.writes);
        if (mapMode) drawMinimap();
    }
}

// Connessione WebSocket con riconnessione automatica
function connectWebSocket() {
    ws = new WebSocket(`ws://${SERVER_HOST}`);

    ws.onopen = () => {
        reconnectDelay = 1000;
        ws.send(JSON.stringify({ type: "join", name: myName, color: myColor, x: player.x, y: player.y }));
        lastSentX = player.x;
        lastSentY = player.y;

        // Le zone generate prima della connessione non hanno ancora ricevuto
        // le scritture degli altri giocatori.
        for (const [key, z] of zones) if (!z.empty) requestZone(key);
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleServerMessage(msg);
    };

    ws.onclose = () => {
        updateOtherPlayers([]);
        setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
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
