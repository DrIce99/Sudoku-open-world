/* ============================================================
   STORICO DEI BILANCIAMENTI (buff e nerf), mostrato nella pagina /version.
   Una voce per versione (la stessa del changelog), la più recente in cima.
   Quando si cambia un valore di gioco (abilities.js, server.js) va aggiunta
   qui la modifica.

   Ogni modifica:
    - target:  chiave della variante ("4b") oppure "economy" (Frammenti)
    - effect:  cosa è cambiato (di solito il nome della variante)
    - verdict: "buff" | "nerf" | "rework", visto dal giocatore
               ("rework" = cambia il funzionamento, o alcuni valori salgono e altri scendono)
    - note:    una frase che riassume la modifica
    - stats:   valori prima/dopo; better = "higher" se un valore più alto favorisce
               il giocatore, "lower" il contrario (decide il colore della freccia)
   Carica anche window.Balance: etichetta dell'ultima modifica di una variante
   (collezione delle classi) e avviso NEW in home.
   ============================================================ */
(function () {
    const VERDICTS = {
        buff: { label: "Buff", symbol: "▲" },
        nerf: { label: "Nerf", symbol: "▼" },
        rework: { label: "Modifica", symbol: "◆" }
    };

    // Classe, nome e colore di ogni bersaglio (come classes.js)
    const TARGETS = {
        "1a": ["1 · Berserker", "#e43b44"], "2a": ["2 · Burst", "#ef7d57"], "2b": ["2 · Burst", "#ef7d57"],
        "3a": ["3 · Tank", "#3b5dc9"], "3b": ["3 · Tank", "#3b5dc9"], "4a": ["4 · Teleport", "#b55ed6"], "4b": ["4 · Teleport", "#b55ed6"],
        "5a": ["5 · Support", "#38b764"], "5b": ["5 · Support", "#38b764"], "6a": ["6 · Movimento", "#14b8a6"], "6b": ["6 · Movimento", "#14b8a6"],
        "7a": ["7 · Contrattacco", "#eab308"], "7b": ["7 · Contrattacco", "#eab308"], "8a": ["8 · Stunner", "#73eff7"],
        "9a": ["9 · Buffer", "#f27ab3"], "9b": ["9 · Buffer", "#f27ab3"], economy: ["Economia", "#ffcd75"]
    };

    const HISTORY = [
        {
            version: "0.8.1",
            date: "2026-11-03",
            title: "Portale potenziato",
            changes: [
                {
                    target: "4b", effect: "Portale", verdict: "buff",
                    note: "Un portale aperto in più a ogni livello: al LV 10 una rete di 10 scorciatoie",
                    stats: [
                        { label: "Portali al LV 4", before: 2, after: 4, better: "higher" },
                        { label: "Portali al LV 7", before: 3, after: 7, better: "higher" },
                        { label: "Portali al LV 10", before: 4, after: 10, better: "higher" }
                    ]
                }
            ]
        },
        {
            version: "0.8.0",
            date: "2026-11-03",
            title: "Ogni livello conta",
            changes: [
                {
                    target: "4a", effect: "Salto", verdict: "buff",
                    note: "+5 celle di raggio a livello e ricarica più breve",
                    stats: [
                        { label: "Raggio al LV 10", before: 45, after: 90, unit: "celle", better: "higher" },
                        { label: "Ricarica al LV 10", before: 2.5, after: 1.72, unit: "s", better: "lower" }
                    ]
                },
                {
                    target: "4b", effect: "Portale", verdict: "buff",
                    note: "Più portali aperti insieme: uno in più ai LV 4, 7 e 10",
                    stats: [
                        { label: "Portali al LV 10", before: 1, after: 4, better: "higher" }
                    ]
                },
                {
                    target: "6b", effect: "Blink", verdict: "buff",
                    note: "+1 cella di raggio ogni 2 livelli e ricarica più breve",
                    stats: [
                        { label: "Raggio al LV 10", before: 8, after: 12, unit: "celle", better: "higher" },
                        { label: "Ricarica al LV 10", before: 3, after: 2.07, unit: "s", better: "lower" }
                    ]
                },
                {
                    target: "3a", effect: "Bastione", verdict: "buff",
                    note: "Dal LV 2 protegge anche chi sta accanto a un 3 (-5% di danni a livello)",
                    stats: [
                        { label: "Riduzione accanto a un 3 (LV 10)", before: 0, after: 45, unit: "%", better: "higher" }
                    ]
                },
                {
                    target: "8a", effect: "Congelamento", verdict: "buff",
                    note: "Il congelamento dura il 5% in più a ogni livello",
                    stats: [
                        { label: "Durata al LV 10", before: 5, after: 7.25, unit: "s", better: "higher" }
                    ]
                },
                {
                    target: "9a", effect: "Amplificatore", verdict: "buff",
                    note: "+5% di potenziamento a ogni livello",
                    stats: [
                        { label: "Potenziamento al LV 10", before: 50, after: 95, unit: "%", better: "higher" }
                    ]
                },
                {
                    target: "5a", effect: "Rigenerazione", verdict: "buff",
                    note: "Col livello crescono anche gli indizi, non solo le cure",
                    stats: [
                        { label: "Intervallo degli indizi al LV 10", before: 20, after: 13.8, unit: "s", better: "lower" }
                    ]
                }
            ]
        },
        {
            version: "0.7.0",
            date: "2026-11-02",
            title: "Classi sistemate",
            changes: [
                {
                    target: "3b", effect: "Aura", verdict: "buff",
                    note: "Si cammina sui 3 e l'aura protegge anche i numeri del suo 3x3 dagli attacchi",
                    stats: [
                        { label: "Numeri protetti nell'aura", before: 0, after: 9, better: "higher" }
                    ]
                },
                {
                    target: "5a", effect: "Rigenerazione", verdict: "nerf",
                    note: "Indizi più rari e solo nel sudoku attivo (arena del boss o 9x9 bloccato con R)",
                    stats: [
                        { label: "Intervallo degli indizi", before: 7, after: 20, unit: "s", better: "lower" }
                    ]
                },
                {
                    target: "4a", effect: "Salto", verdict: "rework",
                    note: "Si salta su qualsiasi 4, iniziale o scritto da chiunque, non solo sui propri"
                },
                {
                    target: "economy", effect: "Frammenti", verdict: "buff",
                    note: "Frammenti extra completando le unità (una volta sola per unità)",
                    stats: [
                        { label: "Riga, colonna o 3x3", before: 0, after: 2, unit: "◆", better: "higher" },
                        { label: "Sudoku 9x9", before: 0, after: 10, unit: "◆", better: "higher" }
                    ]
                }
            ]
        }
    ];

    const SEEN_KEY = "patchSeen";
    const latest = (window.CURRENT_VERSION || HISTORY[0].version);

    function seen() {
        try { return localStorage.getItem(SEEN_KEY); } catch { return latest; }
    }

    window.Balance = {
        VERDICTS, TARGETS, HISTORY,
        latest,
        isNew: () => seen() !== latest,
        lastSeen: seen,
        markSeen() {
            try { localStorage.setItem(SEEN_KEY, latest); } catch { /* storage non disponibile */ }
        },
        // Ultima modifica di una variante (etichetta nella collezione delle classi)
        latestFor(key) {
            for (const entry of HISTORY) {
                const c = entry.changes.find(c => c.target === key);
                if (c) return { ...c, version: entry.version };
            }
            return null;
        },
        chip(c) {
            const v = VERDICTS[c.verdict];
            const el = document.createElement("a");
            el.className = "verdict-pill " + c.verdict;
            el.href = "/version#bilanciamenti";
            el.title = `v${c.version}: ${c.note}`;
            el.textContent = `${v.symbol} ${v.label} v${c.version}`;
            return el;
        }
    };

    // avviso NEW sui bottoni della home
    function paintBadges() {
        document.querySelectorAll("[data-balance-badge]").forEach(b => { b.hidden = !window.Balance.isNew(); b.textContent = "NEW"; });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paintBadges);
    else paintBadges();
})();
