/* ============================================================
   SISTEMA BOSS — CLIENT
   Spawn, vita, timer e attacchi sono decisi dal server (bossServer.js),
   così tutti i giocatori vedono gli stessi boss e combattono insieme.
   Qui restano: disegno dell'area, blocco camera, HUD, freccia di
   prossimità, preavviso degli attacchi e colpi subiti dal giocatore.
   ============================================================ */

// Distanza (in celle) entro cui gli eventi di un boss sono mostrati con effetti e avvisi
const BOSS_NOTICE_CELLS = 75;

class ClientBoss {
    constructor(data) {
        Object.assign(this, data);
        this.outlineEl = document.createElement("div");
        this.outlineEl.className = "boss-area-outline";
        worldEl.appendChild(this.outlineEl);
        this.layout();
        this.update(data);
    }

    // Posizione dell'area 9x9 (richiamata anche quando cambia la dimensione delle celle)
    layout() {
        const s = this.outlineEl.style;
        s.width = s.height = (9 * CELL) + "px";
        s.left = (this.bx * 3 * CELL) + "px";
        s.top = (this.by * 3 * CELL) + "px";
    }

    update(data) {
        Object.assign(this, data);
        this.outlineEl.classList.toggle("stunned", this.stunMs > 0);
        this.outlineEl.classList.toggle("bastion", !!this.bastion);
        this.renderAuras();
    }

    // Aure disegnate sull'arena: classe 3 (3x3 attorno a chi sta su un 3)
    // e classe 7 (aure di risposta su 3x3, riga o colonna)
    renderAuras() {
        this.auraEls ??= [];
        const rects = [
            ...(this.auras || []).map(a => ({ cls: "boss-aura", x0: a.x - 1, y0: a.y - 1, x1: a.x + 1, y1: a.y + 1 })),
            ...(this.counters || []).map(c => ({ cls: "boss-aura counter", ...c }))
        ];
        while (this.auraEls.length > rects.length) this.auraEls.pop().remove();
        while (this.auraEls.length < rects.length) {
            const el = document.createElement("div");
            worldEl.appendChild(el);
            this.auraEls.push(el);
        }
        rects.forEach((r, i) => {
            const el = this.auraEls[i];
            el.className = r.cls;
            el.style.left = (r.x0 * CELL) + "px";
            el.style.top = (r.y0 * CELL) + "px";
            el.style.width = ((r.x1 - r.x0 + 1) * CELL) + "px";
            el.style.height = ((r.y1 - r.y0 + 1) * CELL) + "px";
            if (r.color) el.style.setProperty("--p-color", r.color);
        });
    }

    destroy() {
        this.outlineEl?.remove();
        this.outlineEl = null;
        (this.auraEls || []).forEach(el => el.remove());
        this.auraEls = [];
    }

    // Controlla se una coordinata assoluta di celle appartiene al boss (9x9)
    containsCell(cx, cy) {
        const startX = this.bx * 3;
        const startY = this.by * 3;
        return cx >= startX && cx < startX + 9 && cy >= startY && cy < startY + 9;
    }

    // Distanza in celle dal centro dell'area
    distanceTo(x, y) {
        return Math.hypot((this.bx + 1.5) * 3 - x, (this.by + 1.5) * 3 - y);
    }
}

/* ============================================================
   GESTORE DEI BOSS (BossManager)
   ============================================================ */
class BossManager {
    constructor() {
        this.bosses = new Map();
        this.forcedCameraBoss = null;
        this.attacks = new Map();   // attackId -> { els, fx, cells, dmgPct, minDmg, bossId }

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
    }

    isNear(boss) {
        return boss.distanceTo(player.x, player.y) < BOSS_NOTICE_CELLS;
    }

    isInside(boss) {
        return boss.containsCell(player.x, player.y);
    }

    /* ---------------- messaggi dal server ---------------- */
    onMessage(msg) {
        switch (msg.type) {
            case "bosses": return this.sync(msg.list || []);
            case "boss_spawned": {
                const boss = this.add(msg.boss);
                if (this.isNear(boss)) {
                    window.FX?.bossWarning(boss.name);
                    toast(`Un nuovo Boss è apparso: ${boss.name}!`, "bad");
                }
                return;
            }
            case "boss_started": {
                const boss = this.bosses.get(msg.bossId);
                if (boss && this.isInside(boss)) toast("Survival Trial iniziata!", "bad");
                return;
            }
            case "boss_telegraph": return this.telegraph(msg);
            case "boss_strike": return this.strike(msg);
            case "boss_hurt": {
                const boss = this.bosses.get(msg.bossId);
                if (!boss || !this.isNear(boss)) return;
                // numeri di danno sopra l'arena; scossone solo per i colpi grossi
                window.FX?.bossDamage(boss, msg.amount, msg.unit);
                if (this.isInside(boss) && msg.amount >= 50) window.FX?.bossHurt(msg.amount);
                return;
            }
            case "boss_stunned": {
                const boss = this.bosses.get(msg.bossId);
                if (boss && this.isNear(boss)) window.FX?.bossStunned(boss, msg.by, this.isInside(boss));
                return;
            }
            case "boss_defeated": return this.defeated(msg);
            case "boss_failed": {
                const boss = this.bosses.get(msg.bossId);
                if (boss && this.isInside(boss)) {
                    window.FX?.trialFailed();
                    toast(`${boss.name} fallita!`, "bad");
                }
                return this.remove(msg.bossId);
            }
            case "boss_despawned": return this.remove(msg.bossId);
        }
    }

