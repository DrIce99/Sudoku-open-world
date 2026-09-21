import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import { WebSocketServer } from "ws";
import { auth, db, getPlayerData } from "./firebase.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessionMiddleware = session({
    secret: "sudoku_secret_key_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 ore
});

app.use(sessionMiddleware);

// Middleware di protezione rotte (sostituisce @login_required)
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    next();
}

// ==================== ROTTE HTML ====================

app.get("/login", (req, res) => {
    if (req.session.userId) {
        return res.redirect("/");
    }
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "views", "home.html"));
});

app.get("/game", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "views", "game.html"));
});

// ==================== API AUTH ====================

app.post("/api/login", async (req, res) => {
    const { idToken } = req.body;
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        const userId = decodedToken.uid;

        req.session.userId = userId;
        req.session.userName = decodedToken.name || "Player";

        const playerData = await getPlayerData(userId);

        if (!playerData.username) {
            return res.json({
                status: "need_username",
                message: "Username richiesto"
            });
        }

        res.json({ status: "success", user: playerData });
    } catch (error) {
        console.error("Errore Login:", error);
        res.status(401).json({ status: "error", message: error.message });
    }
});

// Aggiungi la rotta per il login Offline / Ospite prima delle API protette
app.post("/api/guest-login", (req, res) => {
    req.session.userId = "guest_" + Date.now();
    req.session.userName = "Giocatore Offline";
    req.session.isGuest = true;

    res.json({ status: "success" });
});

app.post("/api/set-username", requireAuth, async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim().length < 3) {
        return res.status(400).json({ status: "error", message: "Username troppo corto" });
    }

    await db.collection("users").doc(req.session.userId).update({
        username: username.trim()
    });

    res.json({ status: "success" });
});

// Modifica la rotta /api/player per gestire la sessione ospite
app.get("/api/player", requireAuth, async (req, res) => {
    try {
        if (req.session.isGuest) {
            return res.json({
                status: "success",
                data: {
                    username: req.session.userName || "Giocatore Offline",
                    isGuest: true,
                    stats: { completedSudokus: 0, placedNumbers: 0, wrongPlacements: 0 }
                }
            });
        }

        const data = await getPlayerData(req.session.userId);
        res.json({ status: "success", data });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});

// ==================== SALVATAGGIO PROGRESSI ====================
// Il client non conosce/non passa mai lo userId: viene sempre preso dalla sessione.

app.post("/api/save-progress", requireAuth, async (req, res) => {
    if (req.session.isGuest) {
        // Gli ospiti non hanno un profilo Firestore da aggiornare.
        return res.json({ status: "success", skipped: true });
    }

    const { x, y, level, xp, hp, maxHp } = req.body || {};

    try {
        await db.collection("users").doc(req.session.userId).update({
            ...(Number.isFinite(x) && Number.isFinite(y) ? { currentPosition: { x, y } } : {}),
            ...(Number.isFinite(level) ? { level } : {}),
            ...(Number.isFinite(xp) ? { xp } : {}),
            ...(Number.isFinite(hp) ? { hp } : {}),
            ...(Number.isFinite(maxHp) ? { maxHp } : {})
        });
        res.json({ status: "success" });
    } catch (err) {
        console.error("Errore salvataggio progressi:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// Endpoint "di emergenza" chiamato via navigator.sendBeacon al beforeunload.
// Riceve l'intero oggetto playerStats del client (level, xp, hp, x, y, stats.*).
app.post("/api/save-stats", requireAuth, async (req, res) => {
    if (req.session.isGuest) return res.status(204).end();

    const body = req.body || {};
    const update = {};

    if (Number.isFinite(body.level)) update.level = body.level;
    if (Number.isFinite(body.xp)) update.xp = body.xp;
    if (Number.isFinite(body.hp)) update.hp = body.hp;
    if (Number.isFinite(body.maxHp)) update.maxHp = body.maxHp;
    if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
        update.currentPosition = { x: body.x, y: body.y };
    }
    if (Number.isFinite(body.deaths)) update.deaths = body.deaths;
    if (body.stats && typeof body.stats === "object") {
        if (Number.isFinite(body.stats.completedSudokus)) update["stats.completedSudokus"] = body.stats.completedSudokus;
        if (Number.isFinite(body.stats.placedNumbers)) update["stats.placedNumbers"] = body.stats.placedNumbers;
        if (Number.isFinite(body.stats.wrongPlacements)) update["stats.wrongPlacements"] = body.stats.wrongPlacements;
    }

    try {
        if (Object.keys(update).length) {
            await db.collection("users").doc(req.session.userId).update(update);
        }
        res.status(204).end();
    } catch (err) {
        console.error("Errore save-stats:", err);
        res.status(500).end();
    }
});

// ==================== MOTORE MONDO SAMURAI INFINITO (WebSocket) ====================
// Stessa logica deterministica del client (game.js): a parità di seed, client e
// server calcolano indipendentemente la stessa soluzione sudoku, quindi non serve
// trasmettere il mondo intero — solo le celle scritte dai giocatori vengono salvate qui.

const WORLD_SEED = 20260222;

const mod = (n, m) => ((n % m) + m) % m;

function isPlayableZone(zx, zy) {
    for (let gx = zx - 2; gx <= zx; gx++) {
        if (mod(gx, 2) !== 0) continue;
        for (let gy = zy - 2; gy <= zy; gy++) {
            if (mod(gy, 2) !== 0) continue;
            if (mod(gx + gy, 4) === 0) return true;
        }
    }
    return false;
}

function parseZoneKey(zoneKey) {
    const parts = String(zoneKey || "").split(",");
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);
    if (!Number.isFinite(zx) || !Number.isFinite(zy)) return { zx: 0, zy: 0 };
    return { zx, zy };
}

// worldState.zones[zoneKey] = { writes: { "lx,ly": {val,color} }, disc: bool }
// In memoria per semplicità: si azzera se il processo riparte. Se vuoi la
// persistenza tra riavvii, questo è il punto dove salvare/leggere da Firestore
// (es. una collection "worldZones" con un documento per zoneKey).
const worldState = { zones: {} };

let players = {};

function broadcastPlayers() {
    const playersData = Object.values(players).map(p => ({
        id: p.id, x: p.x, y: p.y, name: p.name, color: p.color
    }));
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "players", data: playersData }));
        }
    });
}

