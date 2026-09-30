import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import { randomUUID } from "crypto";
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

// ============================================================
// MONDO SAMURAI INFINITO
// ============================================================
// WORLD_VERSION serve a rigenerare il vecchio mondo se esiste già.
// Se hai dati importanti su Firebase, fai prima un backup.
const WORLD_VERSION = 2;
const GENERATOR = "samurai-cross-v1";

// Se true, prova a conservare le scritture delle zone che restano giocabili.
// Di solito, cambiando generazione, è più sicuro lasciarlo false.
const PRESERVE_OLD_WRITES_ON_RESET = false;

let worldState = { version: WORLD_VERSION, generator: GENERATOR, zones: {} };

let players = {};

// Modulo positivo
const mod = (n, m) => ((n % m) + m) % m;

const logDbError = err => console.error("Errore Firebase:", err);

// Ritorna la chiave canonica "zx,zy" oppure null se non valida.
// Evita chiavi arbitrarie usate come percorsi Firebase.
function parseZoneKey(zoneKey) {
    const parts = String(zoneKey ?? "").split(",");
    if (parts.length !== 2) return null;
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);
    if (!Number.isInteger(zx) || !Number.isInteger(zy)) return null;
    return { zx, zy, key: `${zx},${zy}` };
}

const isColor = c => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);
const cleanName = n => String(n ?? "").trim().slice(0, 24) || "Guest";

/* ============================================================
   PATTERN SAMURAI INFINITO (Sovrapposizione griglie 9x9)
   Deve restare identico a quello del client.
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

// Soluzione Sudoku infinita deterministica (identica al client).
function solutionAtCell(x, y) {
    const r = mod(y, 9);
    const c = mod(x, 9);
    return ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
}

// Stato in memoria di una zona, normalizzato: Firebase non salva oggetti vuoti,
// quindi una zona caricata può non avere "writes".
function zoneState(key) {
    const z = worldState.zones[key] ??= { disc: false, writes: {} };
    z.writes ??= {};
    return z;
}

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
    });
}

// Manda a tutti la lista aggiornata dei player online
function broadcastPlayers() {
    broadcast({
        type: "players",
        data: Object.values(players).map(({ id, x, y, name, color }) => ({ id, x, y, name, color }))
    });
}

// Caricamento del mondo da Firebase
async function loadWorld() {
    const snapshot = await database.ref("worldState").get();
    const loaded = snapshot.exists() ? snapshot.val() : null;

    if (loaded && Number(loaded.version) === WORLD_VERSION) {
        worldState = { version: WORLD_VERSION, generator: GENERATOR, zones: loaded.zones || {} };
        console.log("Mondo caricato da Firebase.");
        return;
    }

    const zones = {};
    if (loaded && PRESERVE_OLD_WRITES_ON_RESET && loaded.zones) {
        for (const [zoneKey, zoneData] of Object.entries(loaded.zones)) {
            const zk = parseZoneKey(zoneKey);
            if (zk && isPlayableZone(zk.zx, zk.zy) && zoneData?.writes) {
                zones[zk.key] = { disc: true, writes: zoneData.writes };
            }
        }
    }

    console.log(loaded ? "Vecchio mondo rilevato. Genero nuovo mondo samurai..." : "Generazione nuovo mondo su Firebase...");
    worldState = { version: WORLD_VERSION, generator: GENERATOR, zones };
    await database.ref("worldState").set(worldState);
    console.log("Nuovo mondo samurai salvato su Firebase.");
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
    const myId = randomUUID();

    players[myId] = { id: myId, x: 0, y: 0, name: "Guest", color: "#38bdf8" };

    ws.send(JSON.stringify({
        type: "init",
        myId,
        generator: { version: WORLD_VERSION, pattern: GENERATOR }
    }));

    ws.on("message", (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch { return; }
        if (!msg || typeof msg !== "object") return;

        const me = players[myId];

        if (msg.type === "join") {
            me.name = cleanName(msg.name);
            if (isColor(msg.color)) me.color = msg.color;
            if (Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
                me.x = msg.x;
                me.y = msg.y;
            }
            broadcastPlayers();
        }

        else if (msg.type === "move") {
            if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y)) return;
            me.x = msg.x;
            me.y = msg.y;
            broadcastPlayers();
        }

        else if (msg.type === "fetch_zone") {
            const zk = parseZoneKey(msg.zoneKey);
            if (!zk) return;

            const playable = isPlayableZone(zk.zx, zk.zy);
            if (!playable) {
                ws.send(JSON.stringify({ type: "zone_info", zoneKey: zk.key, playable, disc: false, writes: {} }));
                return;
            }

            const zone = zoneState(zk.key);

            // Se la zona viene scoperta per la prima volta, notifica subito TUTTI i giocatori online
            if (msg.discover && !zone.disc) {
                zone.disc = true;
                database.ref(`worldState/zones/${zk.key}/disc`).set(true).catch(logDbError);
                broadcast({ type: "zone_discovered", zoneKey: zk.key });
            }

            ws.send(JSON.stringify({
                type: "zone_info",
                zoneKey: zk.key,
                playable,
                disc: zone.disc,
                writes: zone.writes
            }));
        }

        else if (msg.type === "write") {
            const zk = parseZoneKey(msg.zoneKey);
            if (!zk || !isPlayableZone(zk.zx, zk.zy)) return;

            const { cx, cy, val } = msg;
            if (![cx, cy].every(v => Number.isInteger(v) && v >= 0 && v <= 2)) return;

            // Il server accetta solo numeri corretti: un client modificato
            // non può sporcare il mondo condiviso.
            if (val !== solutionAtCell(zk.zx * 3 + cx, zk.zy * 3 + cy)) return;

            const zone = zoneState(zk.key);
            const cellKey = `${cx},${cy}`;
            if (zone.writes[cellKey]) return; // i numeri scritti sono permanenti

            const writeData = { val, color: isColor(msg.color) ? msg.color : players[myId].color };
            zone.writes[cellKey] = writeData;

            if (!zone.disc) {
                zone.disc = true;
                database.ref(`worldState/zones/${zk.key}/disc`).set(true).catch(logDbError);
            }
            database.ref(`worldState/zones/${zk.key}/writes/${cellKey}`).set(writeData).catch(logDbError);

            // Broadcast della scrittura a TUTTI i client connessi
            broadcast({ type: "write", zoneKey: zk.key, cx, cy, val, color: writeData.color });
        }
    });

    // Senza un listener, un errore del socket farebbe crashare il processo.
    ws.on("error", err => console.warn("Errore WebSocket:", err.message));

    ws.on("close", () => {
        delete players[myId];
        broadcastPlayers();
    });
});

// Le connessioni vengono accettate solo dopo il caricamento del mondo,
// altrimenti le scritture arrivate prima verrebbero perse.
loadWorld()
    .then(() => {
        const server = app.listen(PORT, () => console.log(`Server Sudoku attivo su porta ${PORT}`));
        server.on("upgrade", (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
        });
    })
    .catch(err => {
        console.error("Impossibile caricare il mondo da Firebase:", err);
        process.exit(1);
    });