    add(data) {
        let boss = this.bosses.get(data.id);
        if (boss) boss.update(data);
        else this.bosses.set(data.id, boss = new ClientBoss(data));
        return boss;
    }

    sync(list) {
        const ids = new Set(list.map(b => b.id));
        list.forEach(b => this.add(b));
        for (const id of [...this.bosses.keys()]) if (!ids.has(id)) this.remove(id);
    }

    remove(id) {
        const boss = this.bosses.get(id);
        if (!boss) return null;
        boss.destroy();
        this.bosses.delete(id);
        // preavvisi ancora a schermo di questo boss
        for (const [attackId, a] of this.attacks) {
            if (a.bossId !== id) continue;
            a.els.forEach(el => el.remove());
            window.FX?.strike(a.fx, false);
            this.attacks.delete(attackId);
        }
        return boss;
    }

    // Connessione persa: lo stato dei boss non è più valido
    clear() {
        for (const id of [...this.bosses.keys()]) this.remove(id);
    }

    relayout() {
        this.bosses.forEach(b => b.layout());
    }

    defeated(msg) {
        const boss = this.bosses.get(msg.bossId);
        if (!boss) return;
        const mine = msg.participants?.includes(myPlayerId);
        if (mine || this.isNear(boss)) window.FX?.bossDefeated(boss);
        if (mine) {
            const label = boss.type === "survival_trial" ? "SURVIVAL TRIAL SUPERATA" : "BOSS SCONFITTO";
            toast(`${label}! (+${msg.xp} XP)`, "gold");
            gainXp(msg.xp);
        }
        this.remove(msg.bossId);
    }

    /* ---------------- attacchi ---------------- */

    // Preavviso visivo delle celle che verranno colpite
    telegraph(msg) {
        const boss = this.bosses.get(msg.bossId);
        if (!boss || !this.isNear(boss)) return;
        const els = msg.cells.map(cell => {
            const el = document.createElement("div");
            el.className = "boss-attack-cell";
            el.style.left = (cell.x * CELL) + "px";
            el.style.top = (cell.y * CELL) + "px";
            el.style.width = CELL + "px";
            el.style.height = CELL + "px";
            el.style.setProperty("--tele", msg.duration + "ms");
            worldEl.appendChild(el);
            return el;
        });
        this.attacks.set(msg.attackId, {
            bossId: msg.bossId, els, cells: msg.cells, dmgPct: msg.dmgPct, minDmg: msg.minDmg,
            fx: window.FX?.telegraph(msg.cells, msg.duration)
        });
    }

    // Il colpo cade: è colpito chi si trova (sul proprio client) su una delle celle
    strike(msg) {
        const a = this.attacks.get(msg.attackId);
        if (!a) return;
        this.attacks.delete(msg.attackId);
        a.els.forEach(el => el.remove());

        const mods = msg.mods || {};
        const onTarget = !msg.cancelled && a.cells.some(c => c.x === player.x && c.y === player.y);
        // Bastione (classe 3): chi sta su un 3 è immune; Parry (classe 7): colpo parato
        const immune = onTarget && mods.bastion && cellShown(player.x, player.y) === 3;
        const parried = onTarget && (mods.parried || []).includes(myPlayerId);
        window.FX?.strike(a.fx, onTarget);
        if (parried) {
            window.FX?.floatText(player.x, player.y, "PARATO", "dodge");
        } else if (immune) {
            window.FX?.floatText(player.x, player.y, "IMMUNE", "dodge");
            window.SFX?.play("dodge");
        } else if (onTarget) {
            this.hitPlayerByAttack(this.bosses.get(a.bossId), a, mods);
        }
    }