wss.on("connection", (ws) => {
    const myId = Math.random().toString(36).substr(2, 9);

    players[myId] = { id: myId, x: 4, y: 4, name: "Guest", color: "#38bdf8" };

    ws.send(JSON.stringify({
        type: "init",
        myId,
        generator: { seed: WORLD_SEED, pattern: "samurai-cross-v1" }
    }));

    ws.on("message", (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch (e) { return; }

        if (msg.type === "join") {
            players[myId].name = msg.name || "Guest";
            players[myId].color = msg.color || "#38bdf8";
            if (Number.isFinite(msg.x)) players[myId].x = msg.x;
            if (Number.isFinite(msg.y)) players[myId].y = msg.y;
            broadcastPlayers();
        }

        else if (msg.type === "move") {
            const nx = Number(msg.x), ny = Number(msg.y);
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
            if (msg.discover) worldState.zones[zoneKey].disc = true;

            ws.send(JSON.stringify({
                type: "zone_info",
                zoneKey,
                playable,
                writes: worldState.zones[zoneKey].writes || {}
            }));
        }

        else if (msg.type === "write") {
            if (!msg.zoneKey) return;
            const zoneKey = String(msg.zoneKey);
            const { zx, zy } = parseZoneKey(zoneKey);
            const cx = Number(msg.cx), cy = Number(msg.cy), val = Number(msg.val);

            if (!isPlayableZone(zx, zy)) return;
            if (!(cx >= 0 && cx <= 2 && cy >= 0 && cy <= 2)) return;

            if (!worldState.zones[zoneKey]) {
                worldState.zones[zoneKey] = { writes: {}, disc: false };
            }
            worldState.zones[zoneKey].disc = true;

            const writeData = { val, color: msg.color || null };
            worldState.zones[zoneKey].writes[`${cx},${cy}`] = writeData;

            // Broadcast a TUTTI i client connessi (mittente incluso, come nel client originale)
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "write",
                        zoneKey, cx, cy, gx: msg.gx, gy: msg.gy, val, color: msg.color || null
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

server.listen(3000, () => {
    console.log("Server attivo su http://localhost:3000");
});