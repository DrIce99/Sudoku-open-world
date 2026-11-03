import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { auth, db, getPlayerData, updatePlayerData, serverTimestamp, increment } from "./firebase.js";
import { WORLD_SEED, isPlayableZone, solutionAtCell, revealedMask } from "./worldgen.js";
import { createBossSystem } from "./bossServer.js";
import { createAbilitySystem } from "./abilities.js";
import { CLASS_CATALOG, PULL_COST, TEN_PULL_COST, variantKey, findVariant, levelFromCopies, rollPull } from "./classes.js";

// Disattiva la verifica dei certificati HTTPS di tutto il server: solo in locale, mai in
// produzione (NODE_ENV=production)
if (process.env.NODE_ENV !== "production") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "sudoku_secret_key_change_me",
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
    // Collezione e tempi delle classi hanno la loro API (/api/classes)
    delete clean.collection;
    delete clean.classTime;
    clean.wallet = { currency: Math.max(0, Math.floor(Number(clean.wallet?.currency) || 0)) };
    clean.bonus = { atk: Number(clean.bonus?.atk) || 0, hp: Number(clean.bonus?.hp) || 0 };

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

// Patch notes e storico dei bilanciamenti (pagina pubblica)
app.get("/version", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "version.html"));
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
            await updateGeneralLeaderboard(req, update);
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
            await updateGeneralLeaderboard(req, update);
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

// ==================== CLASSIFICHE ====================
// Ogni classifica ha un suo nodo, aggiornato quando cambiano i dati che la riguardano:
//   leaderboard/general/<uid>  = { playerId, username, level, xp, completedSudokus, placedNumbers }
//                                (aggiornata dai salvataggi del client)
//   leaderboard/fighters/<uid> = { playerId, username, bossKills, trialWins, arenaNumbers }
//                                (aggiornata solo dal server, a fine scontro con un boss)
// Il nodo viene letto per intero e ordinato qui, con una cache: non servono indici.

const LEADERBOARD_TOP = 50;
const LEADERBOARD_CACHE_MS = 30000;

const LEADERBOARDS = {
    general: {
        compare: (a, b) => (b.level || 1) - (a.level || 1) || (b.xp || 0) - (a.xp || 0)
    },
    fighters: {
        wins: e => (e.bossKills || 0) + (e.trialWins || 0),
        compare: (a, b) => LEADERBOARDS.fighters.wins(b) - LEADERBOARDS.fighters.wins(a) || (b.arenaNumbers || 0) - (a.arenaNumbers || 0)
    }
};
const leaderboardCache = new Map();   // tipo -> { at, ranked }

async function rankedLeaderboard(type) {
    const cached = leaderboardCache.get(type);
    if (cached && Date.now() - cached.at < LEADERBOARD_CACHE_MS) return cached.ranked;

    const all = (await db.ref(`leaderboard/${type}`).get()).val() || {};
    const ranked = Object.entries(all)
        .map(([uid, e]) => ({ uid, ...e }))
        .filter(e => e.playerId)
        .sort(LEADERBOARDS[type].compare)
        .map((e, i) => ({ ...e, rank: i + 1 }));
    leaderboardCache.set(type, { at: Date.now(), ranked });
    return ranked;
}

async function updateGeneralLeaderboard(req, update) {
    if (!req.session.playerId) return;
    const entry = { playerId: req.session.playerId, username: req.session.userName || req.session.playerId.split("#")[0] };
    for (const k of ["level", "xp"]) if (k in update) entry[k] = update[k];
    if ("stats/completedSudokus" in update) entry.completedSudokus = update["stats/completedSudokus"];
    if ("stats/placedNumbers" in update) entry.placedNumbers = update["stats/placedNumbers"];
    await db.ref(`leaderboard/general/${req.session.userId}`).update(entry);
}

app.get("/api/leaderboard", requireAuth, api(async (req) => {
    const type = LEADERBOARDS[req.query.type] ? req.query.type : "general";
    const ranked = await rankedLeaderboard(type);
    const strip = ({ uid, ...e }) => e;
    const mine = req.session.isGuest ? null : ranked.find(e => e.uid === req.session.userId);
    return {
        type,
        entries: ranked.slice(0, LEADERBOARD_TOP).map(e => ({ ...strip(e), me: e.uid === req.session.userId })),
        me: mine ? strip(mine) : null,
        total: ranked.length
    };
}));

