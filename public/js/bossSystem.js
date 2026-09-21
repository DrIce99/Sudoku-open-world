/* ============================================================
   SISTEMA BOSS - ARCHITETTURA ESTENDIBILE
   ============================================================ */

// Classe Base astratta per supportare più tipi di boss futuri
class BaseBoss {
    constructor(id, bx, by, maxHp = 1000) {
        this.id = id;
        this.bx = bx; // Coord X blocco origine (angolo sup. sx)
        this.by = by; // Coord Y blocco origine
        this.maxHp = maxHp;
        this.hp = maxHp;
        this.type = "generic";
        this.name = "Boss Unknow";
        this.active = true;
        this.outlineEl = null;

        this.initOutline();
    }

    initOutline() {
        this.outlineEl = document.createElement("div");
        this.outlineEl.className = "boss-area-outline";
        this.outlineEl.style.width = (3 * 3 * CELL) + "px";
        this.outlineEl.style.height = (3 * 3 * CELL) + "px";
        this.outlineEl.style.left = (this.bx * 3 * CELL) + "px";
        this.outlineEl.style.top = (this.by * 3 * CELL) + "px";
        worldEl.appendChild(this.outlineEl);
    }

    destroyOutline() {
        if (this.outlineEl) {
            this.outlineEl.remove();
            this.outlineEl = null;
        }
    }

    // Controlla se una coordinata assoluta di celle appartiene al boss (9x9)
    containsCell(cx, cy) {
        const startX = this.bx * 3;
        const startY = this.by * 3;
        return cx >= startX && cx < startX + 9 && cy >= startY && cy < startY + 9;
    }

    // Controlla se un blocco 3x3 si sovrappone a questo boss
    containsBlock(zx, zy) {
        return zx >= this.bx && zx < this.bx + 3 && zy >= this.by && zy < this.by + 3;
    }

    update(deltaTime) {
        // Da implementare nelle sottoclassi
    }

    takeDamage(amount) {
        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) this.onDeath();
    }

    heal(amount) {
        this.hp = Math.min(this.maxHp, this.hp + amount);
    }

    onDeath() {
        this.active = false;
        this.destroyOutline();
        toast(`BOSS SCONFITTO! (+500 XP)`, "gold");
        gainXp(500);
    }
}

/* ============================================================
   TIPO BOSS 1: SudokuHpBoss (Variante legata ai numeri del Sudoku)
   ============================================================ */
class SudokuHpBoss extends BaseBoss {
    constructor(id, bx, by) {
        super(id, bx, by, 1200);
        this.type = "sudoku_hp";
        this.name = "Sudoku Core Guardian";

        this.attackTimer = 0;
        this.attackInterval = 7000; // Attacca ogni 7 secondi
        this.isAttacking = false;
    }

    update(deltaTime) {
        if (!this.active) return;

        // 1. Logica rigenerazione/danno continuo basato sui numeri presenti
        this.updateHealthRegenDamage(deltaTime);

        // 2. Pattern di attacco temporizzato
        this.attackTimer += deltaTime;
        if (this.attackTimer >= this.attackInterval && !this.isAttacking) {
            this.attackTimer = 0;
            this.executeRandomAttack();
        }
    }

    updateHealthRegenDamage(deltaTime) {
        const startX = this.bx * 3;
        const startY = this.by * 3;
        let filledCellsCount = 0;
        let totalPlayableCells = 81; // 9x9 celle

        for (let y = 0; y < 9; y++) {
            for (let x = 0; x < 9; x++) {
                const cx = startX + x;
                const cy = startY + y;
                if (cellShown(cx, cy) !== 0) {
                    filledCellsCount++;
                }
            }
        }

        const fillRatio = filledCellsCount / totalPlayableCells;

        // Se le celle piene sono meno del 50%, recupera vita. Altrimenti subisce danno.
        if (fillRatio < 0.5) {
            const regenAmount = 15 * (deltaTime / 1000); // +15 HP/sec
            this.heal(regenAmount);
        } else {
            const damageAmount = 30 * (fillRatio - 0.49) * (deltaTime / 1000); // Danno scalato
            this.takeDamage(damageAmount);
        }
    }