    hitPlayerByAttack(boss, attack, mods = {}) {
        let dmg = Math.max(attack.minDmg, Math.round(maxHp * attack.dmgPct));

        // Aura (classe 3): riduzione se si è nel 3x3 attorno a chi la genera
        const reduction = Math.max(0, ...(mods.auras || [])
            .filter(a => Math.abs(a.x - player.x) <= 1 && Math.abs(a.y - player.y) <= 1)
            .map(a => a.reduction));
        dmg *= 1 - reduction;
        // Furia (classe 1) attiva: danni subiti +50%
        if ((mods.rage || []).includes(myPlayerId)) dmg *= 1.5;
        dmg = Math.round(dmg);

        // danni subiti (prima dello scudo): servono all'Accumulo della classe 2
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "player_hit", dmg }));

        const absorbed = window.Abilities?.absorb(dmg) || 0;
        dmg -= absorbed;
        hp -= dmg;

        const extra = absorbed ? ` (scudo ${absorbed})` : reduction ? ` (aura -${Math.round(reduction * 100)}%)` : "";
        toast(`Colpito da ${boss?.name || "un boss"}! -${dmg} HP${extra}`, "bad");
        window.FX?.playerHit(dmg);

        if (hp <= 0) {
            respawn();
        }

        updateBars();
    }

    /* ---------------- per frame ---------------- */
    update() {
        let playerInsideAnyBoss = null;
        let closestBoss = null;
        let minDistPx = Infinity;

        this.bosses.forEach(boss => {
            if (this.isInside(boss)) playerInsideAnyBoss = boss;

            const d = boss.distanceTo(player.x, player.y) * CELL;
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
                window.FX?.bossIntro(currentBoss);

                // Genera subito tutti i 9 blocchi 3x3 dell'area boss
                for (let dy = 0; dy < 3; dy++) {
                    for (let dx = 0; dx < 3; dx++) {
                        const z = genSingleZone(currentBoss.bx + dx, currentBoss.by + dy);
                        if (z) z.disc = true;
                    }
                }

                // Blocca movimento e camera sull'area 9x9 del boss
                follow = false;
                lockRect = {
                    x0: currentBoss.bx * 3,
                    y0: currentBoss.by * 3,
                    x1: currentBoss.bx * 3 + 8,
                    y1: currentBoss.by * 3 + 8
                };

                // NON nascondere activeBox: deve restare visibile per mostrare la griglia
                activeBox.classList.add("locked");
                activeBox.style.display = "";
                activeBox.style.pointerEvents = "none";

                // Forza la griglia attiva sull'area del boss
                setActiveBlock(currentBoss.bx, currentBoss.by, true);

                document.getElementById("lockBadge").style.display = "block";

                // Forza la finestra logica 9x9 sull'area del boss
                winZone = {
                    x: currentBoss.bx + 1,
                    y: currentBoss.by + 1
                };

                camTo(
                    (currentBoss.bx + 1.5) * 3,
                    (currentBoss.by + 1.5) * 3
                );

                highlight();
                checkUnits();
            }
        } else if (this.forcedCameraBoss) {
            this.forcedCameraBoss = null;

            follow = true;
            lockRect = null;

            activeBox.classList.remove("locked");
            activeBox.style.display = "";
            activeBox.style.pointerEvents = "";

            document.getElementById("lockBadge").style.display = "none";

            recenter(true);
        }
    }

    updateHUD(currentBoss) {
        const hudEl = document.getElementById("boss-hud-container");

        if (currentBoss) {
            hudEl.style.display = "flex";

            const titleEl = document.getElementById("boss-hud-title");

            let title = currentBoss.name;
            if (currentBoss.type === "survival_trial") {
                const secs = currentBoss.started ? Math.ceil(currentBoss.timeLeft) : currentBoss.duration;
                title += ` · ${secs}s`;
            }
            if (currentBoss.stunMs > 0) title += " · CONGELATO";
            if (currentBoss.bastion) title += " · BASTIONE";
            titleEl.textContent = title;

            const fillPct = Math.max(0, (currentBoss.hp / currentBoss.maxHp) * 100);
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
        const top = 80;   // sotto la barra HOME / CERCA / AMICI
        const cw = window.innerWidth;
        const ch = window.innerHeight;

        // Se il centro del boss è già visibile dentro lo schermo,
        // non mostrare la freccia
        if (
            sx > margin &&
            sx < cw - margin &&
            sy > top &&
            sy < ch - margin
        ) {
            pointer.style.display = "none";
            return;
        }

        // Altrimenti aggancia la freccia ai bordi dello schermo
        const edgeX = Math.max(margin, Math.min(cw - margin, sx));
        const edgeY = Math.max(top, Math.min(ch - margin, sy));

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
        for (const boss of this.bosses.values()) {
            if (this.isInside(boss)) return true;
        }

        return false;
    }
}

// Istanza Globale
window.bossManager = new BossManager();

// Alla morte il server deve saperlo: se eri l'unico dentro una Survival Trial, la prova fallisce
(function () {
    if (typeof respawn === "function") {
        const baseRespawn = respawn;

        respawn = function () {
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "player_died", x: player.x, y: player.y }));
            }
            return baseRespawn.apply(this, arguments);
        };
    }
})();
