import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase, ServerValue } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";

// Carica il file di credenziali serviceAccountKey.json
const serviceAccount = JSON.parse(
    readFileSync(new URL("./serviceAccountKey.json", import.meta.url))
);

initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://infinite-doku-default-rtdb.europe-west1.firebasedatabase.app"
});

export const db = getDatabase();
export const auth = getAuth();
export const serverTimestamp = () => ServerValue.TIMESTAMP;

const userRef = (userId) => db.ref(`users/${userId}`);

// Il Realtime Database non salva null, oggetti e array vuoti: i campi mancanti
// vengono quindi riportati ai valori di default alla lettura.
function withDefaults(data) {
    return {
        name: "",
        username: null,       // nickname scelto dall'utente, non modificabile
        playerId: null,       // ID pubblico unico, tipo "Mario#4821"
        level: 1,
        xp: 0,
        inventory: [],
        currentPosition: { x: 0, y: 0 },
        ...data,
        stats: {
            completedSudokus: 0,
            placedNumbers: 0,
            wrongPlacements: 0,
            ...data?.stats
        }
    };
}

// Legge i dati del giocatore; se non esistono li crea con i valori di default.
export async function getPlayerData(userId) {
    const snap = await userRef(userId).get();

    if (snap.exists()) {
        return withDefaults(snap.val());
    }

    const defaultData = withDefaults({});
    await userRef(userId).set({ ...defaultData, created_at: serverTimestamp() });
    return defaultData;
}

// Aggiorna alcuni campi del giocatore. Le chiavi possono essere percorsi ("stats/placedNumbers").
export function updatePlayerData(userId, patch) {
    return userRef(userId).update(patch);
}