// uid di un giocatore dal suo ID pubblico (null per gli ospiti o ID sconosciuti)
async function uidForPlayerId(playerId) {
    const conn = Object.values(players).find(p => p.playerId === playerId && p.authUserId);
    if (conn) return conn.authUserId;
    if (!playerId.includes("#") || playerId.startsWith("Guest#")) return null;
    const snap = await db.ref(`playerIds/${idKey(playerId)}`).get();
    return snap.exists() ? snap.val().uid : null;
}

// ==================== BONUS DI SCONFITTA ====================
// Alla vittoria un bonus fisso viene diviso in parti uguali fra chi ha contribuito
// (numeri scritti nell'arena, danni o congelamento con le abilità) e si aggiunge a una
// statistica permanente: users/<uid>/bonus/atk dai boss, users/<uid>/bonus/hp dalle
// Survival Trial. L'ATK bonus potenzia le abilità (abilities.js), l'HP bonus la vita massima.
const DEFEAT_BONUS = {
    sudoku_hp: { field: "atk", pool: 4 },
    survival_trial: { field: "hp", pool: 20 }
};
const round2 = n => Math.round(n * 100) / 100;

async function loadBonus(p) {
    if (!p.authUserId) return;
    const b = (await db.ref(`users/${p.authUserId}/bonus`).get()).val() || {};
    p.bonus = { atk: Number(b.atk) || 0, hp: Number(b.hp) || 0 };
    sendJson(p, { type: "bonus", ...p.bonus });
}

async function awardDefeatBonus(type, contributors) {
    const cfg = DEFEAT_BONUS[type];
    if (!cfg || !contributors.length) return {};
    const share = round2(cfg.pool / contributors.length);
    const updates = {};
    for (const pid of contributors) {
        const uid = await uidForPlayerId(pid);
        if (!uid) continue;
        updates[`users/${uid}/bonus/${cfg.field}`] = increment(share);
        // chi è connesso lo vede subito
        for (const p of Object.values(players)) {
            if (p.authUserId !== uid) continue;
            p.bonus ??= { atk: 0, hp: 0 };
            p.bonus[cfg.field] = round2(p.bonus[cfg.field] + share);
            sendJson(p, { type: "bonus", ...p.bonus, gained: { field: cfg.field, amount: share, split: contributors.length } });
        }
    }
    return updates;
}

// Esito di uno scontro: aggiorna statistiche e classifica fighters dei partecipanti
// e divide il bonus di sconfitta fra i contributori
async function recordBossOutcome({ type, result, participants, contributors = [], arenaNumbers }) {
    const updates = result === "defeated" ? await awardDefeatBonus(type, contributors) : {};
    const winField = type === "survival_trial" ? "trialWins" : "bossKills";

    for (const pid of new Set([...participants, ...arenaNumbers.keys()])) {
        const uid = await uidForPlayerId(pid);
        if (!uid) continue;
        const lb = `leaderboard/fighters/${uid}`;
        const numbers = arenaNumbers.get(pid) || 0;

        if (result === "defeated") {
            updates[`users/${uid}/stats/${winField}`] = increment(1);
            updates[`${lb}/${winField}`] = increment(1);
        }
        if (numbers) {
            updates[`users/${uid}/stats/arenaNumbers`] = increment(numbers);
            updates[`${lb}/arenaNumbers`] = increment(numbers);
        }
        if (result === "defeated" || numbers) {
            const username = Object.values(players).find(p => p.playerId === pid)?.name ||
                (await db.ref(`users/${uid}/username`).get()).val() || pid.split("#")[0];
            updates[`${lb}/playerId`] = pid;
            updates[`${lb}/username`] = username;
        }
    }

    if (Object.keys(updates).length) {
        await db.ref().update(updates);
        leaderboardCache.delete("fighters");
    }
}

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
// Stessa logica deterministica del client (worldgen.js <-> game.js): a parità di seed,
// client e server calcolano indipendentemente la stessa soluzione sudoku, quindi non serve
// trasmettere il mondo intero — solo le celle scritte dai giocatori vengono salvate qui.

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