    executeRandomAttack() {
        this.isAttacking = true;

        const patternType = Math.random() < 0.5 ? "line" : "drunkard";
        let targetCells = [];

        if (patternType === "line") {
            targetCells = this.generateLineAttackPattern();
        } else {
            targetCells = this.generateDrunkardWalkPattern();
        }

        // FASE 1: Preavviso visivo (Telegraphing)
        const warnElements = [];
        targetCells.forEach(cell => {
            const el = document.createElement("div");
            el.className = "boss-attack-cell";
            el.style.left = (cell.x * CELL) + "px";
            el.style.top = (cell.y * CELL) + "px";
            el.style.width = CELL + "px";
            el.style.height = CELL + "px";
            worldEl.appendChild(el);
            warnElements.push(el);
        });

        // FASE 2: Esecuzione dell'attacco dopo 1.8 secondi
        setTimeout(() => {
            warnElements.forEach(el => el.remove());

            // ✅ Se il player è sopra una delle celle attaccate, subisce danno
            if (
                typeof player !== "undefined" &&
                targetCells.some(c => c.x === player.x && c.y === player.y)
            ) {
                this.hitPlayerByAttack();
            }

            targetCells.forEach(cell => {
                this.strikeCell(cell.x, cell.y);
            });

            this.isAttacking = false;
        }, 1800);
    }

    hitPlayerByAttack() {
        // Danno dell'attacco del boss: puoi regolare 0.25 come preferisci
        const dmg = Math.max(10, Math.round(maxHp * 0.25));

        hp -= dmg;

        toast(`Colpito dall'attacco del Boss! -${dmg} HP`, "bad");

        // Effetto visivo simile a quando sbagli numero
        const v = document.getElementById("vignette");
        const stageEl = document.getElementById("stage");
        const hpFillEl = document.getElementById("hpFill");

        if (typeof AN !== "undefined" && AN) {
            if (v) {
                AN({
                    targets: v,
                    keyframes: [
                        { opacity: 1 },
                        { opacity: 0, duration: 500 }
                    ],
                    easing: "easeOutQuad"
                });
            }

            if (stageEl) {
                AN({
                    targets: stageEl,
                    translateX: [0, -10, 10, -6, 6, 0],
                    duration: 340
                });
            }

            if (hpFillEl) {
                AN({
                    targets: hpFillEl,
                    keyframes: [
                        { backgroundColor: "#ffffff" },
                        { backgroundColor: "#ef4444" }
                    ],
                    duration: 500
                });
            }
        } else {
            if (v) {
                v.style.opacity = 1;
                setTimeout(() => v.style.opacity = 0, 350);
            }
        }

        if (hp <= 0) {
            respawn();
        }

        updateBars();
    }

    // Pattern 1: Attacca intera riga o colonna dell'area del boss
    generateLineAttackPattern() {
        const startX = this.bx * 3;
        const startY = this.by * 3;
        const isRow = Math.random() < 0.5;
        const index = Math.floor(Math.random() * 9);
        const cells = [];

        for (let i = 0; i < 9; i++) {
            cells.push({
                x: isRow ? startX + i : startX + index,
                y: isRow ? startY + index : startY + i
            });
        }
        return cells;
    }

    // Pattern 2: Algoritmo dell'ubriaco (Drunkard's Walk) per 2 aree (max 6 celle l'una)
    generateDrunkardWalkPattern() {
        const startX = this.bx * 3;
        const startY = this.by * 3;
        const allCells = [];

        for (let area = 0; area < 2; area++) {
            let cx = Math.floor(Math.random() * 9);
            let cy = Math.floor(Math.random() * 9);
            const visited = new Set();
            const areaCells = [];

            while (areaCells.length < 6) {
                const key = `${cx},${cy}`;
                if (!visited.has(key)) {
                    visited.add(key);
                    areaCells.push({ x: startX + cx, y: startY + cy });
                }

                const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
                const d = dirs[Math.floor(Math.random() * dirs.length)];
                cx = Math.max(0, Math.min(8, cx + d[0]));
                cy = Math.max(0, Math.min(8, cy + d[1]));
            }

            allCells.push(...areaCells);
        }

        return allCells;
    }

