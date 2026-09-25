import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import { WebSocketServer } from "ws";
import { auth, db, getPlayerData } from "./firebase.js";
import { FieldValue } from "firebase-admin/firestore";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

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

function randomDiscriminator() {
    return String(1000 + Math.floor(Math.random() * 9000));
}

function isValidUsername(username) {
    const trimmed = String(username || "").trim();

    if (trimmed.length < 3 || trimmed.length > 20) return false;

    // Vieta caratteri che daremmo fastidio all'ID o alla sicurezza/UI
    if (/[#<>\/\\{}]/.test(trimmed)) return false;

    return true;
}

function sanitizePlayerIdBase(name) {
    return String(name || "")
        .trim()
        .replace(/#/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 20) || "Player";
}

async function reserveUniquePlayerId(baseName, uid) {
    const base = sanitizePlayerIdBase(baseName);

    for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = `${base}#${randomDiscriminator()}`;
        const ref = db.collection("playerIds").doc(candidate);

        let reserved = false;

        await db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            if (snap.exists) return;

            t.set(ref, {
                uid,
                createdAt: FieldValue.serverTimestamp()
            });

            reserved = true;
        });

        if (reserved) return candidate;
    }

    throw new Error("Impossibile generare un ID univoco");
}

async function ensurePlayerIdentity(userId) {
    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get();

    let data = doc.exists ? doc.data() : await getPlayerData(userId);

    // Migrazione: se un vecchio utente ha già username ma non playerId,
    // generiamo l'ID pubblico una volta sola.
    if (data.username && !data.playerId) {
        const playerId = await reserveUniquePlayerId(data.username, userId);
        await userRef.set({ playerId }, { merge: true });
        data.playerId = playerId;
    }

    return data;
}

function normalizeProgress(data) {
    const clean = { ...data };

    // Non ci interessa salvare/usare hp e maxHp come dati persistenti
    delete clean.hp;
    delete clean.maxHp;

    clean.level = Math.max(1, Math.floor(Number(clean.level) || 1));
    clean.xp = Math.max(0, Math.floor(Number(clean.xp) || 0));

    return clean;
}

// ==================== ROTTE HTML ====================

app.get("/login", (req, res) => {
    // Se l'utente è già autenticato e ha già completato il profilo,
    // lo mandiamo alla home. Se manca il nickname, lasciamo la pagina
    // e il client mostrerà la sezione username.
    if (req.session.userId && req.session.usernameSet && !req.session.isGuest) {
        return res.redirect("/");
    }

    if (req.session.isGuest) {
        return res.redirect("/game");
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

        const playerData = await ensurePlayerIdentity(userId);

        req.session.userId = userId;
        req.session.isGuest = false;
        req.session.userName = playerData.username || decodedToken.name || "Player";
        req.session.playerId = playerData.playerId || null;
        req.session.usernameSet = !!playerData.username;

        if (!playerData.username) {
            return res.json({
                status: "need_username",
                message: "Username richiesto"
            });
        }

        res.json({
            status: "success",
            user: normalizeProgress(playerData)
        });
    } catch (error) {
        console.error("Errore Login:", error);
        res.status(401).json({ status: "error", message: error.message });
    }
});

// Aggiungi la rotta per il login Offline / Ospite prima delle API protette
app.post("/api/guest-login", (req, res) => {
    req.session.userId = "guest_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    req.session.userName = "Giocatore Offline";
    req.session.isGuest = true;
    req.session.usernameSet = true;
    req.session.playerId = `Guest#${randomDiscriminator()}`;

    res.json({
        status: "success",
        playerId: req.session.playerId
    });
});

app.get("/api/login-state", async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.json({
                authenticated: false,
                isGuest: false,
                needUsername: false
            });
        }

        if (req.session.isGuest) {
            if (!req.session.playerId) {
                req.session.playerId = `Guest#${randomDiscriminator()}`;
            }

            return res.json({
                authenticated: true,
                isGuest: true,
                needUsername: false,
                playerId: req.session.playerId
            });
        }

        const data = await ensurePlayerIdentity(req.session.userId);

        req.session.userName = data.username || req.session.userName || "Player";
        req.session.playerId = data.playerId || null;
        req.session.usernameSet = !!data.username;

        res.json({
            authenticated: true,
            isGuest: false,
            needUsername: !data.username,
            playerId: data.playerId || null
        });
    } catch (err) {
        console.error("Errore login-state:", err);
        res.json({
            authenticated: !!req.session.userId,
            isGuest: !!req.session.isGuest,
            needUsername: true
        });
    }
});

app.post("/api/set-username", requireAuth, async (req, res) => {
    if (req.session.isGuest) {
        return res.status(400).json({
            status: "error",
            message: "Gli ospiti non hanno un nickname permanente"
        });
    }

    const username = String(req.body.username || "").trim();

    if (!isValidUsername(username)) {
        return res.status(400).json({
            status: "error",
            message: "Nickname non valido: 3-20 caratteri, senza # < > / \\ { }"
        });
    }

    const userRef = db.collection("users").doc(req.session.userId);
    const doc = await userRef.get();
    const data = doc.exists ? doc.data() : {};

    // Il nickname può essere impostato UNA sola volta
    if (data.username) {
        return res.status(409).json({
            status: "error",
            message: "Nickname già impostato e non modificabile"
        });
    }

    const playerId = await reserveUniquePlayerId(username, req.session.userId);

    await userRef.set({
        username,
        playerId,
        usernameSetAt: FieldValue.serverTimestamp()
    }, { merge: true });

    req.session.userName = username;
    req.session.playerId = playerId;
    req.session.usernameSet = true;

    res.json({
        status: "success",
        username,
        playerId
    });
});