// claimed: maschera a 9 bit delle celle che hanno già dato la ricompensa (XP e Frammenti).
// Un numero cancellato da un boss e riscritto non viene premiato una seconda volta.
function zoneState(key) {
    return worldState.zones[key] ??= { writes: {}, disc: false, claimed: 0 };
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

const bossSystem = createBossSystem({
    zoneState,
    worldPlayers: () => Object.values(players).filter(p => !p.lobby),
    broadcast,
    onFinished: outcome => recordBossOutcome(outcome).catch(err => console.error("Errore statistiche boss:", err)),
    strikeMods: b => abilities.strikeMods(b),
    onStrike: (b, cells) => abilities.onStrike(b, cells)
});

// Compagni di party connessi nel mondo (compreso p); senza party solo p
function partyMates(p) {
    const party = parties.get(partyOf.get(p.playerId));
    if (!party) return [p];
    return [...party.members.keys()].map(connOf).filter(q => q && !q.lobby);
}

const abilities = createAbilitySystem({
    players, bossSystem, zoneState, broadcast, sendJson, partyMates,
    // definite più avanti (sezione POSIZIONI): passate tramite funzioni
    forceMove: (...a) => forceMove(...a),
    occupantAt: (...a) => occupantAt(...a),
    nearestFree: (...a) => nearestFree(...a),
    broadcastPlayers: () => broadcastPlayers()
});

// ==================== TEMPO DI GIOCO ====================
// Secondi passati nel mondo (non in home), salvati alla disconnessione e ogni 5 minuti.
// Base per le future statistiche d'uso delle classi.

function flushPlayTime(p) {
    if (!p.authUserId || p.lobby || !p.playSince) return;
    const now = Date.now();
    const secs = Math.floor((now - p.playSince) / 1000);
    if (secs < 1) return;
    p.playSince += secs * 1000;
    const update = { [`users/${p.authUserId}/stats/playTimeSec`]: increment(secs) };
    // Tempo con la classe scelta: per giocatore e totale (per vedere il meta e bilanciare)
    if (p.selectedClass) {
        const key = variantKey(p.selectedClass.classId, p.selectedClass.variant);
        update[`users/${p.authUserId}/classTime/${key}`] = increment(secs);
        update[`classUsage/${key}/timeSec`] = increment(secs);
    }
    db.ref().update(update).catch(err => console.error("Errore tempo di gioco:", err));
}

setInterval(() => Object.values(players).forEach(flushPlayTime), 5 * 60 * 1000);

// ==================== FRAMMENTI (valuta), CLASSI E GACHA ====================
// I Frammenti si guadagnano scrivendo numeri nuovi (vedi "claimed"). Il saldo è in
// users/<uid>/wallet/currency; quanto guadagnato in gioco viene salvato a blocchi.
// Tutte le operazioni sul saldo di un utente passano da withWallet(), una alla volta,
// così una tirata e un salvataggio contemporanei non si sovrascrivono.
//   users/<uid>/collection/<classe><variante> = copie trovate (es. "2b": 3)
//   users/<uid>/selectedClass = { classId, variant }

const CURRENCY_PER_NUMBER = 1;

// Modalità di test (node server.js --all-classes, oppure npm run test-classes):
// tutte le varianti risultano sbloccate (almeno 1 copia) senza scrivere nel database
const ALL_CLASSES = process.argv.includes("--all-classes");
if (ALL_CLASSES) console.log("Modalità test: tutte le classi sono sbloccate");
const ownedCopies = copies => ALL_CLASSES ? Math.max(1, copies || 0) : (copies || 0);
const walletLocks = new Map();

function withWallet(uid, fn) {
    const prev = walletLocks.get(uid) || Promise.resolve();
    const next = prev.catch(() => { }).then(fn);
    walletLocks.set(uid, next);
    next.finally(() => { if (walletLocks.get(uid) === next) walletLocks.delete(uid); }).catch(() => { });
    return next;
}

const walletRef = uid => db.ref(`users/${uid}/wallet/currency`);
const sendWallet = (p, gained = 0) => p.currency != null && sendJson(p, { type: "wallet", currency: p.currency, gained });

function flushCurrency(p) {
    if (!p.authUserId || !p.pendingCurrency) return Promise.resolve();
    const amount = p.pendingCurrency;
    p.pendingCurrency = 0;
    return withWallet(p.authUserId, async () => {
        const cur = (await walletRef(p.authUserId).get()).val() || 0;
        await walletRef(p.authUserId).set(cur + amount);
    }).catch(err => {
        p.pendingCurrency += amount;   // riprova al prossimo salvataggio
        console.error("Errore salvataggio Frammenti:", err);
    });
}

setInterval(() => Object.values(players).forEach(flushCurrency), 10000);

async function loadWallet(p) {
    if (!p.authUserId) return;
    try {
        const [cur, sel] = await Promise.all([
            walletRef(p.authUserId).get(),
            db.ref(`users/${p.authUserId}/selectedClass`).get()
        ]);
        p.currency = (cur.val() || 0) + p.pendingCurrency;
        const s = sel.val();
        p.selectedClass = s && findVariant(s.classId, s.variant) ? { classId: s.classId, variant: s.variant } : null;
        sendWallet(p);
        await loadBonus(p);
        abilities.setClass(p, p.selectedClass ? { ...p.selectedClass, level: await variantLevel(p.authUserId, p.selectedClass) } : null);
    } catch (err) {
        console.error("Errore caricamento Frammenti:", err);
    }
}

function awardCurrency(p, amount, note = null) {
    if (!p.authUserId) return;
    p.pendingCurrency += amount;
    if (p.currency != null) p.currency += amount;
    if (p.currency != null) sendJson(p, { type: "wallet", currency: p.currency, gained: amount, note });
}

// Righe, colonne e 3x3 completati danno Frammenti extra, un sudoku 9x9 intero ancora di più.
// Come nel client, righe e colonne sono quelle di un qualsiasi sudoku 9x9 (allineato ai
// blocchi 3x3) che contiene la cella, senza muri; nel sudoku le zone vuote non contano.
// Ogni unità premia una volta sola (chi la completa): dopo un attacco dei boss non si rifarma.
const UNIT_CURRENCY = 2, SUDOKU_CURRENCY = 10;
const rewardedUnits = new Set();

function newlyCompletedUnits(gx, gy) {
    const zx = Math.floor(gx / 3), zy = Math.floor(gy / 3);
    const done = { units: [], sudokus: 0 };
    const complete = cells => cells.every(([x, y]) => isPlayableZone(Math.floor(x / 3), Math.floor(y / 3)) && bossSystem.cellFilled(x, y));
    const check = (key, kind, cells) => {
        if (rewardedUnits.has(key) || !complete(cells)) return;
        rewardedUnits.add(key);
        if (kind === "sudoku") done.sudokus++;
        else done.units.push(kind);
    };
    const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);

    check(`box|${zx},${zy}`, "3x3", range(0, 9).map(i => [zx * 3 + i % 3, zy * 3 + Math.floor(i / 3)]));
    for (let s = zx - 2; s <= zx; s++) check(`row|${s * 3},${gy}`, "riga", range(s * 3, 9).map(x => [x, gy]));
    for (let s = zy - 2; s <= zy; s++) check(`col|${gx},${s * 3}`, "colonna", range(s * 3, 9).map(y => [gx, y]));
    for (let sy = zy - 2; sy <= zy; sy++) for (let sx = zx - 2; sx <= zx; sx++) {
        const cells = [];
        for (let y = sy * 3; y < sy * 3 + 9; y++) for (let x = sx * 3; x < sx * 3 + 9; x++)
            if (isPlayableZone(Math.floor(x / 3), Math.floor(y / 3))) cells.push([x, y]);
        check(`win|${sx + 1},${sy + 1}`, "sudoku", cells);
    }
    return done;
}

