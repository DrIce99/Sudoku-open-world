import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { auth, db, getPlayerData, updatePlayerData, serverTimestamp } from "./firebase.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

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

// Le chiavi del Realtime Database non possono contenere . $ # [ ] /
const idKey = id => id.replace(/[.$#\[\]\/%]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function reserveUniquePlayerId(baseName, uid) {
    const base = sanitizePlayerIdBase(baseName);

    for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = `${base}#${randomDiscriminator()}`;

        // La transazione scrive solo se l'ID è libero
        const { committed } = await db.ref(`playerIds/${idKey(candidate)}`).transaction(
            current => current === null ? { uid, createdAt: Date.now() } : undefined
        );

        if (committed) return candidate;
    }

    throw new Error("Impossibile generare un ID univoco");
}

async function ensurePlayerIdentity(userId) {
    const data = await getPlayerData(userId);

    // Migrazione: se un vecchio utente ha già username ma non playerId,
    // generiamo l'ID pubblico una volta sola.
    if (data.username && !data.playerId) {
        const playerId = await reserveUniquePlayerId(data.username, userId);
        await updatePlayerData(userId, { playerId });
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

    const data = await getPlayerData(req.session.userId);

    // Il nickname può essere impostato UNA sola volta
    if (data.username) {
        return res.status(409).json({
            status: "error",
            message: "Nickname già impostato e non modificabile"
        });
    }

    const playerId = await reserveUniquePlayerId(username, req.session.userId);

    await updatePlayerData(req.session.userId, {
        username,
        playerId,
        usernameSetAt: serverTimestamp()
    });

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
            await updatePlayerData(req.session.userId, update);
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
            update["stats/completedSudokus"] = body.stats.completedSudokus;
        }
        if (Number.isFinite(body.stats.placedNumbers)) {
            update["stats/placedNumbers"] = body.stats.placedNumbers;
        }
        if (Number.isFinite(body.stats.wrongPlacements)) {
            update["stats/wrongPlacements"] = body.stats.wrongPlacements;
        }
    }

    try {
        if (Object.keys(update).length) {
            await updatePlayerData(req.session.userId, update);
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

// Soluzione Sudoku infinita deterministica (identica al client).
function solutionAtCell(x, y) {
    const r = mod(y, 9);
    const c = mod(x, 9);
    return ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
}

// Ritorna { zx, zy, key } con la chiave canonica, oppure null se non valida.
function parseZoneKey(zoneKey) {
    const parts = String(zoneKey ?? "").split(",");
    if (parts.length !== 2) return null;
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);
    if (!Number.isInteger(zx) || !Number.isInteger(zy)) return null;
    return { zx, zy, key: `${zx},${zy}` };
}

const isColor = c => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
    });
}

// worldState.zones[zoneKey] = { writes: { "lx,ly": {val,color} }, disc: bool }
// In memoria per semplicità: si azzera se il processo riparte. Se vuoi la
// persistenza tra riavvii, questo è il punto dove salvare/leggere dal Realtime Database
// (es. un nodo "worldState/zones/<zoneKey>" per zona).
const worldState = { zones: {} };

function zoneState(key) {
    return worldState.zones[key] ??= { writes: {}, disc: false };
}

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

    broadcast({ type: "players", data: playersData });
}

// Heartbeat: una connessione che non risponde (rete caduta, scheda congelata)
// viene terminata, così il suo giocatore sparisce dal mondo.
setInterval(() => {
    wss.clients.forEach(client => {
        if (!client.isAlive) return client.terminate();
        client.isAlive = false;
        client.ping();
    });
}, 30000);

wss.on("connection", (ws, req) => {
    const connectionId = randomUUID();
    const session = req.session || {};

    // Se non c'è un playerId di sessione, usarne uno temporaneo
    const playerId = session.playerId || `Guest#${randomDiscriminator()}`;
    const displayName = session.userName || "Guest";

    // Un account = una connessione: se lo stesso utente entra da un'altra scheda
    // (o la vecchia connessione è rimasta appesa) quella precedente viene chiusa,
    // così non restano giocatori "fantasma" fermi nel mondo.
    if (session.userId && !session.isGuest) {
        for (const other of Object.values(players)) {
            if (other.authUserId === session.userId) other.ws.close(4000, "replaced");
        }
    }

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    players[connectionId] = {
        ws,
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
        if (!msg || typeof msg !== "object") return;

        const p = players[connectionId];
        if (!p) return;

        if (msg.type === "join") {
            // Per utenti autenticati il nickname deve venire dalla sessione,
            // non dal client, così non può essere cambiato arbitrariamente.
            p.name = session.userName || String(msg.name ?? "").trim().slice(0, 24) || "Guest";
            if (isColor(msg.color)) p.color = msg.color;

            if (Number.isInteger(msg.x)) p.x = msg.x;
            if (Number.isInteger(msg.y)) p.y = msg.y;

            broadcastPlayers();
        }
        else if (msg.type === "move") {
            if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y)) return;

            p.x = msg.x;
            p.y = msg.y;

            broadcastPlayers();
        }
        else if (msg.type === "fetch_zone") {
            const zk = parseZoneKey(msg.zoneKey);
            if (!zk) return;

            const playable = isPlayableZone(zk.zx, zk.zy);
            const zone = playable ? zoneState(zk.key) : { writes: {} };

            if (msg.discover) zone.disc = true;

            ws.send(JSON.stringify({
                type: "zone_info",
                zoneKey: zk.key,
                playable,
                writes: zone.writes
            }));
        }
        else if (msg.type === "write") {
            const zk = parseZoneKey(msg.zoneKey);
            if (!zk || !isPlayableZone(zk.zx, zk.zy)) return;

            const { cx, cy, val } = msg;
            if (![cx, cy].every(v => Number.isInteger(v) && v >= 0 && v <= 2)) return;

            const zone = zoneState(zk.key);
            zone.disc = true;

            const writeKey = `${cx},${cy}`;
            const color = isColor(msg.color) ? msg.color : null;

            if (val === 0) {
                // Rimozione (es. attacco di un boss)
                delete zone.writes[writeKey];
            } else {
                // Solo il numero corretto, e mai sopra uno già scritto:
                // un client modificato non può sporcare il mondo condiviso.
                if (val !== solutionAtCell(zk.zx * 3 + cx, zk.zy * 3 + cy)) return;
                if (zone.writes[writeKey]) return;
                zone.writes[writeKey] = { val, color };
            }

            // Le coordinate globali vengono ricavate dal client a partire da zona e cella locale.
            broadcast({ type: "write", zoneKey: zk.key, cx, cy, val, color });
        }
    });

    // Senza un listener, un errore del socket farebbe crashare il processo.
    ws.on("error", err => console.warn("Errore WebSocket:", err.message));

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