    // Rimuove i numeri inseriti escludendo i numeri "immortali"
    strikeCell(cx, cy) {
        // Protezione assoluta dei numeri immortali definiti nel DB/algoritmo
        if (isImmortalCell(cx, cy)) {
            return;
        }

        const zPos = zOf(cx, cy);
        const z = getZone(zPos.x, zPos.y);

        if (!z || z.empty) return;

        const li = zLocal(cx, cy);
        const mask = 1 << li;

        // Non rimuovere se è un dato dato iniziale fisso (given) non modificabile
        if (z.rev & mask) return;

        // Se presente un numero scritto manualmente o da altro player
        if (z.wr & mask) {
            z.wr &= ~mask;
            removeNum(cx, cy);

            // Notifica WebSocket se attivo
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: "write",
                    zoneKey: zKey(zPos.x, zPos.y),
                    cx: mod(cx, 3),
                    cy: mod(cy, 3),
                    gx: cx,
                    gy: cy,
                    val: 0,
                    color: null
                }));
            }
        }
    }
}

/* ============================================================
   GESTORE DEI BOSS (BossManager)
   ============================================================ */
class BossManager {
    constructor() {
        this.bosses = new Map();
        this.maxBosses = 3;
        this.spawnTimer = 0;
        this.spawnInterval = 30000; // Tentativo di spawn ogni 30 secondi
        this.forcedCameraBoss = null;

        this.initHUD();
    }

    initHUD() {
        // Barra HP
        let hudContainer = document.getElementById("boss-hud-container");
        if (!hudContainer) {
            hudContainer = document.createElement("div");
            hudContainer.id = "boss-hud-container";
            hudContainer.innerHTML = `
            <div id="boss-hud-title">BOSS</div>
            <div class="boss-hp-bar-bg">
                <div id="boss-hp-fill" class="boss-hp-bar-fill"></div>
            </div>
        `;
            document.body.appendChild(hudContainer);
        }

        // Freccia indicatore boss (stile beacon dungeon/villaggi)
        let pointer = document.getElementById("boss-proximity-pointer");
        if (!pointer) {
            pointer = document.createElement("div");
            pointer.id = "boss-proximity-pointer";
            pointer.innerHTML = `
            <div class="boss-arrow">▲</div>
            <div class="boss-dist"></div>
        `;
            document.body.appendChild(pointer);
        }

        // CSS della freccia, se non è già stato iniettato
        if (!document.getElementById("bossPointerStyle")) {
            const st = document.createElement("style");
            st.id = "bossPointerStyle";
            st.textContent = `
            #boss-proximity-pointer {
                position: fixed;
                display: none;
                flex-direction: column;
                align-items: center;
                pointer-events: none;
                z-index: 999;
                color: #ff4d5e;
                text-shadow: 0 0 8px rgba(255, 77, 94, .7);
                font-family: monospace;
            }

            #boss-proximity-pointer .boss-arrow {
                font-size: 26px;
                line-height: 1;
            }

            #boss-proximity-pointer .boss-dist {
                font-size: 11px;
                margin-top: 2px;
                letter-spacing: 1px;
            }
        `;
            document.head.appendChild(st);
        }
    }

    spawnBoss(type = "sudoku_hp", bx = null, by = null) {
        if (this.bosses.size >= this.maxBosses) return null;

        // Se le coordinate non sono fornite, trova coordinate casuali valide
        if (bx === null || by === null) {
            const coords = this.findValidSpawnCoords();
            if (!coords) return null;
            bx = coords.bx;
            by = coords.by;
        }

        const id = "boss_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        let boss = null;

        if (type === "sudoku_hp") {
            boss = new SudokuHpBoss(id, bx, by);
        }

        if (boss) {
            this.bosses.set(id, boss);
            toast("Un nuovo Boss è apparso nel mondo!", "bad");
        }

        return boss;
    }

