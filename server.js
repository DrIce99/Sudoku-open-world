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
const idFromKey = key => key.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// Indice per la ricerca dei giocatori, senza distinzione maiuscole/minuscole:
//   playerSearch/<idKey(playerId in minuscolo)> = { uid, playerId }
const searchKey = playerId => idKey(playerId.toLowerCase());

async function reserveUniquePlayerId(baseName, uid) {
    const base = sanitizePlayerIdBase(baseName);

    for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = `${base}#${randomDiscriminator()}`;

        // La transazione scrive solo se l'ID è libero
        const { committed } = await db.ref(`playerIds/${idKey(candidate)}`).transaction(
            current => current === null ? { uid, createdAt: Date.now() } : undefined
        );

        if (committed) {
            await db.ref(`playerSearch/${searchKey(candidate)}`).set({ uid, playerId: candidate });
            return candidate;
        }
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

    // Amici e richieste hanno le loro API (/api/friends): non servono nel profilo
    delete clean.friends;
    delete clean.friendRequests;
    delete clean.friendRequestsSent;

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

// ==================== AMICI ====================
// Struttura nel Realtime Database (le chiavi sono gli uid):
//   users/<uid>/friends/<uidAmico>              = { playerId, username, since }
//   users/<uid>/friendRequests/<uidMittente>    = { playerId, username, at }   (ricevute)
//   users/<uid>/friendRequestsSent/<uidDest>    = { playerId, username, at }   (inviate)
// Il client conosce solo i playerId pubblici: l'uid si ricava da playerIds/<id>.

const MAX_FRIENDS = 100;
const MAX_PENDING = 50;

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Gli ospiti non hanno un account permanente, quindi niente amici
function requireAccount(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ status: "error", message: "Non autenticato" });
    }
    if (req.session.isGuest) {
        return res.status(403).json({ status: "error", message: "Accedi con Google per avere una lista amici" });
    }
    next();
}

// Avvolge un handler async: gli errori diventano risposte JSON
const api = fn => async (req, res) => {
    try {
        res.json({ status: "success", ...(await fn(req, res)) });
    } catch (err) {
        if (!(err instanceof ApiError)) console.error("Errore API amici:", err);
        res.status(err.status || 500).json({ status: "error", message: err instanceof ApiError ? err.message : "Errore del server" });
    }
};

async function sessionIdentity(req) {
    if (!req.session.playerId || !req.session.userName) {
        const data = await ensurePlayerIdentity(req.session.userId);
        req.session.playerId = data.playerId || null;
        req.session.userName = data.username || req.session.userName;
    }
    if (!req.session.playerId) throw new ApiError(400, "Scegli prima un nickname");
    return { uid: req.session.userId, playerId: req.session.playerId, username: req.session.userName };
}

// Trova un giocatore dal suo ID pubblico ("Nome#1234")
async function identityFromPlayerId(playerId) {
    const pid = String(playerId ?? "").trim();
    if (!pid || pid.length > 40 || !pid.includes("#")) {
        throw new ApiError(400, "ID non valido: usa il formato Nome#1234");
    }
    const snap = await db.ref(`playerIds/${idKey(pid)}`).get();
    const uid = snap.exists() ? snap.val().uid : null;
    if (!uid) throw new ApiError(404, `Nessun giocatore con ID ${pid}`);
    const username = (await db.ref(`users/${uid}/username`).get()).val() || pid.split("#")[0];
    return { uid, playerId: pid, username };
}

const isOnlineUid = uid => Object.values(players).some(p => p.authUserId === uid);

// "game" se è nel mondo, "home" se è connesso dalla home, null se offline
function presenceOf(uid) {
    const conns = Object.values(players).filter(p => p.authUserId === uid);
    if (!conns.length) return null;
    return conns.some(p => !p.lobby) ? "game" : "home";
}

function notifyUid(uid, data) {
    const payload = JSON.stringify(data);
    for (const p of Object.values(players)) {
        if (p.authUserId === uid && p.ws.readyState === 1) p.ws.send(payload);
    }
}

async function countChildren(path) {
    const snap = await db.ref(path).get();
    return snap.exists() ? Object.keys(snap.val()).length : 0;
}