async function variantLevel(uid, { classId, variant }) {
    const copies = (await db.ref(`users/${uid}/collection/${variantKey(classId, variant)}`).get()).val() || 0;
    return levelFromCopies(ownedCopies(copies)).level;
}

// Salva i Frammenti in sospeso di tutte le connessioni di un utente (prima di una tirata)
const flushUser = uid => Promise.all(Object.values(players).filter(p => p.authUserId === uid).map(flushCurrency));

function collectionView(collection) {
    const classes = CLASS_CATALOG.map(cls => {
        const variants = cls.variants.map(v => {
            const copies = ownedCopies(collection[variantKey(cls.id, v.id)]);
            return { ...v, copies, ...levelFromCopies(copies) };
        });
        const copies = variants.reduce((n, v) => n + v.copies, 0);
        return { ...cls, variants, copies, ...levelFromCopies(copies) };
    });
    return classes;
}

app.get("/api/classes", requireAccount, api(async (req) => {
    const uid = req.session.userId;
    await flushUser(uid);
    const [col, sel, cur] = await Promise.all([
        db.ref(`users/${uid}/collection`).get(),
        db.ref(`users/${uid}/selectedClass`).get(),
        walletRef(uid).get()
    ]);
    return {
        classes: collectionView(col.val() || {}),
        selected: sel.val() || null,
        currency: cur.val() || 0,
        pullCost: PULL_COST,
        tenPullCost: TEN_PULL_COST
    };
}));

