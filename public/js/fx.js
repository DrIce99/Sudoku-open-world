/* ============================================================
   FX — effetti speciali pixel art "cinematici"
   - un canvas a bassa risoluzione (ogni pixel = PX px sullo schermo)
     per particelle, onde d'urto, raggi, linee di velocità;
   - elementi DOM per scritte cartoon (banner, numeri fluttuanti, POW!);
   - shake / zoom / hit-stop / slow-motion / letterbox;
   - tracciamento del pericolo per gli attacchi dei boss (allarme + SCHIVATO!).
   Usa le globali di game.js (cam, CELL, player, worldEl, playerEl, stage,
   cellEls) solo dentro le funzioni, quindi può essere caricato prima.
   ============================================================ */
(function () {
    const PX = 3;
    const INK = "#1a1c2c";
    const WHITE = "#f4f4f4";
    const YELLOW = "#ffcd75";
    const RED = "#e43b44";
    const DIGIT = [null, "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#6366f1", "#a855f7", "#ec4899"];
    const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const MOTION = REDUCED ? 0.25 : 1;

    const sfx = (name, opts) => window.SFX && SFX.play(name, opts);
    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const gameReady = () => typeof cam !== "undefined" && typeof CELL !== "undefined" && typeof player !== "undefined";
    // Tema classico (theme.js): stessi effetti, ma morbidi e senza contorni pixel
    const classic = () => document.documentElement.dataset.theme === "classic";
    const SMOKE = "rgba(15, 23, 42, .45)";

    /* ---------------- DOM ---------------- */
    const canvas = document.createElement("canvas");
    canvas.id = "fxCanvas";
    const g = canvas.getContext("2d");

    const layer = document.createElement("div");
    layer.id = "fxLayer";

    const flashEl = document.createElement("div");
    flashEl.id = "fxFlash";

    const letterbox = document.createElement("div");
    letterbox.id = "fxLetterbox";
    letterbox.innerHTML = "<i></i><i></i>";

    const dangerEl = document.createElement("div");
    dangerEl.id = "fxDanger";

    const comboEl = document.createElement("div");
    comboEl.id = "fxCombo";
    comboEl.innerHTML = `<div class="cnum">x<b>0</b></div><div class="clbl">COMBO</div><div class="ctime"><i></i></div>`;

    document.body.append(canvas, dangerEl, layer, flashEl, letterbox, comboEl);
    window.SFX?.bindToggle(document.getElementById("sfxBtn"));

    let W = 0, H = 0;
    function resize() {
        W = Math.ceil(innerWidth / PX);
        H = Math.ceil(innerHeight / PX);
        canvas.width = W;
        canvas.height = H;
    }
    resize();
    addEventListener("resize", resize);

    // coordinate mondo (in celle) -> pixel del canvas
    const toC = (wx, wy) => [
        Math.round((wx - cam.x) * CELL / PX + W / 2),
        Math.round((wy - cam.y) * CELL / PX + H / 2)
    ];
    const onScreen = (cx, cy, pad = 2) => {
        const hw = innerWidth / 2 / CELL + pad, hh = innerHeight / 2 / CELL + pad;
        return Math.abs(cx + 0.5 - cam.x) < hw && Math.abs(cy + 0.5 - cam.y) < hh;
    };

    /* ---------------- tempo: hit-stop & slow-motion ---------------- */
    let freezeUntil = 0, slowUntil = 0;
    function hitstop(ms) { freezeUntil = Math.max(freezeUntil, performance.now() + ms); }
    function slowmo(ms) {
        slowUntil = Math.max(slowUntil, performance.now() + ms);
        document.body.classList.add("fx-slowmo");
        clearTimeout(slowmo.t);
        slowmo.t = setTimeout(() => document.body.classList.remove("fx-slowmo"), ms);
    }

    /* ---------------- shake & zoom ---------------- */
    let trauma = 0, punch = 0, camDirty = false;
    function shake(amount) { trauma = Math.min(1, trauma + amount * MOTION); }
    function zoomPunch(amount) { punch = Math.min(0.12, punch + amount * MOTION); }
    function updateCamera(dt) {
        trauma = Math.max(0, trauma - dt * 1.8);
        punch *= Math.exp(-dt * 9);
        const targets = [canvas, typeof stage !== "undefined" ? stage : null];
        if (trauma < 0.01 && punch < 0.001) {
            if (camDirty) { targets.forEach(t => t && (t.style.transform = "")); camDirty = false; }
            return;
        }
        const s = trauma * trauma * 22;
        // offset a multipli di 2px: lo shake resta "a pixel"
        const x = Math.round(rand(-s, s) / 2) * 2;
        const y = Math.round(rand(-s, s) / 2) * 2;
        const r = trauma * trauma * rand(-1.2, 1.2);
        const tf = `translate(${x}px,${y}px) rotate(${r.toFixed(2)}deg) scale(${(1 + punch).toFixed(4)})`;
        targets.forEach(t => t && (t.style.transform = tf));
        camDirty = true;
    }

    /* ---------------- flash / letterbox ---------------- */
    function flash(color = WHITE, opacity = 0.6, dur = 220) {
        flashEl.style.background = color;
        flashEl.animate(
            [{ opacity: opacity * (REDUCED ? 0.3 : 1) }, { opacity: 0 }],
            { duration: dur, easing: classic() ? "ease-out" : "steps(4, end)" }
        );
    }

    const letterboxReasons = new Set();
    function setLetterbox(reason, on) {
        if (on) letterboxReasons.add(reason); else letterboxReasons.delete(reason);
        letterbox.classList.toggle("on", letterboxReasons.size > 0);
    }
    function letterboxFor(reason, ms) {
        setLetterbox(reason, true);
        setTimeout(() => setLetterbox(reason, false), ms);
    }

    /* ---------------- scritte DOM ---------------- */
    function banner(text, { cls = "", sub = "", dur = 1400 } = {}) {
        const b = document.createElement("div");
        b.className = "fx-banner " + cls;
        b.style.setProperty("--dur", dur + "ms");
        b.innerHTML = `<div class="t"></div>${sub ? '<div class="s"></div>' : ""}`;
        b.querySelector(".t").textContent = text;
        if (sub) b.querySelector(".s").textContent = sub;
        layer.appendChild(b);
        setTimeout(() => b.remove(), dur);
        return b;
    }

    // Testo che fluttua sopra una cella (segue la telecamera perché sta nel mondo)
    function floatText(cx, cy, text, cls = "") {
        if (typeof worldEl === "undefined") return;
        const el = document.createElement("div");
        el.className = "fx-float " + cls;
        el.textContent = text;
        el.style.left = (cx + 0.5) * CELL + "px";
        el.style.top = cy * CELL + "px";
        el.style.setProperty("--dx", rand(-14, 14).toFixed(0) + "px");
        worldEl.appendChild(el);
        setTimeout(() => el.remove(), 1100);
    }

    // Esplosione fumetto "POW!" con stella dentata
    function comicBurst(cx, cy, text, color = YELLOW) {
        if (typeof worldEl === "undefined") return;
        const el = document.createElement("div");
        el.className = "fx-burst";
        el.style.left = (cx + 0.5) * CELL + "px";
        el.style.top = (cy + 0.5) * CELL + "px";
        el.style.setProperty("--burst", color);
        el.style.setProperty("--rot", rand(-14, 14).toFixed(0) + "deg");
        el.innerHTML = `<i class="o"></i><i class="f"></i><span></span>`;
        el.querySelector("span").textContent = text;
        worldEl.appendChild(el);
        setTimeout(() => el.remove(), 750);
    }

    // Copia sbiadita del cursore (scia / immagine residua)
    function ghost(cx, cy, cls = "") {
        if (typeof worldEl === "undefined") return;
        const el = document.createElement("div");
        el.className = "fx-ghost " + cls;
        el.style.left = cx * CELL + "px";
        el.style.top = cy * CELL + "px";
        worldEl.appendChild(el);
        setTimeout(() => el.remove(), 600);
    }

    function stampX(cx, cy) {
        if (typeof worldEl === "undefined") return;
        const el = document.createElement("div");
        el.className = "fx-x";
        el.style.left = cx * CELL + "px";
        el.style.top = cy * CELL + "px";
        worldEl.appendChild(el);
        setTimeout(() => el.remove(), 700);
    }

    function pulseClass(el, cls, ms) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth;   // riavvia l'animazione CSS
        el.classList.add(cls);
        clearTimeout(el["_fx_" + cls]);
        el["_fx_" + cls] = setTimeout(() => el.classList.remove(cls), ms);
    }

    /* ---------------- oggetti del canvas ---------------- */
    const items = [];
    const MAX_ITEMS = 1400;
    const add = o => { if (items.length < MAX_ITEMS) items.push(o); return o; };

    function burst(wx, wy, n, colors, { speed = 4, up = 0, g: grav = 9, size = [2, 4], life = [0.35, 0.7] } = {}) {
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = rand(speed * 0.35, speed);
            add({
                type: "p", x: wx, y: wy,
                vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, g: grav,
                size: Math.round(rand(size[0], size[1])),
                color: Array.isArray(colors) ? pick(colors) : colors,
                life: 0, max: rand(life[0], life[1])
            });
        }
    }

    const ring = (wx, wy, color, { r0 = 0.3, r1 = 1.4, max = 0.35, square = true, thick = 1 } = {}) =>
        add({ type: "ring", x: wx, y: wy, color, r0, r1, max, square, thick, life: 0 });

    const cellFlash = (cx, cy, color, delay = 0, max = 0.3) =>
        add({ type: "cell", cx, cy, color, life: -delay, max });

    const pillar = (wx, wy, color, max = 0.5, width = 0.8) =>
        add({ type: "pillar", x: wx, y: wy, color, max, width, life: 0 });

    const rays = (wx, wy, color, max = 1.2, n = 12) =>
        add({ type: "rays", x: wx, y: wy, color, max, n, life: 0, spin: rand(0, 6) });

    const speedLines = (max = 0.5, color = WHITE) => add({ type: "speed", max, color, life: 0 });

    function confetti(n) {
        const hw = innerWidth / 2 / CELL, hh = innerHeight / 2 / CELL;
        for (let i = 0; i < n; i++) {
            add({
                type: "p", confetti: true,
                x: cam.x + rand(-hw, hw), y: cam.y - hh - rand(0, 3),
                vx: rand(-1, 1), vy: rand(2, 5), g: 1.2,
                size: Math.round(rand(2, 4)), color: pick(DIGIT.slice(1).concat([YELLOW, WHITE])),
                life: 0, max: rand(2.2, 3.4), phase: rand(0, 6)
            });
        }
    }

    function outlinedRect(x, y, w, h, color, o = 1) {
        if (classic()) {
            // pallino sfumato, senza contorno (il canvas viene ingrandito con lo smoothing)
            g.fillStyle = color === INK ? SMOKE : color;
            g.beginPath();
            g.arc(x + w / 2, y + h / 2, Math.max(w, h) / 2 + 0.3, 0, Math.PI * 2);
            g.fill();
            return;
        }
        g.fillStyle = INK;
        g.fillRect(x - o, y - o, w + o * 2, h + o * 2);
        g.fillStyle = color;
        g.fillRect(x, y, w, h);
    }

    function strokeSquare(x, y, s, color, t) {
        if (classic()) {
            g.strokeStyle = color;
            g.lineWidth = t;
            g.globalAlpha = 0.85;
            g.beginPath();
            g.roundRect(x - s + t / 2, y - s + t / 2, s * 2 - t, s * 2 - t, Math.min(4, s / 3));
            g.stroke();
            g.globalAlpha = 1;
            return;
        }
        // quadrato vuoto con contorno scuro su entrambi i lati
        g.fillStyle = INK;
        g.fillRect(x - s - 1, y - s - 1, s * 2 + 2, t + 2);
        g.fillRect(x - s - 1, y + s - t - 1, s * 2 + 2, t + 2);
        g.fillRect(x - s - 1, y - s - 1, t + 2, s * 2 + 2);
        g.fillRect(x + s - t - 1, y - s - 1, t + 2, s * 2 + 2);
        g.fillStyle = color;
        g.fillRect(x - s, y - s, s * 2, t);
        g.fillRect(x - s, y + s - t, s * 2, t);
        g.fillRect(x - s, y - s, t, s * 2);
        g.fillRect(x + s - t, y - s, t, s * 2);
    }

    function render(dt) {
        g.clearRect(0, 0, W, H);
        const cs = CELL / PX;

        for (let i = items.length - 1; i >= 0; i--) {
            const o = items[i];
            o.life += dt;
            if (o.life >= o.max) { items.splice(i, 1); continue; }
            if (o.life < 0) continue;
            const k = o.life / o.max;

            switch (o.type) {
                case "p": {
                    o.vy += o.g * dt;
                    if (o.confetti) o.vx = Math.sin(o.life * 6 + o.phase) * 1.4;
                    o.x += o.vx * dt;
                    o.y += o.vy * dt;
                    const [x, y] = toC(o.x, o.y);
                    const s = Math.max(1, Math.ceil(o.size * (o.confetti ? 1 : 1 - k * 0.7)));
                    outlinedRect(x, y, s, o.confetti && Math.sin(o.life * 10 + o.phase) > 0 ? 1 : s, o.color);
                    break;
                }
                case "ring": {
                    const [x, y] = toC(o.x, o.y);
                    // raggio che cresce "a scatti" di 1px
                    const r = Math.round((o.r0 + (o.r1 - o.r0) * (1 - Math.pow(1 - k, 2))) * cs);
                    const t = Math.max(1, Math.round(o.thick * (1 - k) * 2));
                    if (o.square) strokeSquare(x, y, r, o.color, t);
                    else if (classic()) {
                        g.strokeStyle = o.color;
                        g.lineWidth = t;
                        g.globalAlpha = 1 - k * 0.6;
                        g.beginPath();
                        g.arc(x, y, r, 0, Math.PI * 2);
                        g.stroke();
                        g.globalAlpha = 1;
                    } else {
                        const steps = Math.max(16, r * 4);
                        for (let pass = 0; pass < 2; pass++) {
                            g.fillStyle = pass ? o.color : INK;
                            const pad = pass ? 0 : 1;
                            for (let a = 0; a < steps; a++) {
                                const ang = a / steps * Math.PI * 2;
                                g.fillRect(Math.round(x + Math.cos(ang) * r) - pad, Math.round(y + Math.sin(ang) * r) - pad, t + pad * 2, t + pad * 2);
                            }
                        }
                    }
                    break;
                }
                case "cell": {
                    const [x, y] = toC(o.cx, o.cy);
                    const inset = Math.floor(k * cs / 2);
                    const s = Math.round(cs) - inset * 2;
                    if (s > 0 && classic()) {
                        g.fillStyle = o.color;
                        g.globalAlpha = 0.55 * (1 - k);
                        g.beginPath();
                        g.roundRect(x + inset, y + inset, s, s, 2);
                        g.fill();
                        g.globalAlpha = 1;
                    } else if (s > 0) outlinedRect(x + inset, y + inset, s, s, o.color);
                    break;
                }
                case "pillar": {
                    const [x, y] = toC(o.x, o.y);
                    const w = Math.max(1, Math.round(o.width * cs * (1 - k)));
                    if (classic()) {
                        // colonna di luce sfumata ai lati
                        const lg = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
                        lg.addColorStop(0, "rgba(255,255,255,0)");
                        lg.addColorStop(0.5, o.color);
                        lg.addColorStop(1, "rgba(255,255,255,0)");
                        g.fillStyle = lg;
                        g.globalAlpha = 0.8;
                        g.fillRect(x - w / 2, 0, w, y);
                        g.globalAlpha = 1;
                        break;
                    }
                    outlinedRect(x - Math.floor(w / 2), 0, w, y, o.color);
                    outlinedRect(x - Math.floor(w / 4), 0, Math.max(1, Math.floor(w / 2)), y, WHITE, 0);
                    break;
                }
                case "rays": {
                    const [x, y] = toC(o.x, o.y);
                    const R = Math.max(W, H);
                    const a0 = o.spin + o.life * 0.8;
                    g.globalAlpha = k < 0.15 ? k / 0.15 : (1 - k) / 0.85;
                    g.fillStyle = o.color;
                    for (let n = 0; n < o.n; n++) {
                        const a = a0 + n / o.n * Math.PI * 2;
                        const da = Math.PI / o.n * 0.5;
                        g.beginPath();
                        g.moveTo(x, y);
                        g.lineTo(x + Math.cos(a - da) * R, y + Math.sin(a - da) * R);
                        g.lineTo(x + Math.cos(a + da) * R, y + Math.sin(a + da) * R);
                        g.fill();
                    }
                    g.globalAlpha = 1;
                    break;
                }
                case "speed": {
                    const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
                    g.globalAlpha = 1 - k;
                    for (let n = 0; n < 34; n++) {
                        const a = Math.random() * Math.PI * 2;
                        const r0 = R * rand(0.45, 0.75);
                        if (classic() && !(n % 3)) continue;
                        g.strokeStyle = n % 3 ? o.color : INK;
                        g.lineWidth = n % 3 ? 1 : 2;
                        g.beginPath();
                        g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
                        g.lineTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
                        g.stroke();
                    }
                    g.globalAlpha = 1;
                    break;
                }
            }
        }
    }

    /* ---------------- COMBO ---------------- */
    const COMBO_WINDOW = 4000;
    let combo = 0, comboAt = 0;
    function comboHit(now) {
        combo = now - comboAt < COMBO_WINDOW ? combo + 1 : 1;
        comboAt = now;
        if (combo >= 2) {
            comboEl.querySelector("b").textContent = combo;
            comboEl.classList.add("on");
            comboEl.classList.toggle("hot", combo >= 5);
            comboEl.classList.toggle("fire", combo >= 10);
            pulseClass(comboEl, "pop", 200);
            const bar = comboEl.querySelector(".ctime i");
            bar.style.transition = "none";
            bar.style.width = "100%";
            void bar.offsetWidth;
            bar.style.transition = `width ${COMBO_WINDOW}ms linear`;
            bar.style.width = "0%";
        }
        return combo;
    }
    function comboBreak(show) {
        if (show && combo >= 3) banner("COMBO PERSA", { cls: "small bad", dur: 1000 });
        combo = 0;
        comboEl.classList.remove("on", "hot", "fire");
    }

    /* ---------------- PERICOLO (attacchi boss) ---------------- */
    const teles = new Set();
    let dangerTele = null, lastBeep = 0, alertEl = null;

    function updateDanger(now) {
        let danger = null;
        if (gameReady() && teles.size) {
            const k = player.x + "," + player.y;
            for (const t of teles) {
                if (t.keys.has(k)) {
                    t.wasInDanger = true;
                    t.lastDanger = now;
                    t.lastCell = { x: player.x, y: player.y };
                    if (!danger || t.end < danger.end) danger = t;
                }
            }
        }

        if (danger !== dangerTele) {
            dangerTele = danger;
            document.body.classList.toggle("fx-danger", !!danger);
            setLetterbox("danger", !!danger);
            if (danger && typeof playerEl !== "undefined") {
                if (!alertEl) {
                    alertEl = document.createElement("div");
                    alertEl.className = "fx-alert";
                    alertEl.textContent = "!";
                }
                // con il Parry (classe 7) l'avviso ricorda di premere Spazio
                alertEl.textContent = window.Abilities?.key() === "7a" ? "PARA!" : "!";
                alertEl.classList.toggle("wide", alertEl.textContent.length > 1);
                playerEl.appendChild(alertEl);
                zoomPunch(0.03);
            } else if (alertEl) {
                alertEl.remove();
            }
        }

        if (danger) {
            // allarme che accelera mentre il colpo si avvicina
            const remaining = Math.max(0, danger.end - now);
            const p = 1 - remaining / danger.dur;
            const every = Math.max(70, remaining / 5);
            if (now - lastBeep > every) {
                lastBeep = now;
                sfx("alarm", { pitch: 1 + p * 0.7 });
                zoomPunch(0.006 + p * 0.01);
            }
            dangerEl.style.setProperty("--p", p.toFixed(2));
        }
    }

    function dodge(t) {
        const now = performance.now();
        const perfect = now - t.lastDanger < 320;
        slowmo(perfect ? 700 : 480);
        speedLines(0.55);
        flash(perfect ? YELLOW : WHITE, 0.35, 260);
        zoomPunch(0.05);
        if (t.lastCell) {
            ghost(t.lastCell.x, t.lastCell.y, "dodge");
            setTimeout(() => ghost(t.lastCell.x, t.lastCell.y, "dodge"), 90);
        }
        sfx("dodge");
        banner(perfect ? "SCHIVATA PERFETTA!" : "SCHIVATO!", { cls: perfect ? "gold" : "cyan", dur: 1300 });
        if (gameReady()) {
            burst(player.x + 0.5, player.y + 0.5, 14, [WHITE, "#73eff7"], { speed: 6, g: 0 });
            floatText(player.x, player.y, perfect ? "PERFECT" : "MISS", "dodge");
        }
    }

    /* ---------------- LOOP ---------------- */
    let last = performance.now();
    function loop(now) {
        requestAnimationFrame(loop);
        const real = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!gameReady()) return;

        let dt = real;
        if (now < freezeUntil) dt = 0;
        else if (now < slowUntil) dt *= 0.3;

        updateCamera(real);
        updateDanger(now);
        if (combo && now - comboAt > COMBO_WINDOW) comboBreak(false);
        if (items.length || render.dirty) {
            render(dt);
            render.dirty = items.length > 0;
        }
    }
    requestAnimationFrame(loop);

    const center = (cx, cy) => [cx + 0.5, cy + 0.5];
    let clearPending = 0, clearTimer = null, lvlBanner = null;

    /* ============================================================
       API PUBBLICA
       ============================================================ */
    window.FX = {
        shake, zoomPunch, flash, banner, floatText, hitstop, slowmo,

        // Numero corretto inserito
        numberPlaced(cx, cy, d, el, rewarded = true) {
            const now = performance.now();
            const c = comboHit(now);
            const col = DIGIT[d] || YELLOW;
            const [wx, wy] = center(cx, cy);
            const heat = Math.min(c, 15);

            cellFlash(cx, cy, WHITE, 0, 0.18);
            ring(wx, wy, col, { r0: 0.45, r1: 1.3 + heat * 0.06, max: 0.32, thick: 1.5 });
            if (c >= 5) ring(wx, wy, YELLOW, { r0: 0.5, r1: 2.2, max: 0.45, square: false });
            burst(wx, wy, 10 + heat * 2, [col, WHITE, col], { speed: 4 + heat * 0.25, up: 1.5 });
            // 4 scintille a croce lungo riga e colonna: richiama le regole del sudoku
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => add({
                type: "p", x: wx, y: wy, vx: dx * 9, vy: dy * 9, g: 0, size: 3, color: col, life: 0, max: 0.28
            }));

            if (el) {
                el.animate([
                    { transform: "scale(.2) rotate(-12deg)" },
                    { transform: "scale(1.55) rotate(6deg)", offset: 0.45 },
                    { transform: "scale(.9) rotate(0)", offset: 0.75 },
                    { transform: "scale(1)" }
                ], { duration: 340, easing: classic() ? "ease-out" : "steps(8, end)" });
            }

            // nessun "+5 XP" se la cella era già stata premiata (numero riscritto dopo un attacco)
            if (rewarded) floatText(cx, cy, "+5 XP", "xp");
            zoomPunch(0.01 + heat * 0.002);
            if (c >= 5) shake(0.12 + heat * 0.01);
            sfx("place", { pitch: 1 + Math.min(c - 1, 12) * 0.06 });

            if (c === 3 || c === 5 || c === 10 || (c > 10 && c % 5 === 0)) {
                const word = c >= 15 ? "INARRESTABILE!" : c >= 10 ? "IN FIAMME!" : c >= 5 ? "FANTASTICO!" : "BENE!";
                banner(`COMBO x${c}`, { cls: c >= 10 ? "fire" : c >= 5 ? "gold" : "small", sub: word, dur: 1100 });
                if (c >= 10) { flash(YELLOW, 0.25, 200); speedLines(0.4, YELLOW); }
                sfx("confirm");
            }
        },

        // Numero inserito da un altro giocatore: effetto discreto
        remoteNumber(cx, cy, color) {
            if (!gameReady() || !onScreen(cx, cy)) return;
            const [wx, wy] = center(cx, cy);
            ring(wx, wy, color || "#7dd3fc", { r0: 0.4, r1: 1, max: 0.3 });
            burst(wx, wy, 6, color || "#7dd3fc", { speed: 2.5 });
        },

        // Numero sbagliato
        wrong(cx, cy, dmg) {
            const [wx, wy] = center(cx, cy);
            stampX(cx, cy);
            cellFlash(cx, cy, RED, 0, 0.25);
            burst(wx, wy, 16, [RED, "#ff8a8a", INK], { speed: 5, up: 2 });
            floatText(cx, cy, `-${dmg} HP`, "dmg");
            shake(0.45);
            zoomPunch(0.02);
            hitstop(60);
            flash(RED, 0.3, 240);
            pulseClass(document.getElementById("hud"), "fx-hud-hit", 400);
            pulseClass(typeof playerEl !== "undefined" ? playerEl : null, "fx-hurt", 450);
            sfx("wrong");
            comboBreak(true);
        },

        step(fromX, fromY, dx, dy) {
            // sbuffo di polvere dietro al cursore
            const wx = fromX + 0.5 - dx * 0.2, wy = fromY + 0.5 - dy * 0.2;
            for (let i = 0; i < 3; i++) add({
                type: "p", x: wx + rand(-0.15, 0.15), y: wy + rand(-0.15, 0.15),
                vx: -dx * rand(0.5, 1.5) + rand(-0.4, 0.4), vy: -dy * rand(0.5, 1.5) + rand(-0.4, 0.4),
                g: 0, size: 2, color: "#94b0c2", life: 0, max: 0.25
            });
            sfx("move");
        },

        // Spostato dal server: spinto da un altro giocatore o teletrasportato nel party
        forcedMove(from, x, y, reason, by) {
            if (!gameReady()) return;
            if (reason === "push") {
                ghost(from.x, from.y);
                burst(x + 0.5, y + 0.5, 8, "#94b0c2", { speed: 3, g: 0 });
                floatText(x, y, "SPINTO!", "dodge");
                shake(0.18);
                sfx("bump");
            } else if (reason === "party") {
                ghost(from.x, from.y, "dodge");
                pillar(x + 0.5, y + 1, "#73eff7", 0.5, 0.9);
                ring(x + 0.5, y + 0.5, "#73eff7", { r0: 0.3, r1: 1.8, max: 0.4, thick: 1.5 });
                burst(x + 0.5, y + 0.5, 18, ["#73eff7", WHITE], { speed: 5, up: 2 });
                flash("#73eff7", 0.25, 220);
                banner("TELETRASPORTO", { cls: "small cyan", sub: by ? "ACCANTO A " + by.toUpperCase() : "", dur: 1200 });
                sfx("dash");
            }
        },

        // Hai spinto un altro giocatore
        pushedOther() {
            if (!gameReady()) return;
            zoomPunch(0.015);
            shake(0.1);
            sfx("bump");
        },

        bump() {
            if (!gameReady()) return;
            burst(player.x + 0.5, player.y + 0.5, 4, "#94b0c2", { speed: 2, g: 0, size: [1, 2], life: [0.15, 0.25] });
            shake(0.08);
            sfx("bump");
        },

        // Salto sulla cella adiacente che contiene la cifra premuta
        dash(fromX, fromY, toX, toY) {
            ghost(fromX, fromY);
            const [wx, wy] = center(fromX, fromY);
            const dx = toX - fromX, dy = toY - fromY;
            for (let i = 0; i < 8; i++) add({
                type: "p", x: wx + dx * i / 8, y: wy + dy * i / 8, vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5),
                g: 0, size: 2, color: i % 2 ? "#73eff7" : WHITE, life: 0, max: 0.3
            });
            zoomPunch(0.01);
            sfx("dash");
        },

        // Riga / colonna / box completati: più unità nello stesso istante = bonus
        unitClear(type, cells) {
            const col = type === "row" ? "#73eff7" : type === "col" ? "#a7f070" : YELLOW;
            cells.forEach(([cx, cy], i) => {
                cellFlash(cx, cy, col, i * 0.035, 0.32);
                setTimeout(() => {
                    if (gameReady()) burst(cx + 0.5, cy + 0.5, 4, [col, WHITE], { speed: 3, up: 3 });
                }, i * 35);
            });
            clearPending++;
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => {
                const n = clearPending;
                clearPending = 0;
                const label = n >= 3 ? "TRIPLA LINEA!" : n === 2 ? "DOPPIA LINEA!" :
                    type === "row" ? "RIGA!" : type === "col" ? "COLONNA!" : "BLOCCO 3×3!";
                banner(label, { cls: n >= 2 ? "gold" : "small cyan", dur: 1100 });
                shake(0.2 + n * 0.1);
                zoomPunch(0.02 * n);
                sfx("clear");
                if (n >= 2) speedLines(0.4, col);
            }, 20);
        },

        // Finestra 9x9 completata: momento "cinematico"
        sudokuComplete() {
            if (!gameReady()) return;
            const wx = player.x + 0.5, wy = player.y + 0.5;
            letterboxFor("win", 2600);
            hitstop(140);
            flash(WHITE, 0.7, 380);
            shake(0.6);
            zoomPunch(0.08);
            rays(cam.x, cam.y, "rgba(255,205,117,.55)", 2.4, 14);
            ring(wx, wy, YELLOW, { r0: 0.5, r1: 9, max: 0.9, thick: 2 });
            ring(wx, wy, WHITE, { r0: 0.5, r1: 6, max: 0.7, square: false, thick: 2 });
            confetti(160);
            banner("SUDOKU!", { cls: "mega", sub: "FINESTRA COMPLETATA", dur: 2400 });
            sfx("fanfare");
        },

        levelUp(level) {
            if (!gameReady()) return;
            const wx = player.x + 0.5, wy = player.y + 0.5;
            pillar(wx, wy + 0.5, YELLOW, 0.9, 1.1);
            for (let i = 0; i < 3; i++) ring(wx, wy, i % 2 ? WHITE : YELLOW, { r0: 0.4, r1: 2 + i, max: 0.5 + i * 0.15, thick: 1.5 });
            for (let i = 0; i < 24; i++) add({
                type: "p", x: wx + rand(-0.6, 0.6), y: wy + rand(-0.2, 0.4), vx: rand(-0.3, 0.3), vy: rand(-6, -2),
                g: 0, size: 2, color: pick([YELLOW, WHITE, "#a7f070"]), life: 0, max: rand(0.5, 1)
            });
            flash(YELLOW, 0.35, 300);
            zoomPunch(0.04);
            if (lvlBanner?.isConnected) lvlBanner.querySelector(".s").textContent = "LIVELLO " + level;
            else lvlBanner = banner("LEVEL UP!", { cls: "gold", sub: "LIVELLO " + level, dur: 1700 });
            pulseClass(document.getElementById("hud"), "fx-hud-lvl", 900);
            sfx("levelup");
        },

        ko() {
            flash(RED, 0.55, 500);
            shake(0.7);
            hitstop(200);
            letterboxFor("ko", 1600);
            banner("K.O.", { cls: "mega bad", sub: "RIPOSO E RINASCITA", dur: 1700 });
            pulseClass(document.body, "fx-ko", 1200);
            sfx("ko");
            comboBreak(false);
        },

        /* ----- boss ----- */

        // Inizio preavviso: restituisce un handle da passare a strike()
        telegraph(cells, ms) {
            const now = performance.now();
            const t = { keys: new Set(cells.map(c => c.x + "," + c.y)), cells, start: now, end: now + ms, dur: ms, wasInDanger: false, lastDanger: 0, lastCell: null };
            teles.add(t);
            if (gameReady() && cells.some(c => onScreen(c.x, c.y))) {
                cells.forEach((c, i) => cellFlash(c.x, c.y, RED, i * 0.012, 0.2));
                sfx("alarm", { pitch: 0.7 });
            }
            return t;
        },

        // Il colpo cade: detriti sulle celle, e se ti eri salvato -> SCHIVATO!
        strike(t, hit) {
            if (!t) return;
            teles.delete(t);
            if (!gameReady()) return;
            const visible = t.cells.filter(c => onScreen(c.x, c.y));
            if (visible.length) {
                visible.forEach((c, i) => {
                    const [wx, wy] = center(c.x, c.y);
                    if (i % 2 === 0) pillar(wx, wy + 0.5, "#ff6b6b", 0.22, 0.7);
                    cellFlash(c.x, c.y, WHITE, 0, 0.15);
                    burst(wx, wy, 5, [RED, "#ffb35c", INK], { speed: 4, up: 3 });
                    // numero scritto che sta per essere distrutto: va in frantumi
                    const el = typeof cellEls !== "undefined" && cellEls.get(c.x + "," + c.y);
                    if (el && !el.classList.contains("given")) {
                        burst(wx, wy, 10, [getComputedStyle(el).color, WHITE], { speed: 5, up: 4, size: [2, 3] });
                    }
                });
                shake(hit ? 0.3 : 0.4);
                sfx("strike");
            }
            if (!hit && t.wasInDanger) dodge(t);
        },

        playerHit(dmg) {
            if (!gameReady()) return;
            const cx = player.x, cy = player.y;
            const [wx, wy] = center(cx, cy);
            hitstop(110);
            flash(WHITE, 0.6, 90);
            setTimeout(() => flash(RED, 0.45, 380), 90);
            shake(0.85);
            zoomPunch(0.07);
            comicBurst(cx, cy, pick(["BAM!", "POW!", "OUCH!", "CRASH!"]));
            floatText(cx, cy, `-${dmg}`, "dmg big");
            burst(wx, wy, 26, [RED, "#ff8a8a", YELLOW, INK], { speed: 7, up: 3 });
            ring(wx, wy, RED, { r0: 0.4, r1: 2.5, max: 0.4, square: false, thick: 2 });
            pulseClass(document.getElementById("hud"), "fx-hud-hit", 500);
            pulseClass(typeof playerEl !== "undefined" ? playerEl : null, "fx-hurt", 700);
            sfx("hit");
            comboBreak(true);
        },

        bossWarning(name) {
            const w = document.createElement("div");
            w.className = "fx-warning";
            w.innerHTML = `<div class="tape"></div><div class="mid"><b>! WARNING !</b><span></span></div><div class="tape"></div>`;
            w.querySelector("span").textContent = name;
            layer.appendChild(w);
            setTimeout(() => w.remove(), 2600);
            shake(0.25);
            sfx("warning");
        },

        bossIntro(boss) {
            const v = document.createElement("div");
            v.className = "fx-vs";
            v.innerHTML = `<div class="side you"></div><div class="vs">VS</div><div class="side boss"></div>`;
            v.querySelector(".you").textContent = (typeof myName !== "undefined" && myName) || "TU";
            v.querySelector(".boss").textContent = boss.name;
            layer.appendChild(v);
            setTimeout(() => v.remove(), 2000);
            letterboxFor("vs", 2000);
            setTimeout(() => { flash(WHITE, 0.5, 200); shake(0.5); zoomPunch(0.05); speedLines(0.5); sfx("vs"); }, 260);
        },

        bossHurt(amount) {
            const hud = document.getElementById("boss-hud-container");
            pulseClass(hud, "fx-boss-hurt", 400);
            shake(Math.min(0.5, 0.15 + amount / 1000));
        },

        // Danno inflitto al boss (abilità, righe completate...): numero sopra l'arena
        bossDamage(boss, amount, source) {
            if (!gameReady() || !(amount > 0)) return;
            const cx = boss.bx * 3 + 3 + Math.floor(Math.random() * 3), cy = boss.by * 3 + 3 + Math.floor(Math.random() * 3);
            floatText(cx, cy, `-${amount}`, "bossdmg" + (amount >= 50 ? " big" : ""));
            if (amount >= 20) burst(cx + 0.5, cy + 0.5, 8, [YELLOW, WHITE, RED], { speed: 4, up: 2 });
        },

        bossStunned(boss, by, inside) {
            if (!gameReady()) return;
            const cx = boss.bx * 3 + 4.5, cy = boss.by * 3 + 4.5;
            ring(cx, cy, "#73eff7", { r0: 1, r1: 6, max: 0.6, thick: 2 });
            burst(cx, cy, 30, ["#73eff7", WHITE, "#41a6f6"], { speed: 6, g: 0 });
            if (inside) {
                flash("#73eff7", 0.35, 300);
                zoomPunch(0.04);
                banner("CONGELATO!", { cls: "cyan", sub: by ? "DA " + by.toUpperCase() : "", dur: 1300 });
            }
            sfx("dodge");
        },

        shieldGained(amount) {
            if (!gameReady()) return;
            ring(player.x + 0.5, player.y + 0.5, "#f27ab3", { r0: 0.4, r1: 1.6, max: 0.4, square: false, thick: 2 });
            floatText(player.x, player.y, `SCUDO +${amount}`, "shield");
            sfx("confirm");
        },

        healed(amount, from) {
            if (!gameReady()) return;
            floatText(player.x, player.y, `+${amount} HP`, "heal");
            burst(player.x + 0.5, player.y + 0.5, 10, ["#38b764", "#a7f070", WHITE], { speed: 3, up: 3, g: -2 });
        },

        // Abilità usate da un giocatore (mine = da te)
        abilityFx(msg, mine) {
            if (!gameReady()) return;
            if (msg.kind === "jump" || msg.kind === "blink" || msg.kind === "portal") {
                const col = msg.kind === "portal" ? "#b55ed6" : msg.kind === "blink" ? "#14b8a6" : "#b55ed6";
                ghost(msg.from.x, msg.from.y, "dodge");
                ring(msg.from.x + 0.5, msg.from.y + 0.5, col, { r0: 0.6, r1: 0.1, max: 0.25, thick: 2 });
                ring(msg.to.x + 0.5, msg.to.y + 0.5, col, { r0: 0.2, r1: 1.6, max: 0.35, thick: 2 });
                burst(msg.to.x + 0.5, msg.to.y + 0.5, 14, [col, WHITE], { speed: 4, g: 0 });
                if (mine) { zoomPunch(0.03); sfx("dash"); }
                return;
            }
            if (msg.kind === "heal") {
                msg.cells.forEach((c, i) => setTimeout(() => {
                    pillar(c.x + 0.5, c.y + 1, "#38b764", 0.35, 0.8);
                    burst(c.x + 0.5, c.y + 0.5, 12, ["#38b764", "#a7f070", WHITE], { speed: 4, up: 3 });
                }, i * 70));
                if (mine) { banner("CURA!", { cls: "small", sub: `${msg.cells.length} NUMERI`, dur: 1000 }); sfx("levelup"); }
                return;
            }
            if (msg.kind === "parry") {
                ring(msg.x + 0.5, msg.y + 0.5, WHITE, { r0: 0.3, r1: 3, max: 0.4, square: false, thick: 3 });
                burst(msg.x + 0.5, msg.y + 0.5, 30, [WHITE, YELLOW, "#73eff7"], { speed: 8, g: 0 });
                if (mine) {
                    hitstop(140);
                    flash(WHITE, 0.6, 200);
                    shake(0.5);
                    speedLines(0.5, YELLOW);
                    banner("PARRY!", { cls: "gold", sub: "COLPO RISPEDITO", dur: 1200 });
                    sfx("dodge");
                }
                return;
            }
            if (msg.kind === "counter") {
                const r = msg.rect;
                for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) cellFlash(x, y, YELLOW, ((x - r.x0) + (y - r.y0)) * 0.02, 0.35);
                if (mine) { banner("CONTRATTACCO!", { cls: "gold", dur: 1100 }); shake(0.4); sfx("boom"); }
                return;
            }
            if (msg.kind === "fury") {
                burst(msg.x + 0.5, msg.y + 0.5, 24, [RED, "#ff8a8a", YELLOW], { speed: 6, up: 2 });
                ring(msg.x + 0.5, msg.y + 0.5, RED, { r0: 0.4, r1: 2.2, max: 0.4, thick: 2 });
                if (mine) {
                    flash(RED, 0.3, 250);
                    shake(0.3);
                    banner("FURIA!", { cls: "bad", dur: 1000 });
                    sfx("hit");
                }
            } else if (msg.kind === "sacrifice") {
                msg.cells.forEach((c, i) => setTimeout(() => {
                    pillar(c.x + 0.5, c.y + 1, "#ef7d57", 0.35, 0.8);
                    burst(c.x + 0.5, c.y + 0.5, 14, ["#ef7d57", YELLOW, RED], { speed: 6, up: 3 });
                    ring(c.x + 0.5, c.y + 0.5, "#ef7d57", { r0: 0.3, r1: 1.4, max: 0.3, thick: 1.5 });
                    if (mine) shake(0.15);
                }, i * 70));
                if (mine) { banner("SACRIFICIO!", { cls: "gold", sub: `${msg.cells.length} NUMERI`, dur: 1100 }); sfx("boom"); }
            } else if (msg.kind === "release") {
                ring(msg.x + 0.5, msg.y + 0.5, YELLOW, { r0: 0.5, r1: 7, max: 0.7, thick: 3 });
                burst(msg.x + 0.5, msg.y + 0.5, 40, [YELLOW, "#ef7d57", WHITE], { speed: 8, up: 2 });
                if (mine) {
                    hitstop(100);
                    flash(YELLOW, 0.4, 300);
                    shake(0.6);
                    speedLines(0.5, YELLOW);
                    banner("RILASCIO!", { cls: "gold", sub: `${msg.amount} DANNI`, dur: 1200 });
                    sfx("boom");
                }
            }
        },

        bossDefeated(boss) {
            if (!gameReady()) return;
            const x0 = boss.bx * 3, y0 = boss.by * 3;
            letterboxFor("bossdown", 2600);
            for (let i = 0; i < 12; i++) {
                setTimeout(() => {
                    const cx = x0 + Math.floor(Math.random() * 9), cy = y0 + Math.floor(Math.random() * 9);
                    const [wx, wy] = center(cx, cy);
                    ring(wx, wy, pick([YELLOW, "#ef7d57", WHITE]), { r0: 0.2, r1: rand(1, 2.4), max: 0.35, square: false, thick: 2 });
                    burst(wx, wy, 14, [YELLOW, "#ef7d57", RED, INK], { speed: 6, up: 2 });
                    shake(0.3);
                    if (i % 3 === 0) sfx("strike");
                }, i * 90);
            }
            setTimeout(() => {
                hitstop(160);
                flash(WHITE, 0.75, 450);
                shake(1);
                zoomPunch(0.1);
                rays(x0 + 4.5, y0 + 4.5, "rgba(255,205,117,.5)", 2.4, 16);
                ring(x0 + 4.5, y0 + 4.5, WHITE, { r0: 1, r1: 12, max: 0.8, thick: 3 });
                confetti(180);
                banner("BOSS SCONFITTO!", { cls: "mega long", sub: boss.name, dur: 2400 });
                sfx("boom");
                setTimeout(() => sfx("fanfare"), 300);
            }, 1100);
        },

        trialFailed() {
            flash(RED, 0.4, 400);
            shake(0.4);
            banner("PROVA FALLITA", { cls: "bad", dur: 1600 });
            sfx("ko");
        }
    };
})();
