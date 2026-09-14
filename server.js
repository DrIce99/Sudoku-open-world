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

app.get("/api/player", requireAuth, async (req, res) => {
    try {
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

// ==================== WEBSOCKET GAME ENGINE ====================

const worldState = { zones: {} };

wss.on("connection", (ws, req) => {
    // Autenticazione della socket opzionale tramite sessione
    console.log("Giocatore connesso alla WebSocket");

    ws.on("message", (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.type === "write") {
                const { zoneKey, cx, cy, writeData } = msg;

                // FIX DEL TYPERROR: Inizializzazione sicura della struttura di zona
                if (!worldState.zones[zoneKey]) {
                    worldState.zones[zoneKey] = { writes: {}, disc: false };
                }
                if (!worldState.zones[zoneKey].writes) {
                    worldState.zones[zoneKey].writes = {};
                }

                // Assegnazione sicura
                worldState.zones[zoneKey].writes[`${cx},${cy}`] = writeData;

                // Broadcast agli altri giocatori
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === ws.OPEN) {
                        client.send(JSON.stringify({
                            type: "update",
                            zoneKey,
                            cx,
                            cy,
                            writeData
                        }));
                    }
                });
            }
        } catch (e) {
            console.error("Errore processamento messaggio WS:", e);
        }
    });
});

server.listen(3000, () => {
    console.log("Server attivo su http://localhost:3000");
});