// Modifica la rotta /api/player per gestire la sessione ospite
app.get("/api/player", requireAuth, async (req, res) => {
    try {
        if (req.session.isGuest) {
            if (!req.session.playerId) {
                req.session.playerId = `Guest#${randomDiscriminator()}`;
            }

            return res.json({
                status: "success",
                data: {
                    username: req.session.userName || "Giocatore Offline",
                    playerId: req.session.playerId,
                    isGuest: true,
                    level: 1,
                    xp: 0,
                    stats: {
                        completedSudokus: 0,
                        placedNumbers: 0,
                        wrongPlacements: 0
                    }
                }
            });
        }

        const data = await ensurePlayerIdentity(req.session.userId);

        if (!data.username) {
            return res.json({
                status: "need_username",
                message: "Username richiesto"
            });
        }

        req.session.userName = data.username;
        req.session.playerId = data.playerId || null;
        req.session.usernameSet = true;

        res.json({
            status: "success",
            data: normalizeProgress(data)
        });
    } catch (err) {
        console.error("Errore /api/player:", err);
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
        return res.json({ status: "success", skipped: true });
    }

    const { x, y, level, xp } = req.body || {};

    try {
        const update = {};

        const lvl = Math.floor(Number(level));
        const xpVal = Math.floor(Number(xp));

        if (Number.isFinite(lvl) && lvl >= 1) {
            update.level = lvl;
        }

        if (Number.isFinite(xpVal) && xpVal >= 0) {
            update.xp = xpVal;
        }

        if (Number.isFinite(x) && Number.isFinite(y)) {
            update.currentPosition = { x, y };
        }

        if (Object.keys(update).length) {
            await db.collection("users").doc(req.session.userId).update(update);
        }

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

    const lvl = Math.floor(Number(body.level));
    const xpVal = Math.floor(Number(body.xp));

    if (Number.isFinite(lvl) && lvl >= 1) update.level = lvl;
    if (Number.isFinite(xpVal) && xpVal >= 0) update.xp = xpVal;

    if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
        update.currentPosition = { x: body.x, y: body.y };
    }

    if (Number.isFinite(body.deaths)) update.deaths = body.deaths;

    if (body.stats && typeof body.stats === "object") {
        if (Number.isFinite(body.stats.completedSudokus)) {
            update["stats.completedSudokus"] = body.stats.completedSudokus;
        }
        if (Number.isFinite(body.stats.placedNumbers)) {
            update["stats.placedNumbers"] = body.stats.placedNumbers;
        }
        if (Number.isFinite(body.stats.wrongPlacements)) {
            update["stats.wrongPlacements"] = body.stats.wrongPlacements;
        }
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
        id: p.connectionId,
        connectionId: p.connectionId,
        playerId: p.playerId,
        x: p.x,
        y: p.y,
        name: p.name,
        color: p.color
    }));

    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: "players",
                data: playersData
            }));
        }
    });
}

wss.on("connection", (ws, req) => {
    const connectionId = Math.random().toString(36).substr(2, 9);
    const session = req.session || {};

    // Se non c'è un playerId di sessione, usarne uno temporaneo
    const playerId = session.playerId || `Guest#${randomDiscriminator()}`;
    const displayName = session.userName || "Guest";

    players[connectionId] = {
        connectionId,
        playerId,
        authUserId: session.userId || null,
        isGuest: !!session.isGuest,
        x: 4,
        y: 4,
        name: displayName,
        color: "#38bdf8"
    };

    ws.send(JSON.stringify({
        type: "init",
        myId: connectionId,
        myPlayerId: playerId,
        generator: {
            seed: WORLD_SEED,
            pattern: "samurai-cross-v1"
        }
    }));

    ws.on("message", (message) => {
        let msg;
        try {
            msg = JSON.parse(message);
        } catch (e) {
            return;
        }

        const p = players[connectionId];
        if (!p) return;

        if (msg.type === "join") {
            // Per utenti autenticati il nickname deve venire dalla sessione,
            // non dal client, così non può essere cambiato arbitrariamente.
            p.name = session.userName || msg.name || "Guest";
            p.color = msg.color || "#38bdf8";

            if (Number.isFinite(msg.x)) p.x = msg.x;
            if (Number.isFinite(msg.y)) p.y = msg.y;

            broadcastPlayers();
        }
        else if (msg.type === "move") {
            const nx = Number(msg.x);
            const ny = Number(msg.y);

            if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

            p.x = nx;
            p.y = ny;

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

            const cx = Number(msg.cx);
            const cy = Number(msg.cy);
            const val = Number(msg.val);

            if (!isPlayableZone(zx, zy)) return;
            if (!(cx >= 0 && cx <= 2 && cy >= 0 && cy <= 2)) return;

            if (!worldState.zones[zoneKey]) {
                worldState.zones[zoneKey] = { writes: {}, disc: false };
            }

            worldState.zones[zoneKey].disc = true;

            const writeKey = `${cx},${cy}`;

            if (val === 0) {
                delete worldState.zones[zoneKey].writes[writeKey];
            } else {
                worldState.zones[zoneKey].writes[writeKey] = {
                    val,
                    color: msg.color || null
                };
            }

            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "write",
                        zoneKey,
                        cx,
                        cy,
                        gx: msg.gx,
                        gy: msg.gy,
                        val,
                        color: msg.color || null
                    }));
                }
            });
        }
    });

    ws.on("close", () => {
        delete players[connectionId];
        broadcastPlayers();
    });
});

server.on("upgrade", (req, socket, head) => {
    sessionMiddleware(req, {}, () => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });
});

server.listen(3000, () => {
    console.log("Server attivo su http://localhost:3000");
});