    findValidSpawnCoords() {
        const playerZone = zOf(player.x, player.y);
        const maxAttempts = 50;

        for (let i = 0; i < maxAttempts; i++) {
            // Genera offset casuale tra 5 e 20 blocchi dal giocatore
            const dist = 5 + Math.floor(Math.random() * 15);
            const angle = Math.random() * Math.PI * 2;
            const targetBx = Math.floor(playerZone.x + Math.cos(angle) * dist);
            const targetBy = Math.floor(playerZone.y + Math.sin(angle) * dist);

            // 1. Requisito: Distanza minima di 5 blocchi dallo spawn/giocatore
            const blockDist = Math.hypot(targetBx - playerZone.x, targetBy - playerZone.y);
            if (blockDist < 5) continue;

            // 2. Requisito: Il boss deve prendere 9 blocchi NON vuoti (giocabili)
            let valid9Blocks = true;
            for (let dy = 0; dy < 3; dy++) {
                for (let dx = 0; dx < 3; dx++) {
                    if (!isPlayableZone(targetBx + dx, targetBy + dy)) {
                        valid9Blocks = false;
                        break;
                    }
                }
                if (!valid9Blocks) break;
            }
            if (!valid9Blocks) continue;

            // 3. Requisito: Nessuna sovrapposizione con altri boss
            let overlap = false;
            for (const existingBoss of this.bosses.values()) {
                for (let dy = 0; dy < 3; dy++) {
                    for (let dx = 0; dx < 3; dx++) {
                        if (existingBoss.containsBlock(targetBx + dx, targetBy + dy)) {
                            overlap = true;
                            break;
                        }
                    }
                    if (overlap) break;
                }
            }
            if (overlap) continue;

            return { bx: targetBx, by: targetBy };
        }

        return null;
    }

    update(deltaTime) {
        // Spawn automatico basato sul tempo
        this.spawnTimer += deltaTime;
        if (this.spawnTimer >= this.spawnInterval) {
            this.spawnTimer = 0;
            this.spawnBoss("sudoku_hp");
        }

        let playerInsideAnyBoss = null;
        let closestBoss = null;
        let minDistPx = Infinity;

        this.bosses.forEach((boss, id) => {
            if (!boss.active) {
                this.bosses.delete(id);
                return;
            }

            boss.update(deltaTime);

            // Controlla se il player è dentro l'area del boss
            if (boss.containsCell(player.x, player.y)) {
                playerInsideAnyBoss = boss;
            }

            // Centro del boss in coordinate cella
            const bossCenterX = (boss.bx + 1.5) * 3;
            const bossCenterY = (boss.by + 1.5) * 3;

            // Distanza in pixel tra player e centro del boss
            const d = Math.hypot(
                bossCenterX - player.x,
                bossCenterY - player.y
            ) * CELL;

            if (d < minDistPx) {
                minDistPx = d;
                closestBoss = boss;
            }
        });

        // 1. Gestione Blocco Telecamera Forzato
        this.handleCameraLock(playerInsideAnyBoss);

        // 2. Gestione HUD Barra della Vita
        this.updateHUD(playerInsideAnyBoss);

        // 3. Freccia indicatore verso il boss più vicino
        this.updateProximityPointer(closestBoss, minDistPx);
    }

    handleCameraLock(currentBoss) {
        if (currentBoss) {
            if (this.forcedCameraBoss !== currentBoss) {
                this.forcedCameraBoss = currentBoss;

                // 1) FORZA LA GENERAZIONE DI TUTTI I 9 BLOCCHI DEL BOSS
                //    Appena si entra nell'area, genera subito tutte le zone 3x3
                //    dell'area 9x9 del boss, altrimenti restano senza numeri.
                for (let dy = 0; dy < 3; dy++) {
                    for (let dx = 0; dx < 3; dx++) {
                        const zx = currentBoss.bx + dx;
                        const zy = currentBoss.by + dy;
                        const z = genSingleZone(zx, zy);
                        if (z) z.disc = true; // segna come scoperte (mappa)
                    }
                }

                // 2) BLOCCO TELECAMERA / MOVIMENTO sull'area 9x9 del boss
                follow = false;
                lockRect = {
                    x0: currentBoss.bx * 3,
                    y0: currentBoss.by * 3,
                    x1: currentBoss.bx * 3 + 8,
                    y1: currentBoss.by * 3 + 8
                };

                // 3) NASCONDI LA VISTA DI BLOCCO FINTA (activeBox blu):
                //    durante la bossfight l'unico confine visivo valido
                //    è il bordo rosso dell'area boss.
                activeBox.classList.add("locked");
                activeBox.style.display = "none";
                document.getElementById("lockBadge").style.display = "block";

                // 4) Centra la telecamera sull'area del boss
                camTo((currentBoss.bx + 1.5) * 3, (currentBoss.by + 1.5) * 3);

                // Aggiorna evidenziazioni e controllo unità dopo la generazione
                highlight();
                checkUnits();
            }
        } else if (this.forcedCameraBoss) {
            // Il player è uscito dall'area del boss -> sblocca tutto
            this.forcedCameraBoss = null;
            follow = true;
            lockRect = null;
            activeBox.classList.remove("locked");
            activeBox.style.display = ""; // ripristina la vista normale
            document.getElementById("lockBadge").style.display = "none";
            recenter(true);
        }
    }

