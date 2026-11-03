/* ============================================================
   PATCH NOTES — storico delle versioni (ricostruito dalla history git,
   commit raggruppati per funzionalità). La prima voce è la versione
   corrente: la usano il bottone in home e la pagina /version.
   Per una nuova versione basta aggiungere una voce in cima.
   ============================================================ */
window.CHANGE_TYPES = {
    feature: "Nuove funzionalità",
    logic: "Modifiche di logica e bilanciamento",
    rework: "Rework",
    fix: "Fix"
};

window.CHANGELOG = [
    {
        version: "0.8.1",
        date: "2026-11-03",
        title: "Portale e storico dei bilanciamenti",
        changes: {
            feature: [
                "Pagina delle patch notes con lo storico dei bilanciamenti: valori prima/dopo, barre a confronto e filtri per variante",
                "Bottone della versione in home, con l'avviso NEW quando escono patch nuove",
                "Impostazioni: movimento Retro (a scatti, 30 fps) o Fluido per il tema Pixel"
            ],
            logic: [
                "Portale (4b): un portale aperto in più a ogni livello della variante"
            ],
            fix: [
                "I numeri scritti nel mondo sparivano quando il server si riavviava: ora sono salvati nel database",
                "Le soluzioni del mondo avevano le righe sempre in ordine (1-9 ruotato): ora righe, colonne e cifre sono mescolate dal seed (il mondo è stato rigenerato)"
            ]
        }
    },
    {
        version: "0.8.0",
        date: "2026-11-03",
        title: "Temi e livelli delle classi",
        changes: {
            feature: [
                "Impostazioni (home e gioco) con la scelta del tema: Pixel o Classico, lo stile di prima del pixel art",
                "Tema Classico: effetti speciali morbidi e sfumati, stessi momenti del tema Pixel",
                "Collezione: ogni variante dice cosa migliora a ogni livello"
            ],
            logic: [
                "Tutte le varianti crescono con il livello (tranne il Passo libero): raggio, ricariche, durate, portali, protezione e potenziamento"
            ]
        }
    },
    {
        version: "0.7.0",
        date: "2026-11-02",
        title: "Classi sistemate e Frammenti extra",
        changes: {
            feature: [
                "Lo scudo della classe 9 è visibile nella barra della vita, in azzurro",
                "Modalità di test del server con tutte le classi sbloccate (npm run test-classes)",
                "Pronto per hosting con server sempre acceso (Render): credenziali e porta dalle variabili d'ambiente"
            ],
            logic: [
                "Frammenti extra completando righe, colonne, 3x3 e sudoku interi",
                "Rigenerazione (5a): indizi più rari e solo nel sudoku attivo",
                "Salto (4a): si salta su qualsiasi 4"
            ],
            rework: [
                "Tank: si cammina sui 3; l'Aura protegge anche i numeri del suo 3x3"
            ],
            fix: [
                "L'Aura del Tank non riduceva i danni: si attivava solo restando sul 3 appena scritto",
                "Nei portali si entra camminando con le frecce (prima solo col tasto 4)",
                "Saltando fuori dalla vista bloccata con R si restava bloccati",
                "Rimossa la disattivazione dei certificati HTTPS in produzione"
            ]
        }
    },
    {
        version: "0.6.0",
        date: "2026-11-02",
        title: "Classi e gacha",
        changes: {
            feature: [
                "9 classi dei numeri con 16 varianti e abilità (Spazio)",
                "Gacha con i Frammenti guadagnati scrivendo numeri nuovi; i doppioni fanno salire di livello",
                "Bonus permanenti: ATK dai boss e HP dalle Survival Trial, divisi fra chi ha contribuito"
            ],
            logic: [
                "Niente farming: una cella dà XP e Frammenti solo la prima volta che viene scritta"
            ]
        }
    },
    {
        version: "0.5.0",
        date: "2026-11-02",
        title: "Stile pixel, social e boss online",
        changes: {
            feature: [
                "Nuovo stile pixel art cartoon con effetti speciali cinematici",
                "Effetti sonori 8-bit",
                "Amici, party e ricerca dei giocatori, anche dalla home",
                "Classifiche generale e fighters, statistiche dei boss e tempo di gioco"
            ],
            logic: [
                "Boss e Survival Trial decisi dal server",
                "Una sola persona per cella: ci si spinge a vicenda",
                "Chi accetta un invito al party viene portato accanto all'host"
            ],
            fix: [
                "I muri dentro il sudoku attivo sembravano celle normali"
            ]
        }
    },
    {
        version: "0.4.0",
        date: "2026-09-30",
        title: "Account e salvataggi",
        changes: {
            feature: [
                "Utenti e ID dei giocatori sul Realtime Database"
            ],
            fix: [
                "Giocatori fantasma e salvataggio inaffidabile all'uscita",
                "Correzioni generali"
            ]
        }
    },
    {
        version: "0.3.0",
        date: "2026-09-22",
        title: "Boss",
        changes: {
            feature: [
                "Primo boss",
                "Survival Trial",
                "Nuovo ID dei giocatori e salvataggio sul database"
            ],
            fix: [
                "Griglia non visibile col blocco sul boss",
                "Il movimento tramite numero non generava il mondo",
                "Il timer della Survival Trial non scendeva e gli attacchi non toglievano numeri"
            ]
        }
    },
    {
        version: "0.2.0",
        date: "2026-09-14",
        title: "Mondo samurai e multiplayer",
        changes: {
            feature: [
                "Nuova generazione del mondo (samurai)",
                "Salvataggio del mondo"
            ],
            rework: [
                "Riorganizzazione generale del codice"
            ],
            fix: [
                "Multiplayer: posizione degli altri giocatori, caricamento infinito"
            ]
        }
    },
    {
        version: "0.1.0",
        date: "2026-09-10",
        title: "Il mondo infinito",
        changes: {
            feature: [
                "Mondo di sudoku infinito generato da un seed",
                "Coordinate e zone con difficoltà diverse",
                "Prima versione del multiplayer"
            ]
        }
    }
];

window.CURRENT_VERSION = window.CHANGELOG[0].version;