function makeFriends(a, b) {
    const since = Date.now();
    return db.ref().update({
        [`users/${a.uid}/friends/${b.uid}`]: { playerId: b.playerId, username: b.username, since },
        [`users/${b.uid}/friends/${a.uid}`]: { playerId: a.playerId, username: a.username, since },
        [`users/${a.uid}/friendRequests/${b.uid}`]: null,
        [`users/${a.uid}/friendRequestsSent/${b.uid}`]: null,
        [`users/${b.uid}/friendRequests/${a.uid}`]: null,
        [`users/${b.uid}/friendRequestsSent/${a.uid}`]: null
    });
}

const listOf = obj => Object.entries(obj || {}).map(([uid, v]) => ({ uid, ...v }));

// Ricerca giocatori per nome o ID (prefisso, senza distinzione maiuscole/minuscole)
app.get("/api/players/search", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (!q || q.length > 40) return { results: [] };

    const prefix = idKey(q);
    const [hits, friendsSnap, inSnap, outSnap] = await Promise.all([
        db.ref("playerSearch").orderByKey().startAt(prefix).endAt(prefix + "").limitToFirst(21).get(),
        db.ref(`users/${me.uid}/friends`).get(),
        db.ref(`users/${me.uid}/friendRequests`).get(),
        db.ref(`users/${me.uid}/friendRequestsSent`).get()
    ]);

    const has = (snap, uid) => !!snap.val()?.[uid];
    const myParty = partyOf.get(me.playerId);

    const results = await Promise.all(Object.values(hits.val() || {})
        .filter(h => h.uid !== me.uid)
        .slice(0, 20)
        .map(async h => {
            const [username, level] = await Promise.all([
                db.ref(`users/${h.uid}/username`).get(),
                db.ref(`users/${h.uid}/level`).get()
            ]);
            const party = partyOf.get(h.playerId);
            return {
                playerId: h.playerId,
                username: username.val() || h.playerId.split("#")[0],
                level: level.val() || 1,
                presence: presenceOf(h.uid),
                friend: has(friendsSnap, h.uid),
                requestSent: has(outSnap, h.uid),
                requestReceived: has(inSnap, h.uid),
                inMyParty: !!party && party === myParty,
                inParty: !!party
            };
        }));

    results.sort((a, b) => (!!b.presence - !!a.presence) || a.username.localeCompare(b.username));
    return { results };
}));

app.get("/api/friends", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const [friendsSnap, inSnap, outSnap] = await Promise.all([
        db.ref(`users/${me.uid}/friends`).get(),
        db.ref(`users/${me.uid}/friendRequests`).get(),
        db.ref(`users/${me.uid}/friendRequestsSent`).get()
    ]);

    const friends = await Promise.all(listOf(friendsSnap.val()).map(async f => ({
        playerId: f.playerId,
        username: f.username,
        since: f.since,
        level: (await db.ref(`users/${f.uid}/level`).get()).val() || 1,
        online: isOnlineUid(f.uid),
        presence: presenceOf(f.uid),
        inMyParty: !!partyOf.get(f.playerId) && partyOf.get(f.playerId) === partyOf.get(me.playerId)
    })));
    friends.sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));

    const strip = r => ({ playerId: r.playerId, username: r.username, at: r.at });
    return {
        me: { playerId: me.playerId, username: me.username },
        friends,
        incoming: listOf(inSnap.val()).map(strip).sort((a, b) => b.at - a.at),
        outgoing: listOf(outSnap.val()).map(strip).sort((a, b) => b.at - a.at)
    };
}));

app.post("/api/friends/request", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const them = await identityFromPlayerId(req.body?.playerId);

    if (them.uid === me.uid) throw new ApiError(400, "Non puoi aggiungere te stesso");
    if ((await db.ref(`users/${me.uid}/friends/${them.uid}`).get()).exists()) {
        throw new ApiError(409, `${them.username} è già tuo amico`);
    }

    // Se l'altro ci aveva già chiesto l'amicizia, la richiesta vale come accettazione
    if ((await db.ref(`users/${me.uid}/friendRequests/${them.uid}`).get()).exists()) {
        await makeFriends(me, them);
        notifyUid(them.uid, { type: "friends_changed", message: `${me.username} ha accettato la tua richiesta di amicizia` });
        return { message: `Ora tu e ${them.username} siete amici!`, accepted: true };
    }

    if ((await db.ref(`users/${me.uid}/friendRequestsSent/${them.uid}`).get()).exists()) {
        throw new ApiError(409, `Hai già inviato una richiesta a ${them.username}`);
    }
    if (await countChildren(`users/${me.uid}/friends`) >= MAX_FRIENDS) {
        throw new ApiError(409, `Hai raggiunto il limite di ${MAX_FRIENDS} amici`);
    }
    if (await countChildren(`users/${them.uid}/friendRequests`) >= MAX_PENDING ||
        await countChildren(`users/${me.uid}/friendRequestsSent`) >= MAX_PENDING) {
        throw new ApiError(409, "Troppe richieste in sospeso");
    }

    const at = Date.now();
    await db.ref().update({
        [`users/${them.uid}/friendRequests/${me.uid}`]: { playerId: me.playerId, username: me.username, at },
        [`users/${me.uid}/friendRequestsSent/${them.uid}`]: { playerId: them.playerId, username: them.username, at }
    });

    notifyUid(them.uid, { type: "friend_request", from: { playerId: me.playerId, username: me.username } });
    return { message: `Richiesta inviata a ${them.username}` };
}));