app.post("/api/gacha/pull", requireAccount, api(async (req) => {
    const uid = req.session.userId;
    const count = Number(req.body?.count) === 10 ? 10 : 1;
    const cost = count === 10 ? TEN_PULL_COST : PULL_COST;

    await flushUser(uid);
    return withWallet(uid, async () => {
        const balance = (await walletRef(uid).get()).val() || 0;
        if (balance < cost) throw new ApiError(400, `Frammenti insufficienti: ne servono ${cost}, ne hai ${balance}`);

        const before = (await db.ref(`users/${uid}/collection`).get()).val() || {};
        const after = { ...before };
        const results = [];
        for (let i = 0; i < count; i++) {
            const { classId, variant } = rollPull();
            const key = variantKey(classId, variant);
            const classCopies = c => CLASS_CATALOG.find(x => x.id === classId).variants
                .reduce((n, v) => n + (c[variantKey(classId, v.id)] || 0), 0);

            const prevV = levelFromCopies(after[key] || 0).level;
            const prevC = levelFromCopies(classCopies(after)).level;
            after[key] = (after[key] || 0) + 1;
            const nowV = levelFromCopies(after[key]);
            const nowC = levelFromCopies(classCopies(after));
            results.push({
                classId, variant,
                isNew: prevV === 0,
                newClass: prevC === 0,
                level: nowV.level, levelUp: prevV > 0 && nowV.level > prevV,
                classLevel: nowC.level, classLevelUp: prevC > 0 && nowC.level > prevC,
                copies: after[key]
            });
        }

        const update = { [`users/${uid}/wallet/currency`]: balance - cost };
        for (const [key, copies] of Object.entries(after)) {
            if (copies !== before[key]) update[`users/${uid}/collection/${key}`] = copies;
        }
        await db.ref().update(update);

        // il saldo mostrato in gioco (se connesso) si aggiorna subito
        for (const p of Object.values(players)) {
            if (p.authUserId === uid && p.currency != null) {
                p.currency = balance - cost + p.pendingCurrency;
                sendWallet(p);
            }
        }
        return { results, currency: balance - cost };
    });
}));

app.post("/api/classes/select", requireAccount, api(async (req) => {
    const uid = req.session.userId;
    const classId = Number(req.body?.classId);
    const variant = String(req.body?.variant ?? "");
    const found = findVariant(classId, variant);
    if (!found) throw new ApiError(400, "Classe non valida");

    const copies = ownedCopies((await db.ref(`users/${uid}/collection/${variantKey(classId, variant)}`).get()).val());
    if (!copies) throw new ApiError(403, "Non hai ancora sbloccato questa variante");

    await db.ref(`users/${uid}/selectedClass`).set({ classId, variant });
    // il tempo passato finora va alla classe precedente
    const level = levelFromCopies(copies).level;
    for (const p of Object.values(players)) {
        if (p.authUserId !== uid) continue;
        flushPlayTime(p);
        p.selectedClass = { classId, variant };
        if (!p.lobby) abilities.setClass(p, { classId, variant, level });
    }
    return { selected: { classId, variant }, message: `Classe scelta: ${found.cls.name} · ${found.v.name}` };
}));

// ==================== POSIZIONI: UN SOLO GIOCATORE PER CELLA ====================
// Il server decide le posizioni. Un passo verso una cella occupata spinge l'altro
// giocatore nella stessa direzione; se non si può spingere, il passo viene annullato.
// Un teletrasporto (respawn, posizione salvata, party) su una cella occupata finisce
// sulla cella libera più vicina. Ai client arrivano:
//   forced_move  { x, y, reason: "push" | "occupied" | "party", by }  -> la tua nuova posizione
//   move_rejected { x, y }                                            -> passo annullato
//   pushed_other { name }                                             -> hai spinto qualcuno

const occupantAt = (x, y, except) =>
    Object.values(players).find(o => o !== except && !o.lobby && o.x === x && o.y === y) || null;

