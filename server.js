import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

// Inizializza Firebase Admin SDK
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://infinite-doku-default-rtdb.europe-west1.firebasedatabase.app"
});

const database = getDatabase();

const app = express();
app.use(express.json());

const PORT = 8080;
const server = app.listen(PORT, () => console.log(`Server Sudoku attivo su porta ${PORT}`));

const wss = new WebSocketServer({ server });

// ============================================================
// NUOVO MONDO SAMURAI INFINITO
// ============================================================
// WORLD_VERSION = 2 serve a rigenerare il vecchio mondo se esiste già.
// Se hai dati importanti su Firebase, fai prima un backup.
const WORLD_VERSION = 2;


// Se true, prova a conservare le scritture delle zone che restano giocabili.
// Di solito, cambiando generazione, è più sicuro lasciarlo false.
const PRESERVE_OLD_WRITES_ON_RESET = false;

// Se true, il server blocca anche i movimenti verso zone vuote.
// Richiede che msg.x e msg.y siano coordinate globali di cella.
// Se il tuo client usa coordinate locali/view, lascialo false e blocca solo lato client.
const SERVER_BLOCK_EMPTY_MOVEMENT = false;

let worldState = {
    version: WORLD_VERSION,
    globalSolution: [],
    immortalMask: [],
    zones: {}
};

worldState.seed = 20260222;

let players = {};

// Helper shuffle esistente
const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

// Modulo positivo
const mod = (n, m) => ((n % m) + m) % m;

function parseZoneKey(zoneKey) {
    const parts = String(zoneKey || "").split(",");
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);

    if (!Number.isFinite(zx) || !Number.isFinite(zy)) {
        return { zx: 0, zy: 0 };
    }

    return { zx, zy };
}

// ============================================================
// MASCHERA DEL MONDO
// ============================================================
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

// ============================================================
// SOLUZIONE INFINITA DETERMINISTICA
// ============================================================
// Questa formula genera una soluzione Sudoku valida per finestre 9x9
// allineate a blocchi 3x3, usando coordinate globali.
// Non è più necessario "risolvere" un blocco partendo dai vicini.
function solutionAtCell(x, y) {
    const r = mod(y, 9);
    const c = mod(x, 9);
    return ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
}

function zoneSolutionPayload(zx, zy) {
    const solution = {};

    for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
            const key = `${cx},${cy}`;
            solution[key] = solutionAtCell(zx * 3 + cx, zy * 3 + cy);
        }
    }

    return solution;
}

// Costruisce la finestra 9x9 iniziale centrata sulla zona (0,0).
// La zona centrale (0,0) è giocabile.
function buildInitialWorld(preservedZones = {}) {
    const globalSolution = new Array(81).fill(0);
    const immortalMask = new Array(81).fill(0);
    const activeIndices = [];

    // Finestra 9x9 attorno alla zona centrale (0,0).
    // La zona centrale occupa le celle globali x = 0,1,2 e y = 0,1,2.
    // La finestra parte quindi da x = -3, y = -3.
    const startX = -3;
    const startY = -3;

    for (let vy = 0; vy < 9; vy++) {
        for (let vx = 0; vx < 9; vx++) {
            const x = startX + vx;
            const y = startY + vy;

            const zx = Math.floor(x / 3);
            const zy = Math.floor(y / 3);

            const i = vy * 9 + vx;

            if (isPlayableZone(zx, zy)) {
                globalSolution[i] = solutionAtCell(x, y);
                activeIndices.push(i);
            } else {
                // Blocco vuoto / muro
                globalSolution[i] = 0;
            }
        }
    }

    shuffle(activeIndices);

    const immortalCount = Math.min(38, activeIndices.length);
    for (let i = 0; i < immortalCount; i++) {
        immortalMask[activeIndices[i]] = 1;
    }

    return {
        version: WORLD_VERSION,
        generator: "samurai-cross-v1",
        globalSolution,
        immortalMask,
        zones: preservedZones
    };
}

