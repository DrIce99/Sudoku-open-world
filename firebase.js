import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";

// Carica il file di credenziali serviceAccountKey.json
const serviceAccount = JSON.parse(
    readFileSync(new URL("./serviceAccountKey.json", import.meta.url))
);

initializeApp({
    credential: cert(serviceAccount)
});

export const db = getFirestore();
export const auth = getAuth();

// Helper per ottenere i dati del giocatore
export async function getPlayerData(userId) {
    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get();
    
    if (doc.exists) {
        return doc.data();
    }
    
    // Dati di default per un nuovo giocatore
    const defaultData = {
        name: "",
        username: null,
        created_at: FieldValue.serverTimestamp(),
        stats: {
            completedSudokus: 0,
            placedNumbers: 0,
            wrongPlacements: 0
        },
        inventory: [],
        currentPosition: { x: 0, y: 0 }
    };
    
    await userRef.set(defaultData);
    return defaultData;
}