const isPlayableCell = (x, y) => isPlayableZone(Math.floor(x / 3), Math.floor(y / 3));

function sendJson(p, data) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(data));
}

// Cella libera più vicina a (x, y): prima le celle vuote (senza numero), poi le altre.
// Con `arena` la ricerca resta dentro l'arena di quel boss (o fuori da tutte, se null).
function nearestFree(x, y, who, arena = undefined) {
    let fallback = null;
    for (let r = 0; r <= 6; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const cx = x + dx, cy = y + dy;
                if (!isPlayableCell(cx, cy) || occupantAt(cx, cy, who)) continue;
                if (arena !== undefined && bossSystem.arenaAt(cx, cy) !== arena) continue;
                if (!bossSystem.cellFilled(cx, cy)) return { x: cx, y: cy };
                fallback ??= { x: cx, y: cy };
            }
        }
        if (fallback) return fallback;
    }
    return { x, y };
}

// Sposta un giocatore d'ufficio e glielo comunica
function forceMove(p, x, y, reason, by = null) {
    p.x = x;
    p.y = y;
    sendJson(p, { type: "forced_move", x, y, reason, by });
}

// Teletrasporto: se la destinazione è occupata si va sulla cella libera più vicina
function placeAt(p, x, y, reason = "occupied") {
    if (!occupantAt(x, y, p)) {
        p.x = x;
        p.y = y;
        return false;
    }
    const free = nearestFree(x, y, p);
    forceMove(p, free.x, free.y, reason);
    return true;
}

function handleMove(p, x, y) {
    const other = occupantAt(x, y, p);
    const dx = x - p.x, dy = y - p.y;

    if (!other) {
        p.x = x;
        p.y = y;
        abilities.onMoved(p);   // portali della classe 4
    } else if (Math.abs(dx) + Math.abs(dy) === 1) {
        // Spinta: l'altro avanza di una cella nella stessa direzione, senza uscire
        // dall'arena del boss in cui si trova (né entrarci da fuori)
        const tx = other.x + dx, ty = other.y + dy;
        const ok = isPlayableCell(tx, ty) && !occupantAt(tx, ty, other) &&
            bossSystem.arenaAt(tx, ty) === bossSystem.arenaAt(other.x, other.y);
        if (!ok) return sendJson(p, { type: "move_rejected", x: p.x, y: p.y });

        forceMove(other, tx, ty, "push", p.name);
        p.x = x;
        p.y = y;
        sendJson(p, { type: "pushed_other", name: other.name });
    } else {
        placeAt(p, x, y);
    }
    broadcastPlayers();
}

// Teletrasporto accanto a un compagno (invito al party accettato)
function teleportNextTo(p, host) {
    if (p.lobby || host.lobby) return false;
    const spot = nearestFree(host.x, host.y, p, bossSystem.arenaAt(host.x, host.y));
    if (spot.x === host.x && spot.y === host.y) return false;
    forceMove(p, spot.x, spot.y, "party", host.name);
    broadcastPlayers();
    return true;
}

