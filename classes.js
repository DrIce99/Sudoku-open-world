// ==================== CLASSI DEI NUMERI E GACHA ====================
// Catalogo unico (servito ai client da /api/classes) e regole del gacha.
// Ogni tirata dà una classe a caso (1-9, stessa probabilità) e una sua variante
// a caso. I doppioni fanno salire di livello variante e classe: per passare dal
// livello L al livello L+1 servono L doppioni (1, poi 2, poi 3...).
// perLevel: cosa migliora a ogni livello della variante (i valori sono in abilities.js).

export const PULL_COST = 50;        // Frammenti per una tirata
export const TEN_PULL_COST = 450;   // 10 tirate (una gratis)
export const MAX_LEVEL = 10;

export const CLASS_CATALOG = [
    {
        id: 1, name: "Berserker", role: "Danno costante", color: "#e43b44",
        variants: [
            { id: "a", name: "Furia", desc: "Danno costante al boss in base ai tuoi 1 sul campo. L'abilità aumenta il danno, ma subisci il 50% di danni in più finché resta attiva.",
              perLevel: "+5% di danno." }
        ]
    },
    {
        id: 2, name: "Burst", role: "Danno a raffica", color: "#ef7d57",
        variants: [
            { id: "a", name: "Sacrificio", desc: "Sacrifica i tuoi 2 sul campo: ognuno infligge al boss il doppio del tuo attacco.",
              perLevel: "+5% di danno." },
            { id: "b", name: "Accumulo", desc: "Accumula il 20% dei danni subiti da tutti i giocatori e li rilascia sul boss (massimo 10 volte il tuo attacco).",
              perLevel: "+5% di danni accumulati e di limite massimo." }
        ]
    },
    {
        id: 3, name: "Tank", role: "Difesa", color: "#3b5dc9",
        variants: [
            { id: "a", name: "Bastione", desc: "Nell'arena tutti possono camminare sui 3 e sono immuni finché ci stanno sopra; i boss non possono cancellare i 3.",
              perLevel: "chi sta accanto a un 3 subisce il 5% di danni in meno (dal LV 2: 45% al LV 10)." },
            { id: "b", name: "Aura", desc: "Puoi camminare sui 3: stando su un 3 generi un'aura 3x3 che riduce del 30% i danni subiti dai giocatori al suo interno e impedisce ai boss di cancellarne i numeri.",
              perLevel: "+5% di riduzione (30% al LV 1, 43% al LV 10)." }
        ]
    },
    {
        id: 4, name: "Teleport", role: "Spostamento", color: "#b55ed6",
        variants: [
            { id: "a", name: "Salto", desc: "Ti teletrasporti su un 4 qualsiasi, iniziale o scritto da chiunque (rotella del mouse per scegliere il bersaglio).",
              perLevel: "+5 celle di raggio e ricarica più breve (2,5 s al LV 1, 1,7 s al LV 10)." },
            { id: "b", name: "Portale", desc: "Due 4 formano un portale a due vie che possono usare tutti i giocatori.",
              perLevel: "un portale in più aperto insieme (1 al LV 1, 10 al LV 10)." }
        ]
    },
    {
        id: 5, name: "Support", role: "Cura", color: "#38b764",
        variants: [
            { id: "a", name: "Rigenerazione", desc: "Fa comparire un numero-indizio ogni 20 secondi e rigenera la vita dei giocatori.",
              perLevel: "+5% di cure e indizi più frequenti (ogni 20 s al LV 1, 14 s al LV 10)." },
            { id: "b", name: "Cura", desc: "Sacrifica i tuoi 5 sul campo per curare i giocatori vicini (15% dei tuoi HP per numero).",
              perLevel: "+5% di cura." }
        ]
    },
    {
        id: 6, name: "Movimento", role: "Mobilità", color: "#14b8a6",
        variants: [
            { id: "a", name: "Passo libero", desc: "Ti muovi liberamente anche sopra i numeri.",
              perLevel: "già completa: il livello non la cambia." },
            { id: "b", name: "Blink", desc: "Ti teletrasporti dove clicchi, dentro il sudoku attivo.",
              perLevel: "+1 cella di raggio ogni 2 livelli e ricarica più breve (3 s al LV 1, 2 s al LV 10)." }
        ]
    },
    {
        id: 7, name: "Contrattacco", role: "Parata", color: "#eab308",
        variants: [
            { id: "a", name: "Parry", desc: "Con il tempismo giusto pari l'attacco del boss e gli rispedisci i danni.",
              perLevel: "+5% di danno rispedito." },
            { id: "b", name: "Aura di risposta", desc: "Il 7 inserito crea un'aura su riga, colonna o 3x3: se il boss la colpisce subisce danni.",
              perLevel: "+5% di danno." }
        ]
    },
    {
        id: 8, name: "Stunner", role: "Controllo", color: "#73eff7",
        variants: [
            { id: "a", name: "Congelamento", desc: "Congela il boss: non attacca, non si rigenera e subisce danni aumentati.",
              perLevel: "congelamento più lungo (5 s al LV 1, 7,3 s al LV 10)." }
        ]
    },
    {
        id: 9, name: "Buffer", role: "Potenziamento", color: "#f27ab3",
        variants: [
            { id: "a", name: "Amplificatore", desc: "Le abilità delle classi del party sono più forti del 50%.",
              perLevel: "+5% di potenziamento (50% al LV 1, 95% al LV 10)." },
            { id: "b", name: "Scudo", desc: "Ogni 9 che inserisci dà a tutti uno scudo pari al 10% dei tuoi HP massimi.",
              perLevel: "+5% di scudo." }
        ]
    }
];

export const variantKey = (classId, variant) => `${classId}${variant}`;

export function findVariant(classId, variant) {
    const cls = CLASS_CATALOG.find(c => c.id === Number(classId));
    const v = cls?.variants.find(v => v.id === variant);
    return cls && v ? { cls, v } : null;
}

// Livello a partire dal numero di copie trovate (la prima copia sblocca il livello 1)
export function levelFromCopies(copies) {
    if (!copies) return { level: 0, progress: 0, need: 1 };
    let level = 1, rest = copies - 1;
    while (level < MAX_LEVEL && rest >= level) {
        rest -= level;
        level++;
    }
    return level >= MAX_LEVEL ? { level, progress: 0, need: 0 } : { level, progress: rest, need: level };
}

export function rollPull() {
    const cls = CLASS_CATALOG[Math.floor(Math.random() * CLASS_CATALOG.length)];
    const v = cls.variants[Math.floor(Math.random() * cls.variants.length)];
    return { classId: cls.id, variant: v.id };
}
