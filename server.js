import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

// 1. Inizializza Firebase Admin SDK
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://infinite-doku-default-rtdb.europe-west1.firebasedatabase.app"
});
const database = getDatabase(); // Variabile corretta

const app = express();
// Middleware per parsare i JSON inviati via sendBeacon
app.use(express.json());

const PORT = 8080;
const server = app.listen(PORT, () => console.log(`Server Sudoku attivo su porta ${PORT}`));
const wss = new WebSocketServer({ server });

let worldState = { globalSolution: [], immortalMask: [], zones: {} };
let players = {};

// Helper di shuffling
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };

// Caricamento del mondo da Firebase
database.ref("worldState").get().then((snapshot) => {
    if (snapshot.exists()) {
        worldState = snapshot.val();
        if (!worldState.zones) worldState.zones = {};
        if (worldState.globalSolution) worldState.globalSolution = Object.values(worldState.globalSolution);
        if (worldState.immortalMask) worldState.immortalMask = Object.values(worldState.immortalMask);
        console.log("Mondo caricato da Firebase.");
    } else {
        console.log("Generazione nuovo mondo su Firebase...");
        const globalSolution = new Array(81);
        const immortalMask = new Array(81).fill(0);
        
        for(let i=0; i<81; i++) globalSolution[i] = (i % 9) + 1;
        
        const indices = [...Array(81).keys()];
        shuffle(indices);
        for (let i = 0; i < 38; i++) immortalMask[indices[i]] = 1;
        
        worldState = { globalSolution, immortalMask, zones: {} };
        database.ref("worldState").set(worldState);
        console.log("Nuovo mondo salvato su Firebase.");
    }
});

// Manda a tutti la lista aggiornata dei player online
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
    let myId = Math.random().toString(36).substr(2, 9);
    players[myId] = { id: myId, x: 4, y: 4, name: "Guest", color: "#38bdf8", ws };

    // Invia stato iniziale a chi si connette
    ws.send(JSON.stringify({ type: "init", world: worldState, myId }));

    ws.on("message", (message) => {
        const msg = JSON.parse(message);
        
        if (msg.type === "join") {
            players[myId].name = msg.name;
            players[myId].color = msg.color || "#38bdf8";
            broadcastPlayers();
        } 
        
        else if (msg.type === "move") {
            // Aggiorna posizione in tempo reale
            players[myId].x = msg.x;
            players[myId].y = msg.y;
            broadcastPlayers();
        } 
        
        else if (msg.type === "fetch_zone") {
            // Quando un player entra in una zona, gli inviamo i numeri scritti dagli altri in quella zona
            const zoneKey = msg.zoneKey;
            const zoneData = worldState.zones[zoneKey];
            if (zoneData && zoneData.writes) {
                ws.send(JSON.stringify({ type: "zone_writes", zoneKey: zoneKey, writes: zoneData.writes }));
            }
        } 
        
        else if (msg.type === "write") {
            const k = `${msg.cx},${msg.cy}`;
            if (!worldState.zones[msg.zoneKey]) worldState.zones[msg.zoneKey] = { writes: {} };
            
            const writeData = { val: msg.val, color: msg.color };
            worldState.zones[msg.zoneKey].writes[k] = writeData;

            // Salva su Firebase il singolo numero scritto (per il salvataggio mondiale)
            database.ref(`worldState/zones/${msg.zoneKey}/writes/${k}`).set(writeData);

            // Broadcast in tempo reale a TUTTI i player del numero appena scritto
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ 
                        type: "write", 
                        zoneKey: msg.zoneKey, 
                        cx: msg.cx, 
                        cy: msg.cy, 
                        val: msg.val, 
                        color: msg.color 
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
            .catch(err => res.status(500).send('Errore Salvataggio'));
    } else {
        res.status(400).send('Dati mancanti');
    }
});