// Chi accetta un invito dalla home viene teletrasportato appena entra nel mondo
const pendingTeleport = new Map();   // playerId -> playerId dell'host

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

    // L'invitato raggiunge chi l'ha invitato (subito, o appena entra nel mondo)
    const host = connOf(fromPid);
    if (host && !host.lobby && p.lobby) pendingTeleport.set(p.playerId, fromPid);
    else if (host) teleportNextTo(p, host);
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
        lobby,
        playSince: lobby ? null : Date.now(),
        currency: null,          // saldo Frammenti noto (caricato all'ingresso)
        pendingCurrency: 0,      // guadagnati ma non ancora salvati
        selectedClass: null
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

            if (!p.lobby && Number.isInteger(msg.x) && Number.isInteger(msg.y)) placeAt(p, msg.x, msg.y);

            // Invito al party accettato dalla home: si parte accanto all'host
            const hostPid = pendingTeleport.get(p.playerId);
            if (!p.lobby && hostPid) {
                pendingTeleport.delete(p.playerId);
                const host = connOf(hostPid);
                if (host && partyOf.get(hostPid) && partyOf.get(hostPid) === partyOf.get(p.playerId)) teleportNextTo(p, host);
            }

            broadcastPlayers();
            if (!p.lobby) ws.send(JSON.stringify(bossSystem.snapshot()));
            if (!p.lobby) loadWallet(p);
            if (!p.lobby) sendJson(p, abilities.portalsSnapshot());

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

            const levelChanged = p.level !== level;
            p.hp = Math.max(0, Math.min(hp, maxHp));
            p.maxHp = maxHp;
            p.level = level;
            if (levelChanged && !p.lobby) abilities.sendState(p);

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
        else if (msg.type === "view") {
            // sudoku 9x9 attivo del client (indizi della Rigenerazione, classe 5)
            if (Number.isInteger(msg.zx) && Number.isInteger(msg.zy)) p.view = { zx: msg.zx, zy: msg.zy };
        }
        else if (msg.type === "move") {
            if (p.lobby || !Number.isInteger(msg.x) || !Number.isInteger(msg.y)) return;
            handleMove(p, msg.x, msg.y);
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
                writes: zone.writes,
                claimed: zone.claimed || 0
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
            const gx = zk.zx * 3 + cx, gy = zk.zy * 3 + cy;

            // Solo il numero corretto, mai sopra un numero iniziale o uno già scritto:
            // un client modificato non può sporcare il mondo condiviso. Le cancellazioni
            // (attacchi dei boss) le decide solo il server.
            if (val !== solutionAtCell(gx, gy)) return;
            if (revealedMask(zk.zx, zk.zy) & (1 << (cy * 3 + cx))) return;
            if (zone.writes[writeKey]) return;
            zone.writes[writeKey] = { val, color, by: p.playerId };

            // Ricompensa solo alla prima scrittura della cella (niente farming dopo gli attacchi dei boss)
            const bit = 1 << (cy * 3 + cx);
            const fresh = !(zone.claimed & bit);
            zone.claimed |= bit;
            const { units, sudokus } = newlyCompletedUnits(gx, gy);
            const gained = (fresh ? CURRENCY_PER_NUMBER : 0) + units.length * UNIT_CURRENCY + sudokus * SUDOKU_CURRENCY;
            const note = [...units, ...(sudokus ? ["sudoku"] : [])].join(" + ") || null;
            if (gained) awardCurrency(p, gained, note);

            // Le coordinate globali vengono ricavate dal client a partire da zona e cella locale.
            broadcast({ type: "write", zoneKey: zk.key, cx, cy, val, color, by: p.playerId });
            bossSystem.onWrite(gx, gy, p);
            abilities.onWrite(p, gx, gy, val);
        }
        else if (msg.type === "ability") {
            if (!p.lobby) abilities.use(p, msg.target);
        }
        else if (msg.type === "player_hit") {
            const dmg = Number(msg.dmg);
            if (!p.lobby && Number.isFinite(dmg) && dmg > 0 && dmg < 1e5) abilities.onPlayerHit(p, dmg);
        }
        else if (msg.type === "player_died") {
            if (Number.isInteger(msg.x) && Number.isInteger(msg.y)) bossSystem.onPlayerDied(p, msg.x, msg.y);
        }
    });

    // Senza un listener, un errore del socket farebbe crashare il processo.
    ws.on("error", err => console.warn("Errore WebSocket:", err.message));

    ws.on("close", () => {
        const p = players[connectionId];
        if (p) {
            flushPlayTime(p);
            flushCurrency(p);
        }
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

async function backfillGeneralLeaderboard() {
    try {
        const existing = (await db.ref("leaderboard/general").get()).val() || {};
        const users = (await db.ref("users").get()).val() || {};
        const updates = {};
        for (const [uid, u] of Object.entries(users)) {
            if (existing[uid] || !u?.playerId || !u.username) continue;
            updates[uid] = {
                playerId: u.playerId, username: u.username,
                level: u.level || 1, xp: u.xp || 0,
                completedSudokus: u.stats?.completedSudokus || 0,
                placedNumbers: u.stats?.placedNumbers || 0
            };
        }
        if (Object.keys(updates).length) {
            await db.ref("leaderboard/general").update(updates);
            console.log(`Classifica generale: aggiunti ${Object.keys(updates).length} giocatori`);
        }
    } catch (err) {
        console.error("Errore classifica generale:", err);
    }
}
backfillGeneralLeaderboard();

// La piattaforma di hosting (Render, Railway, Fly.io...) indica la porta in PORT
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo su http://localhost:${PORT}`);
});