app.post("/api/friends/accept", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const them = await identityFromPlayerId(req.body?.playerId);

    if (!(await db.ref(`users/${me.uid}/friendRequests/${them.uid}`).get()).exists()) {
        throw new ApiError(404, "Richiesta non trovata");
    }
    if (await countChildren(`users/${me.uid}/friends`) >= MAX_FRIENDS) {
        throw new ApiError(409, `Hai raggiunto il limite di ${MAX_FRIENDS} amici`);
    }

    await makeFriends(me, them);
    notifyUid(them.uid, { type: "friends_changed", message: `${me.username} ha accettato la tua richiesta di amicizia` });
    return { message: `Ora tu e ${them.username} siete amici!` };
}));

app.post("/api/friends/decline", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const them = await identityFromPlayerId(req.body?.playerId);
    await db.ref().update({
        [`users/${me.uid}/friendRequests/${them.uid}`]: null,
        [`users/${them.uid}/friendRequestsSent/${me.uid}`]: null
    });
    notifyUid(them.uid, { type: "friends_changed" });
    return { message: "Richiesta rifiutata" };
}));

app.post("/api/friends/cancel", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const them = await identityFromPlayerId(req.body?.playerId);
    await db.ref().update({
        [`users/${me.uid}/friendRequestsSent/${them.uid}`]: null,
        [`users/${them.uid}/friendRequests/${me.uid}`]: null
    });
    notifyUid(them.uid, { type: "friends_changed" });
    return { message: "Richiesta annullata" };
}));

app.post("/api/friends/remove", requireAccount, api(async (req) => {
    const me = await sessionIdentity(req);
    const them = await identityFromPlayerId(req.body?.playerId);
    await db.ref().update({
        [`users/${me.uid}/friends/${them.uid}`]: null,
        [`users/${them.uid}/friends/${me.uid}`]: null
    });
    notifyUid(them.uid, { type: "friends_changed" });
    return { message: `${them.username} rimosso dagli amici` };
}));

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

