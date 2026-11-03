// ==================== GENERAZIONE DETERMINISTICA DEL MONDO ====================
// Stessa logica del client (public/js/game.js): a parità di seed, client e server
// calcolano indipendentemente la stessa soluzione e gli stessi numeri iniziali.
// Se cambi qualcosa qui, va cambiato in modo identico anche in game.js.

export const WORLD_SEED = 20260222;
// Da cambiare quando cambia la generazione: il server scarta i numeri salvati di un mondo diverso
export const WORLD_VERSION = 2;

export const mod = (n, m) => ((n % m) + m) % m;

// Percentuale di celle rivelate per difficoltà della zona
const REVEAL = { easy: .40, mid: .32, hard: .24 };

export function isPlayableZone(zx, zy) {
    for (let gx = zx - 2; gx <= zx; gx++) {
        if (mod(gx, 2) !== 0) continue;
        for (let gy = zy - 2; gy <= zy; gy++) {
            if (mod(gy, 2) !== 0) continue;
            if (mod(gx + gy, 4) === 0) return true;
        }
    }
    return false;
}

// Soluzione Sudoku infinita deterministica, mescolata dal seed.
// Base: la soluzione "a scorrimento" ((3r + r/3 + c) % 9) + 1, valida per ogni 9x9
// allineato ai blocchi 3x3, ma con le righe sempre in ordine (1-9 ruotato).
// Trasformazioni che restano valide per TUTTI i 9x9 del mondo infinito:
//  - in ogni striscia verticale di 3 colonne (blocco x) le colonne si scambiano;
//  - in ogni striscia orizzontale di 3 righe (blocco y) le righe si scambiano;
//  - le cifre vengono rinominate con una permutazione globale.
// (Righe, colonne e 3x3 contengono gli stessi numeri della base, solo in altro ordine.)
const PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const stripPerm = (i, salt) => PERMS3[Math.floor(hashCoord(i, 0, salt) * 6)];
export function solutionAtCell(x, y) {
    const zx = Math.floor(x / 3), zy = Math.floor(y / 3);
    const c = mod(zx * 3 + stripPerm(zx, 31)[mod(x, 3)], 9);
    const r = mod(zy * 3 + stripPerm(zy, 37)[mod(y, 3)], 9);
    return digitMap()[(r * 3 + Math.floor(r / 3) + c) % 9];
}

// Permutazione delle cifre 1-9 dal seed (calcolata una volta)
let digitPerm = null;
function digitMap() {
    if (digitPerm) return digitPerm;
    const rng = mulberry32((WORLD_SEED ^ 0x5bd1e995) >>> 0);
    const d = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (let i = 8; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return digitPerm = d;
}

function hashCoord(x, y, salt = 0) {
    let h = WORLD_SEED | 0;

    h = Math.imul(h ^ Math.imul(x | 0, 374761393), 668265263);
    h = Math.imul(h ^ Math.imul(y | 0, 19349663), 2246822519);
    h = Math.imul(h ^ Math.imul(salt | 0, 2654435761), 1597334677);

    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Celle "immortali": numeri iniziali fissi che i boss non possono togliere.
export function isImmortalCell(x, y) {
    return hashCoord(x, y, 11) < 0.20;
}

function zoneSeed(zx, zy) {
    let h = WORLD_SEED | 0;

    h = Math.imul(h ^ Math.imul(zx | 0, 73856093), 668265263);
    h ^= Math.imul(zy | 0, 19349663);

    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;

    return h >>> 0;
}

function mulberry32(a) {
    return function () {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Maschera a 9 bit dei numeri iniziali (rivelati) di una zona giocabile.
// Replica genSingleZone() del client, compreso l'ordine delle chiamate a rng().
const revealCache = new Map();
export function revealedMask(zx, zy) {
    const key = zx + "," + zy;
    if (revealCache.has(key)) return revealCache.get(key);
    if (!isPlayableZone(zx, zy)) return 0;

    const rng = mulberry32(zoneSeed(zx, zy));
    const roll = rng();
    const diff = roll > 0.7 ? "hard" : roll > 0.4 ? "mid" : "easy";
    const p = REVEAL[diff];

    let rev = 0;
    for (let ly = 0; ly < 3; ly++) {
        for (let lx = 0; lx < 3; lx++) {
            // il || salta rng() sulle celle immortali, esattamente come nel client
            if (isImmortalCell(zx * 3 + lx, zy * 3 + ly) || rng() < p) rev |= 1 << (ly * 3 + lx);
        }
    }

    if (revealCache.size > 50000) revealCache.clear();
    revealCache.set(key, rev);
    return rev;
}