// Caricamento del mondo da Firebase
database.ref("worldState").get().then((snapshot) => {
    if (snapshot.exists()) {
        const loaded = snapshot.val();

        // Se il mondo è vecchio, rigeneriamo il nuovo mondo samurai.
        if (Number(loaded.version) !== WORLD_VERSION) {
            console.log("Vecchio mondo rilevato. Genero nuovo mondo samurai...");

            let preserved = {};

            if (PRESERVE_OLD_WRITES_ON_RESET && loaded.zones) {
                for (const [zoneKey, zoneData] of Object.entries(loaded.zones)) {
                    const { zx, zy } = parseZoneKey(zoneKey);

                    if (isPlayableZone(zx, zy) && zoneData && zoneData.writes) {
                        preserved[zoneKey] = { writes: zoneData.writes };
                    }
                }
            }

            worldState = buildInitialWorld(preserved);
            database.ref("worldState").set(worldState);

            console.log("Nuovo mondo samurai salvato su Firebase.");
        } else {
            worldState = loaded;

            if (!worldState.zones) worldState.zones = {};

            if (worldState.globalSolution) {
                worldState.globalSolution = Object.values(worldState.globalSolution);
            }

            if (worldState.immortalMask) {
                worldState.immortalMask = Object.values(worldState.immortalMask);
            }

            console.log("Mondo caricato da Firebase.");
        }
    } else {
        console.log("Generazione nuovo mondo su Firebase...");

        worldState = buildInitialWorld();
        database.ref("worldState").set(worldState);

        console.log("Nuovo mondo samurai salvato su Firebase.");
    }
});

// Manda a tutti la lista aggiornata dei player online
function broadcastPlayers() {
    const playersData = Object.values(players).map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        name: p.name,
        color: p.color
    }));

    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "players", data: playersData }));
        }
    });
}

wss.on("connection", (ws) => {
    let myId = Math.random().toString(36).substr(2, 9);

    players[myId] = {
        id: myId,
        x: 4,
        y: 4,
        name: "Guest",
        color: "#38bdf8",
        ws
    };

    // Invia stato iniziale a chi si connette
    ws.send(JSON.stringify({
        type: "init",
        world: worldState,
        myId,
        generator: {
            version: WORLD_VERSION,
            pattern: "samurai-cross-v1"
        }
    }));

    // 1. Quando una zona viene scoperta o modificata, aggiorna sia le scritture che il flag disc
    ws.on("message", (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch (err) { return; }

        if (msg.type === "join") {
            players[myId].name = msg.name;
            players[myId].color = msg.color || "#38bdf8";
            players[myId].x = msg.x || players[myId].x;
            players[myId].y = msg.y || players[myId].y;
            broadcastPlayers();
        }

        else if (msg.type === "move") {
            const nx = Number(msg.x);
            const ny = Number(msg.y);
            if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

            players[myId].x = nx;
            players[myId].y = ny;
            broadcastPlayers();
        }

        else if (msg.type === "fetch_zone") {
            if (!msg.zoneKey) return;
            const zoneKey = String(msg.zoneKey);
            const { zx, zy } = parseZoneKey(zoneKey);
            const playable = isPlayableZone(zx, zy);

            if (!worldState.zones[zoneKey]) {
                worldState.zones[zoneKey] = { writes: {}, disc: false };
            }

            // Se la zona viene scoperta per la prima volta, notifica subito TUTTI i giocatori online
            if (msg.discover && !worldState.zones[zoneKey].disc) {
                worldState.zones[zoneKey].disc = true;
                database.ref(`worldState/zones/${zoneKey}/disc`).set(true);

                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: "zone_discovered",
                            zoneKey
                        }));
                    }
                });
            }

            const zoneData = worldState.zones[zoneKey];
            ws.send(JSON.stringify({
                type: "zone_info",
                zoneKey,
                playable,
                disc: zoneData.disc || false,
                writes: zoneData.writes || {}
            }));
        }

        else if (msg.type === "write") {
            if (!msg.zoneKey) return;
            const zoneKey = String(msg.zoneKey);
            const { zx, zy } = parseZoneKey(zoneKey);
            const cx = Number(msg.cx), cy = Number(msg.cy), val = Number(msg.val);

            if (!isPlayableZone(zx, zy)) return;

            if (!worldState.zones[zoneKey]) {
                worldState.zones[zoneKey] = { writes: {}, disc: true };
            }

            worldState.zones[zoneKey].disc = true;
            const writeData = { val, color: msg.color };
            worldState.zones[zoneKey].writes[`${cx},${cy}`] = writeData;

            database.ref(`worldState/zones/${zoneKey}/disc`).set(true);
            database.ref(`worldState/zones/${zoneKey}/writes/${cx},${cy}`).set(writeData);

            // Broadcast della scrittura a TUTTI i client connessi
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "write",
                        zoneKey, cx, cy, gx: msg.gx, gy: msg.gy, val, color: msg.color
                    }));
                }
            });
        }
    });

    ws.on("close", () => {
        delete players[myId];
        broadcastPlayers();
    });
});

// Endpoint per ricevere il salvataggio delle statistiche utente via sendBeacon
app.post('/save-stats', (req, res) => {
    const { uid, stats } = req.body;

    if (uid && stats) {
        database.ref('users/' + uid).update(stats)
            .then(() => res.status(200).send('Salvato'))
            .catch(() => res.status(500).send('Errore Salvataggio'));
    } else {
        res.status(400).send('Dati mancanti');
    }
});