// Ogni giocatore ha un colore stabile ricavato dal proprio ID (marker, numeri, party)
const PLAYER_COLORS = ["#41a6f6", "#ef7d57", "#38b764", "#b55ed6", "#e43b44", "#14b8a6", "#f27ab3", "#eab308"];
function colorForId(id) {
    let h = 0;
    for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
}

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1 && !client.lobby) client.send(payload);
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
    const playersData = Object.values(players).filter(p => !p.lobby).map(p => ({
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

// ==================== PARTY ====================
// In memoria come lo stato del mondo. I membri sono identificati dal playerId pubblico,
// così chi si riconnette (nuova connessione = nuovo connectionId) resta nel suo party.

const PARTY_MAX = 4;
const INVITE_TTL = 60 * 1000;
const OFFLINE_GRACE = 2 * 60 * 1000;   // dopo questo tempo offline si esce dal party

const parties = new Map();     // partyId -> { id, leader, members: Map<playerId, { offlineSince }> }
const partyOf = new Map();     // playerId -> partyId
const invites = new Map();     // playerId invitato -> Map<playerId mittente, scadenza>
const lastKnown = new Map();   // playerId -> ultimo stato visto (per i membri offline)

const connOf = playerId => Object.values(players).find(p => p.playerId === playerId) || null;

function sendTo(playerId, data) {
    const p = connOf(playerId);
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(data));
}

const socialMsg = (p, message, error = false) =>
    p.ws.readyState === 1 && p.ws.send(JSON.stringify({ type: "social_info", message, error }));

const snapshotOf = p => ({ name: p.name, color: p.color, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, level: p.level });

function memberView(playerId) {
    const p = connOf(playerId);
    const s = p ? snapshotOf(p) : (lastKnown.get(playerId) || {});
    return {
        playerId,
        name: s.name || playerId.split("#")[0],
        color: s.color || "#38bdf8",
        x: s.x ?? 0,
        y: s.y ?? 0,
        hp: s.hp ?? null,
        maxHp: s.maxHp ?? null,
        level: s.level ?? null,
        online: !!p,
        inWorld: !!p && !p.lobby
    };
}

function syncParty(party) {
    const view = { id: party.id, leader: party.leader, max: PARTY_MAX, members: [...party.members.keys()].map(memberView) };
    for (const pid of party.members.keys()) sendTo(pid, { type: "party", party: view });
}

function leaveParty(playerId, reason = "left") {
    const party = parties.get(partyOf.get(playerId));
    partyOf.delete(playerId);
    sendTo(playerId, { type: "party", party: null, reason });
    if (!party) return;

    party.members.delete(playerId);

    // Un party con un solo membro non ha senso: si scioglie
    if (party.members.size <= 1) {
        for (const other of party.members.keys()) {
            partyOf.delete(other);
            sendTo(other, { type: "party", party: null, reason: "disbanded" });
        }
        parties.delete(party.id);
        return;
    }

    if (party.leader === playerId) party.leader = party.members.keys().next().value;
    syncParty(party);
}

function partyInvite(p, targetPid) {
    targetPid = String(targetPid ?? "").trim();
    if (!targetPid || targetPid === p.playerId) return socialMsg(p, "Giocatore non valido", true);

    const target = connOf(targetPid);
    if (!target) return socialMsg(p, `${targetPid} non è online`, true);
    if (partyOf.has(targetPid) && partyOf.get(targetPid) === partyOf.get(p.playerId)) {
        return socialMsg(p, `${target.name} è già nel tuo party`, true);
    }
    if (partyOf.has(targetPid)) return socialMsg(p, `${target.name} è già in un altro party`, true);

    const party = parties.get(partyOf.get(p.playerId));
    if (party && party.leader !== p.playerId) return socialMsg(p, "Solo il capo party può invitare", true);
    if (party && party.members.size >= PARTY_MAX) return socialMsg(p, "Il party è pieno", true);

    let pending = invites.get(targetPid);
    if (!pending) invites.set(targetPid, pending = new Map());
    pending.set(p.playerId, Date.now() + INVITE_TTL);

    sendTo(targetPid, { type: "party_invite", from: { playerId: p.playerId, name: p.name, color: p.color }, ttl: INVITE_TTL });
    socialMsg(p, `Invito inviato a ${target.name}`);
}

function partyAccept(p, fromPid) {
    const pending = invites.get(p.playerId);
    const expires = pending?.get(fromPid);
    pending?.delete(fromPid);
    if (!expires || expires < Date.now()) return socialMsg(p, "Invito scaduto", true);

    let party = parties.get(partyOf.get(fromPid));
    if (!party) {
        // Il party nasce al primo invito accettato
        if (!connOf(fromPid)) return socialMsg(p, "Chi ti ha invitato non è più online", true);
        party = { id: randomUUID(), leader: fromPid, members: new Map([[fromPid, { offlineSince: null }]]) };
        parties.set(party.id, party);
        partyOf.set(fromPid, party.id);
    }
    if (party.members.size >= PARTY_MAX) return socialMsg(p, "Il party è pieno", true);

    // Accettare un invito fa uscire dal party in cui si era
    if (partyOf.has(p.playerId)) leaveParty(p.playerId);

    party.members.set(p.playerId, { offlineSince: null });
    partyOf.set(p.playerId, party.id);
    invites.get(p.playerId)?.clear();
    syncParty(party);
}

function partyDecline(p, fromPid) {
    if (invites.get(p.playerId)?.delete(fromPid)) {
        const from = connOf(fromPid);
        if (from) socialMsg(from, `${p.name} ha rifiutato l'invito`, true);
    }
}

function partyKick(p, targetPid) {
    const party = parties.get(partyOf.get(p.playerId));
    if (!party || party.leader !== p.playerId) return socialMsg(p, "Solo il capo party può espellere", true);
    if (targetPid === p.playerId || !party.members.has(targetPid)) return;
    leaveParty(targetPid, "kicked");
}

// Membri offline da troppo tempo e inviti scaduti
setInterval(() => {
    const now = Date.now();
    for (const party of [...parties.values()]) {
        for (const [pid, m] of [...party.members]) {
            if (m.offlineSince && now - m.offlineSince > OFFLINE_GRACE) leaveParty(pid, "timeout");
        }
    }
    for (const [pid, pending] of invites) {
        for (const [from, exp] of pending) if (exp < now) pending.delete(from);
        if (!pending.size) invites.delete(pid);
    }
}, 15000);

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

    // Connessione dalla home (?lobby=1): online per amici e party, ma fuori dal mondo
    const lobby = new URL(req.url, "http://localhost").searchParams.get("lobby") === "1";
    ws.lobby = lobby;

    players[connectionId] = {
        ws,
        connectionId,
        playerId,
        authUserId: session.userId || null,
        isGuest: !!session.isGuest,
        x: 4,
        y: 4,
        name: displayName,
        color: colorForId(playerId),
        hp: null,
        maxHp: null,
        level: null,
        lobby
    };

    ws.send(JSON.stringify({
        type: "init",
        myId: connectionId,
        myPlayerId: playerId,
        myColor: players[connectionId].color,
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
            // Il colore lo decide il server (da playerId), uguale in gioco e in home
            p.name = session.userName || String(msg.name ?? "").trim().slice(0, 24) || "Guest";

            if (Number.isInteger(msg.x)) p.x = msg.x;
            if (Number.isInteger(msg.y)) p.y = msg.y;

            broadcastPlayers();

            // Rientro dopo una disconnessione: si torna nel proprio party
            const party = parties.get(partyOf.get(p.playerId));
            if (party) {
                party.members.get(p.playerId).offlineSince = null;
                syncParty(party);
            }
        }
        else if (msg.type === "stats") {
            const hp = Math.floor(Number(msg.hp));
            const maxHp = Math.floor(Number(msg.maxHp));
            const level = Math.floor(Number(msg.level));
            if (![hp, maxHp, level].every(Number.isFinite) || maxHp < 1 || maxHp > 1e6 || level < 1 || level > 1e4) return;

            p.hp = Math.max(0, Math.min(hp, maxHp));
            p.maxHp = maxHp;
            p.level = level;

            const party = parties.get(partyOf.get(p.playerId));
            if (party) syncParty(party);
        }
        else if (msg.type === "party_invite") {
            partyInvite(p, msg.playerId);
        }
        else if (msg.type === "party_accept") {
            partyAccept(p, String(msg.playerId ?? ""));
        }
        else if (msg.type === "party_decline") {
            partyDecline(p, String(msg.playerId ?? ""));
        }
        else if (msg.type === "party_leave") {
            leaveParty(p.playerId);
        }
        else if (msg.type === "party_kick") {
            partyKick(p, String(msg.playerId ?? ""));
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
        const p = players[connectionId];
        delete players[connectionId];
        broadcastPlayers();

        // Se lo stesso giocatore non è ancora connesso altrove, nel party risulta offline
        if (p && !connOf(p.playerId)) {
            lastKnown.set(p.playerId, snapshotOf(p));
            const party = parties.get(partyOf.get(p.playerId));
            if (party) {
                party.members.get(p.playerId).offlineSince = Date.now();
                syncParty(party);
            }
        }
    });
});

server.on("upgrade", (req, socket, head) => {
    sessionMiddleware(req, {}, () => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });
});

// Crea le voci mancanti dell'indice di ricerca per i giocatori registrati prima
// della sua introduzione (una lettura di playerIds all'avvio).
async function backfillSearchIndex() {
    try {
        const ids = (await db.ref("playerIds").get()).val() || {};
        const existing = (await db.ref("playerSearch").get()).val() || {};
        const updates = {};
        for (const [key, v] of Object.entries(ids)) {
            const playerId = idFromKey(key);
            if (v?.uid && !existing[searchKey(playerId)]) updates[searchKey(playerId)] = { uid: v.uid, playerId };
        }
        if (Object.keys(updates).length) {
            await db.ref("playerSearch").update(updates);
            console.log(`Indice ricerca: aggiunti ${Object.keys(updates).length} giocatori`);
        }
    } catch (err) {
        console.error("Errore indice ricerca giocatori:", err);
    }
}
backfillSearchIndex();

server.listen(3000, () => {
    console.log("Server attivo su http://localhost:3000");
});