    updateHUD(currentBoss) {
        const hudEl = document.getElementById("boss-hud-container");
        if (currentBoss) {
            hudEl.style.display = "flex";
            document.getElementById("boss-hud-title").textContent = currentBoss.name;
            const fillPct = (currentBoss.hp / currentBoss.maxHp) * 100;
            document.getElementById("boss-hp-fill").style.width = fillPct + "%";
        } else {
            hudEl.style.display = "none";
        }
    }

    updateProximityPointer(closestBoss, distPx) {
        const pointer = document.getElementById("boss-proximity-pointer");
        if (!pointer) return;

        // Se non c'è boss, oppure sei già dentro l'area di un boss,
        // la freccia non serve
        if (!closestBoss || this.forcedCameraBoss) {
            pointer.style.display = "none";
            return;
        }

        // Centro del boss in coordinate cella
        const bossCenterX = (closestBoss.bx + 1.5) * 3;
        const bossCenterY = (closestBoss.by + 1.5) * 3;

        // Proietta il centro del boss sullo schermo usando la telecamera attuale.
        // In game.js la camera è centrata su cam.x / cam.y.
        const sx = (bossCenterX - cam.x) * CELL + window.innerWidth / 2;
        const sy = (bossCenterY - cam.y) * CELL + window.innerHeight / 2;

        const margin = 42;
        const cw = window.innerWidth;
        const ch = window.innerHeight;

        // Se il centro del boss è già visibile dentro lo schermo,
        // non mostrare la freccia
        if (
            sx > margin &&
            sx < cw - margin &&
            sy > margin &&
            sy < ch - margin
        ) {
            pointer.style.display = "none";
            return;
        }

        // Altrimenti aggancia la freccia ai bordi dello schermo,
        // come fai nel beacon di dungeon/villaggi
        const edgeX = Math.max(margin, Math.min(cw - margin, sx));
        const edgeY = Math.max(margin, Math.min(ch - margin, sy));

        // Angolazione dal centro dello schermo verso il boss
        const angle = Math.atan2(sy - ch / 2, sx - cw / 2);

        pointer.style.display = "flex";
        pointer.style.left = `${edgeX}px`;
        pointer.style.top = `${edgeY}px`;

        // Ruota solo la freccia, non il testo distanza
        const arrow = pointer.querySelector(".boss-arrow");
        if (arrow) {
            arrow.style.transform = `rotate(${angle + Math.PI / 2}rad)`;
        }

        // Mostra la distanza approssimativa in celle
        const distEl = pointer.querySelector(".boss-dist");
        if (distEl) {
            const cells = Math.max(1, Math.round(distPx / CELL));
            distEl.textContent = `${cells} celle`;
        }
    }

    isBossFightActive() {
        // Se la camera è già bloccata dal boss, siamo sicuramente in bossfight
        if (this.forcedCameraBoss) return true;

        // Se il player è dentro l'area 9x9 di un boss attivo, siamo in bossfight
        if (typeof player !== "undefined") {
            for (const boss of this.bosses.values()) {
                if (boss.active && boss.containsCell(player.x, player.y)) {
                    return true;
                }
            }
        }

        return false;
    }
}

// Istanza Globale
window.bossManager = new BossManager();