/* ============================================================
   ABILITÀ — CLIENT
   Le abilità sono decise dal server (abilities.js): qui c'è il
   riquadro nell'HUD (Spazio per attivare), il mirino del Salto (4,
   rotella del mouse), il Blink col clic (6), gli scudi (9), le cure (5),
   i portali (4) e gli effetti delle abilità usate da tutti i giocatori.
   ============================================================ */
(function () {
    const slot = document.getElementById("abilitySlot");
    const nameEl = slot.querySelector(".ab-name");
    const keyEl = slot.querySelector(".ab-key");
    const infoEl = slot.querySelector(".ab-info");
    const cdEl = slot.querySelector(".ab-cd");

    let st = { kind: "none" };
    let cdEnd = 0, cdTotal = 0;
    let shields = [];   // { amount, until }

    const send = data => (typeof ws !== "undefined" && ws && ws.readyState === 1) ? (ws.send(JSON.stringify(data)), true) : false;

    function use(target) {
        if (st.key === "4a" && !target) target = jumpTarget();
        if (st.kind === "click" && !target) return toast("Blink: clicca una cella del sudoku", "gold");
        if (!send({ type: "ability", target })) toast("Le abilità richiedono la connessione al server", "bad");
    }
    slot.addEventListener("click", () => { use(); slot.blur(); });

    function setState(s) {
        // classe cambiata: aggiorna anche l'etichetta nell'HUD (nome e livello)
        if (s.key !== st.key && typeof loadSelectedClass === "function") loadSelectedClass();
        st = s;
        if (s.cooldownMs > 0) {
            cdEnd = performance.now() + s.cooldownMs;
            cdTotal = s.cooldownMs;
        } else {
            cdEnd = 0;
        }
        slot.hidden = false;
        slot.dataset.kind = s.kind;
        slot.classList.toggle("active", !!s.active);
        nameEl.textContent = s.kind === "none" ? "NESSUNA CLASSE" : s.name.toUpperCase();
        keyEl.textContent = s.kind === "passive" ? "PASSIVA" : s.kind === "soon" || s.kind === "none" ? "—"
            : s.kind === "click" ? "CLIC" : s.kind === "target" ? "ROTELLA + SPAZIO" : "SPAZIO";
        stage.classList.toggle("blink-mode", s.key === "6b");
        if (s.message) toast(s.message, s.error ? "bad" : "gold");
        if (s.error) window.SFX?.play("bump");
        else if (s.message) window.SFX?.play("confirm");
    }

    // Testo e ricarica aggiornati a ogni frame
    function render() {
        requestAnimationFrame(render);
        if (slot.hidden) return;
        const left = Math.max(0, cdEnd - performance.now());
        cdEl.style.height = left && cdTotal ? (left / cdTotal * 100) + "%" : "0%";
        slot.classList.toggle("cooling", left > 0);

        let info = "";
        if (st.kind === "none") info = "scegli in home";
        else if (st.kind === "soon") info = "abilità in arrivo";
        else if (st.locked) info = `si sblocca al LV ${st.locked}`;
        else if (left > 0) info = `ricarica ${(left / 1000).toFixed(1)}s`;
        else if (st.kind === "charge" && st.active) info = `carica ${st.stored}/${st.cap}`;
        else if (st.kind === "toggle" && st.active) info = "ATTIVA";
        else if (st.kind === "target") info = targets.length ? `4 in (${targets[targetIdx % targets.length].x}, ${targets[targetIdx % targets.length].y})` : "nessun 4 vicino";
        else if (st.kind === "click") info = "clicca una cella";
        else if (st.kind === "shape") info = st.shape ? `aura: ${st.shape}` : "scrivi un 7 nell'arena";
        else if (st.kind === "passive") info = "sempre attiva";
        else info = "pronta";
        if (infoEl.textContent !== info) infoEl.textContent = info;

        // scudi scaduti
        const now = performance.now();
        if (shields.some(s => s.until <= now)) {
            shields = shields.filter(s => s.until > now);
            renderShield();
        }
    }
    requestAnimationFrame(render);

    /* ---------------- scudi (classe 9, variante Scudo) ---------------- */
    const shieldTotal = () => shields.reduce((n, s) => n + s.amount, 0);

    function renderShield() {
        const el = document.getElementById("shieldTag");
        const bar = document.getElementById("shieldFill");
        if (!el || !bar) return;
        const total = shieldTotal();
        el.hidden = !total;
        el.textContent = "+" + total;
        // nella barra: dopo la vita, oppure sovrapposto alla sua fine se insieme superano il massimo
        bar.hidden = !total;
        const w = Math.min(1, total / maxHp), life = Math.max(0, hp / maxHp);
        bar.style.width = w * 100 + "%";
        bar.style.left = Math.min(life, 1 - w) * 100 + "%";
    }

    // Lo scudo assorbe il danno (prima quello che scade prima); restituisce quanto ha assorbito
    function absorb(dmg) {
        let absorbed = 0;
        shields.sort((a, b) => a.until - b.until);
        for (const s of shields) {
            const take = Math.min(s.amount, dmg - absorbed);
            s.amount -= take;
            absorbed += take;
            if (absorbed >= dmg) break;
        }
        shields = shields.filter(s => s.amount > 0);
        renderShield();
        return absorbed;
    }

    /* ---------------- Salto (4a): i 4 vicini (iniziali o scritti da chiunque), scelti con la rotella ---------------- */
    let targets = [], targetIdx = 0;
    const marker = document.createElement("div");
    marker.className = "tp-target";
    marker.hidden = true;
    worldEl.appendChild(marker);

    function scanTargets() {
        if (st.key !== "4a") { targets = []; marker.hidden = true; return; }
        const found = [];
        const rz = Math.ceil((st.range || 45) / 3);
        for (let zy = curZone.y - rz; zy <= curZone.y + rz; zy++) {
            for (let zx = curZone.x - rz; zx <= curZone.x + rz; zx++) {
                const z = getZone(zx, zy);
                if (!z || z.empty) continue;
                for (let li = 0; li < 9; li++) {
                    const x = zx * 3 + li % 3, y = zy * 3 + Math.floor(li / 3);
                    if (z.v[li] === 4 && ((z.rev | z.wr) & (1 << li)) && !(x === player.x && y === player.y)) found.push({ x, y });
                }
            }
        }
        found.sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));
        // il raggio cresce col livello della variante (lo manda il server)
        const range = st.range || 45;
        targets = found.filter(t => Math.max(Math.abs(t.x - player.x), Math.abs(t.y - player.y)) <= range);
        const t = jumpTarget();
        marker.hidden = !t;
        if (t) {
            marker.style.left = t.x * CELL + "px";
            marker.style.top = t.y * CELL + "px";
        }
    }
    setInterval(scanTargets, 400);

    const jumpTarget = () => targets.length ? targets[targetIdx % targets.length] : null;

    addEventListener("wheel", e => {
        if (st.key !== "4a" || mapMode || window.Social?.isOpen() || !targets.length) return;
        targetIdx = (targetIdx + (e.deltaY > 0 ? 1 : targets.length - 1)) % targets.length;
        scanTargets();
        window.SFX?.play("select");
    }, { passive: true });

    /* ---------------- Blink (6b): clic su una cella ---------------- */
    stage.addEventListener("click", e => {
        if (st.key !== "6b") return;
        const x = Math.floor((e.clientX - innerWidth / 2) / CELL + cam.x);
        const y = Math.floor((e.clientY - innerHeight / 2) / CELL + cam.y);
        use({ x, y });
    });

    /* ---------------- portali (4b) ---------------- */
    let portalEls = [], portalCells = new Set();
    function renderPortals(list) {
        portalCells = new Set(list.flatMap(p => [p.a, p.b].map(c => c.x + "," + c.y)));
        portalEls.forEach(el => el.remove());
        portalEls = list.flatMap(p => [p.a, p.b].map(c => {
            const el = document.createElement("div");
            el.className = "portal";
            el.style.left = c.x * CELL + "px";
            el.style.top = c.y * CELL + "px";
            el.style.setProperty("--p-color", p.color || "#b55ed6");
            worldEl.appendChild(el);
            return el;
        }));
    }

    /* ---------------- messaggi ---------------- */
    function onMessage(msg) {
        if (msg.type === "ability_state") { setState(msg); scanTargets(); return; }
        if (msg.type === "portals") return renderPortals(msg.list || []);
        if (msg.type === "heal") {
            const before = hp;
            hp = Math.min(maxHp, hp + msg.amount);
            updateBars();
            if (hp > before) window.FX?.healed(hp - before, msg.from);
            return;
        }
        if (msg.type === "shield") {
            shields.push({ amount: msg.amount, until: performance.now() + msg.duration });
            renderShield();
            window.FX?.shieldGained(msg.amount);
            return;
        }
        if (msg.type === "ability_fx") return window.FX?.abilityFx(msg, msg.by === myPlayerId);
    }

    window.Abilities = {
        use, onMessage, absorb, renderShield,
        key: () => st.key || null,
        // Celle con un numero in cui si può entrare: tutte col Passo libero (6a), i capi dei
        // portali (4b), i 3 per il Tank (3a/3b) e, nell'arena col Bastione attivo, per tutti
        canEnter: (x, y) => st.key === "6a" || portalCells.has(x + "," + y) || (cellShown(x, y) === 3 && (st.key === "3a" || st.key === "3b" ||
            [...(window.bossManager?.bosses.values() || [])].some(b => b.bastion && b.containsCell(x, y))))
    };
})();
