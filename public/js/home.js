/* ============================================================
   HOME — schermata titolo in pixel art
   ============================================================ */
const PAL = {
    ink: "#1a1c2c", night: "#29366f", deep: "#333c57", slate: "#566c86", mist: "#94b0c2",
    white: "#f4f4f4", yellow: "#ffcd75", orange: "#ef7d57", red: "#b13e53", plum: "#5d275d",
    lime: "#a7f070", green: "#38b764", teal: "#257179", blue: "#3b5dc9", sky: "#41a6f6", cyan: "#73eff7"
};
// Un colore per ogni cifra (stessa idea della palette numeri del gioco)
const DIGIT_COLORS = [null, PAL.red, PAL.orange, PAL.yellow, PAL.lime, PAL.cyan, PAL.sky, PAL.blue, "#b55ed6", "#f27ab3"];

// Font pixel 3x5 per le cifre disegnate sui canvas
const DIGITS = {
    1: [".#.", "##.", ".#.", ".#.", "###"], 2: ["##.", "..#", ".#.", "#..", "###"],
    3: ["##.", "..#", ".#.", "..#", "##."], 4: ["#.#", "#.#", "###", "..#", "..#"],
    5: ["###", "#..", "##.", "..#", "##."], 6: [".##", "#..", "###", "#.#", "###"],
    7: ["###", "..#", ".#.", ".#.", ".#."], 8: ["###", "#.#", "###", "#.#", "###"],
    9: ["###", "#.#", "###", "..#", "##."]
};

// Icone 10x10 (lettere = chiavi di colore)
const ICONS = {
    trophy: {
        map: ["kkkkkkkkkk", "kykwyyokyk", "kykwyyokyk", "kkkyyyokkk", "..kyyyok..", "...kyok...", "...kook...", "..kkookk..", ".kooooook.", ".kkkkkkkk."],
        col: { k: PAL.ink, y: PAL.yellow, o: PAL.orange, w: PAL.white }
    },
    tile: {
        map: ["kkkkkkkkkk", "kwwwwwwwwk", "kwwwbbwwwk", "kwwbbbwwwk", "kwwwbbwwwk", "kwwwbbwwwk", "kwwwbbwwwk", "kwwbbbbwwk", "kmmmmmmmmk", "kkkkkkkkkk"],
        col: { k: PAL.ink, w: PAL.white, b: PAL.blue, m: PAL.mist }
    },
    skull: {
        map: [".kkkkkkkk.", "kwwwwwwwwk", "kwwwwwwwwk", "kwkkwwkkwk", "kwkkwwkkwk", "kwwwkkwwwk", ".kwwwwwwk.", "..kwkkwk..", "..kkkkkk..", ".........."],
        col: { k: PAL.ink, w: PAL.white }
    },
    sword: {
        map: ["........kk", ".......kwk", "......kwk.", ".....kwk..", ".kk.kwk...", ".kykwk....", "..kyk.....", ".kokyk....", "kok.kk....", "kk........"],
        col: { k: PAL.ink, w: PAL.white, y: PAL.yellow, o: PAL.orange }
    },
    hourglass: {
        map: ["kkkkkkkkkk", ".kyyyyyyk.", ".kwyyyywk.", "..kwyywk..", "...kwwk...", "...kwwk...", "..kwwywk..", ".kwwyyywk.", ".kyyyyyyk.", "kkkkkkkkkk"],
        col: { k: PAL.ink, w: PAL.mist, y: PAL.yellow }
    },
    clock: {
        map: ["..kkkkkk..", ".kwwwwwwk.", "kwwwkwwwwk", "kwwwkwwwwk", "kwwwkkkwwk", "kwwwwwwwwk", "kwwwwwwwwk", ".kwwwwwwk.", "..kkkkkk..", ".........."],
        col: { k: PAL.ink, w: PAL.cyan }
    }
};

function drawIcon(canvas, icon) {
    const g = canvas.getContext("2d");
    icon.map.forEach((row, y) => [...row].forEach((ch, x) => {
        const c = icon.col[ch];
        if (!c) return;
        g.fillStyle = c;
        g.fillRect(x, y, 1, 1);
    }));
}

// Hash semplice di una stringa -> intero
function strHash(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function rng32(seed) {
    return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Avatar 8x8 simmetrico generato dal nome (stile "space invader")
function drawAvatar(name) {
    const c = document.getElementById("avatar");
    const g = c.getContext("2d");
    const r = rng32(strHash(name || "guest"));
    const main = DIGIT_COLORS[1 + Math.floor(r() * 9)];
    g.clearRect(0, 0, 8, 8);
    const on = [];
    for (let y = 0; y < 8; y++) {
        on[y] = [];
        for (let x = 0; x < 4; x++) {
            // più probabile pieno al centro: forma più "da personaggio"
            on[y][x] = r() < (x >= 2 ? 0.72 : 0.42);
            on[y][7 - x] = on[y][x];
        }
    }
    // occhi fissi così sembra sempre una faccina
    on[3][2] = on[3][5] = "eye";
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (!on[y][x]) continue;
        g.fillStyle = on[y][x] === "eye" ? PAL.ink : main;
        g.fillRect(x, y, 1, 1);
    }
}

/* ---------------- LOGO ---------------- */
document.querySelectorAll(".logo-line").forEach(line => {
    [...line.dataset.text].forEach((ch, i) => {
        const s = document.createElement("span");
        s.className = "ch";
        s.textContent = ch;
        s.dataset.ch = ch;
        s.style.setProperty("--i", i);
        line.appendChild(s);
    });
});

document.querySelectorAll("canvas.icon").forEach(c => drawIcon(c, ICONS[c.dataset.icon]));
drawAvatar("guest");
SFX.bindToggle(document.getElementById("sfxBtn"));

/* ---------------- SFONDO: mondo sudoku infinito ---------------- */
const bg = document.getElementById("bg");
const bgx = bg.getContext("2d");
const SCALE = 4;   // ogni pixel del canvas = 4px sullo schermo
const C = 11;      // lato di una cella in pixel-canvas
const cellHash = (x, y, s) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const solution = (x, y) => {
    const r = ((y % 9) + 9) % 9, c = ((x % 9) + 9) % 9;
    return ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
};
const isVoid = (x, y) => cellHash(Math.floor(x / 3), Math.floor(y / 3), 7) < 0.16;

let W = 0, H = 0;
function resizeBg() {
    W = Math.ceil(innerWidth / SCALE);
    H = Math.ceil(innerHeight / SCALE);
    bg.width = W; bg.height = H;
}
resizeBg();
addEventListener("resize", resizeBg);

const written = new Map();   // cifre "scritte" dai cursori fantasma
const pops = [];             // anelli di comparsa
const walkers = Array.from({ length: 4 }, (_, i) => ({
    x: 4 + i * 7, y: 3 + (i % 2) * 6, color: [PAL.yellow, PAL.cyan, PAL.lime, PAL.orange][i], t: Math.random() * 600
}));

function drawDigit(g, d, px, py, color) {
    const rows = DIGITS[d];
    // contorno: la cifra spostata in 8 direzioni
    g.fillStyle = PAL.ink;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++)
        rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "#") g.fillRect(px + x + ox, py + y + oy, 1, 1); }));
    g.fillStyle = color;
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "#") g.fillRect(px + x, py + y, 1, 1); }));
}

let last = 0, scroll = 0;
function drawBg(now) {
    requestAnimationFrame(drawBg);
    if (now - last < 1000 / 30) return;   // 30 fps: movimento più "a scatti", da pixel art
    const dt = Math.min(100, now - last);
    last = now;
    scroll += dt * 0.006;

    const ox = Math.floor(scroll), oy = Math.floor(scroll * 0.5);
    bgx.fillStyle = PAL.night;
    bgx.fillRect(0, 0, W, H);

    const x0 = Math.floor(ox / C) - 1, y0 = Math.floor(oy / C) - 1;
    const cols = Math.ceil(W / C) + 2, rows = Math.ceil(H / C) + 2;

    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const wx = x0 + i, wy = y0 + j;
        const px = wx * C - ox, py = wy * C - oy;
        if (isVoid(wx, wy)) {
            // muro: righe diagonali scure
            bgx.fillStyle = "#222a48";
            bgx.fillRect(px, py, C, C);
            bgx.fillStyle = "#1d2440";
            for (let k = 0; k < C; k += 3) bgx.fillRect(px + k, py + ((k + wx * 2) % C), 1, 1);
            continue;
        }
        bgx.fillStyle = (Math.floor(wx / 3) + Math.floor(wy / 3)) % 2 ? PAL.deep : "#2d3553";
        bgx.fillRect(px, py, C, C);
        bgx.fillStyle = "rgba(26,28,44,.55)";
        bgx.fillRect(px, py, C, 1);
        bgx.fillRect(px, py, 1, C);
        if (((wx % 3) + 3) % 3 === 0) { bgx.fillStyle = PAL.ink; bgx.fillRect(px, py, 1, C); }
        if (((wy % 3) + 3) % 3 === 0) { bgx.fillStyle = PAL.ink; bgx.fillRect(px, py, C, 1); }

        const k = wx + "," + wy;
        const given = cellHash(wx, wy, 3) < 0.34;
        if (given || written.has(k)) {
            const d = solution(wx, wy);
            const col = given ? PAL.mist : written.get(k);
            drawDigit(bgx, d, px + 4, py + 3, col);
        }
    }

    // cursori fantasma che girano e scrivono numeri
    walkers.forEach(w => {
        w.t += dt;
        if (w.t > 380) {
            w.t = 0;
            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            const [dx, dy] = dirs[Math.floor(Math.random() * 4)];
            const vx = x0 + 2, vy = y0 + 2;
            w.x = Math.max(vx, Math.min(vx + cols - 5, w.x + dx));
            w.y = Math.max(vy, Math.min(vy + rows - 5, w.y + dy));
            const k = w.x + "," + w.y;
            if (!isVoid(w.x, w.y) && cellHash(w.x, w.y, 3) >= 0.34 && !written.has(k) && Math.random() < 0.45) {
                written.set(k, w.color);
                pops.push({ x: w.x, y: w.y, color: w.color, life: 0 });
                if (written.size > 400) written.delete(written.keys().next().value);
            }
        }
        if (w.x < x0 || w.y < y0) { w.x = x0 + 4; w.y = y0 + 4; }
        const px = w.x * C - ox, py = w.y * C - oy;
        bgx.fillStyle = PAL.ink;
        bgx.strokeStyle = w.color;
        bgx.fillRect(px - 1, py - 1, C + 2, 2); bgx.fillRect(px - 1, py + C - 1, C + 2, 2);
        bgx.fillRect(px - 1, py - 1, 2, C + 2); bgx.fillRect(px + C - 1, py - 1, 2, C + 2);
        bgx.fillStyle = w.color;
        bgx.fillRect(px, py, C, 1); bgx.fillRect(px, py + C - 1, C, 1);
        bgx.fillRect(px, py, 1, C); bgx.fillRect(px + C - 1, py, 1, C);
    });

    // anelli quadrati che si espandono quando compare una cifra
    for (let i = pops.length - 1; i >= 0; i--) {
        const p = pops[i];
        p.life += dt;
        const r = Math.floor(p.life / 40);
        if (r > 8) { pops.splice(i, 1); continue; }
        const cx = p.x * C - ox + C / 2, cy = p.y * C - oy + C / 2;
        const s = C / 2 + r * 2;
        bgx.fillStyle = PAL.ink;
        bgx.fillRect(cx - s - 1, cy - s - 1, s * 2 + 2, 3);
        bgx.fillRect(cx - s - 1, cy + s - 1, s * 2 + 2, 3);
        bgx.fillRect(cx - s - 1, cy - s - 1, 3, s * 2 + 2);
        bgx.fillRect(cx + s - 1, cy - s - 1, 3, s * 2 + 2);
        bgx.fillStyle = p.color;
        bgx.fillRect(cx - s, cy - s, s * 2, 1);
        bgx.fillRect(cx - s, cy + s, s * 2, 1);
        bgx.fillRect(cx - s, cy - s, 1, s * 2);
        bgx.fillRect(cx + s, cy - s, 1, s * 2 + 1);
    }

    // vignetta a gradini per far risaltare l'interfaccia
    for (let b = 0; b < 4; b++) {
        bgx.fillStyle = `rgba(26,28,44,${0.16 + b * 0.08})`;
        const m = Math.floor((3 - b) * Math.min(W, H) * 0.06);
        bgx.fillRect(0, 0, W, m); bgx.fillRect(0, H - m, W, m);
        bgx.fillRect(0, 0, m, H); bgx.fillRect(W - m, 0, m, H);
    }
    bgx.fillStyle = "rgba(26,28,44,.35)";
    bgx.fillRect(0, 0, W, H);
}
requestAnimationFrame(drawBg);

/* ---------------- TRANSIZIONE A QUADRATI ---------------- */
const wipe = document.getElementById("wipe");
const wctx = wipe.getContext("2d");
function runWipe(closing, done) {
    const T = 32;
    wipe.width = innerWidth; wipe.height = innerHeight;
    const cols = Math.ceil(innerWidth / T), rows = Math.ceil(innerHeight / T);
    const maxD = cols + rows;
    const dur = 520;
    const t0 = performance.now();
    (function step(now) {
        const p = Math.min(1, (now - t0) / dur);
        wctx.clearRect(0, 0, wipe.width, wipe.height);
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            // ogni quadrato cresce in base alla diagonale -> effetto "onda" di pixel
            let k = p * 1.6 - (x + y) / maxD * 0.6;
            k = Math.max(0, Math.min(1, k));
            if (!closing) k = 1 - k;
            const s = Math.ceil(k * T / 4) * 4;
            if (s <= 0) continue;
            wctx.fillStyle = PAL.ink;
            wctx.fillRect(x * T + (T - s) / 2, y * T + (T - s) / 2, s, s);
        }
        if (p < 1) requestAnimationFrame(step);
        else done?.();
    })(t0);
}
runWipe(false);

/* ---------------- MENU ---------------- */
const items = [...document.querySelectorAll(".menu-item")];
let sel = 0;
function select(i, silent) {
    sel = (i + items.length) % items.length;
    items.forEach((el, k) => el.classList.toggle("is-selected", k === sel));
    if (!silent) SFX.play("select");
}
select(0, true);

let leaving = false;
function activate(el) {
    if (el.hasAttribute("data-social-open")) return Social.open(el.dataset.socialOpen);
    if (el.hasAttribute("data-leaderboard-open")) return Leaderboard.open();
    if (el.hasAttribute("data-classes-open")) return ClassesPanel.open();
    if (leaving) return;
    leaving = true;
    SFX.play(el.dataset.sfx || "confirm");
    el.classList.add("is-selected");
    runWipe(true, () => { window.location.href = el.getAttribute("href"); });
}

items.forEach((el, i) => {
    el.addEventListener("mouseenter", () => { if (sel !== i) select(i); });
    // il pannello amici gestisce il proprio click (Social.init)
    if (!["data-social-open", "data-leaderboard-open", "data-classes-open"].some(a => el.hasAttribute(a))) el.addEventListener("click", e => { e.preventDefault(); activate(el); });
});

document.addEventListener("keydown", e => {
    if (window.Social?.isOpen() || window.Leaderboard?.isOpen() || window.ClassesPanel?.isOpen() || e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === "arrowdown" || k === "s") { select(sel + 1); e.preventDefault(); }
    else if (k === "arrowup" || k === "w") { select(sel - 1); e.preventDefault(); }
    else if (k === "enter" || k === " ") { activate(items[sel]); e.preventDefault(); }
    else if (k === "c") { Social.open("search"); e.preventDefault(); }
    else if (k === "l") { Leaderboard.open(); e.preventDefault(); }
    else if (k === "g") { ClassesPanel.open("gacha"); e.preventDefault(); }
});

// Tornando indietro dalla cache del browser la tendina resterebbe chiusa
addEventListener("pageshow", e => { if (e.persisted) { leaving = false; runWipe(false); } });

/* ---------------- DATI GIOCATORE ---------------- */
function countUp(el, target) {
    target = Number(target) || 0;
    const t0 = performance.now(), dur = 900;
    (function step(now) {
        const p = Math.min(1, (now - t0) / dur);
        // a gradini, come un contatore arcade
        el.textContent = Math.round(target * Math.floor(p * 12) / 12);
        if (p < 1) requestAnimationFrame(step);
        else { el.textContent = target; el.parentElement.classList.add("bump"); }
    })(t0);
}

function formatPlayTime(sec) {
    const m = Math.floor((Number(sec) || 0) / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

const xpNeedForLevel = l => Math.round(100 * Math.pow(1.5, Math.max(1, l) - 1));

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const response = await fetch("/api/player");
        const resData = await response.json();

        if (resData.status === "success") {
            const player = resData.data;
            const name = player.username || player.name;

            document.getElementById("player-username").innerText = name;
            drawAvatar(player.playerId || name);

            const playerIdEl = document.getElementById("player-id");
            if (playerIdEl) {
                playerIdEl.innerText = player.playerId || "-";
            }

            const level = Math.max(1, Number(player.level) || 1);
            const xp = Math.max(0, Number(player.xp) || 0);
            const need = xpNeedForLevel(level);
            document.getElementById("player-level").innerText = level;
            document.getElementById("xp-text").innerText = `${xp} / ${need} XP`;
            setTimeout(() => {
                document.getElementById("xp-fill").style.width = Math.min(100, xp / need * 100) + "%";
            }, 500);

            const bonus = player.bonus || {};
            document.getElementById("player-bonus").textContent =
                `BONUS  ATK +${+(Number(bonus.atk) || 0).toFixed(1)} · HP +${+(Number(bonus.hp) || 0).toFixed(1)}`;

            const stats = player.stats || {};
            setTimeout(() => {
                countUp(document.getElementById("stat-completed"), stats.completedSudokus);
                countUp(document.getElementById("stat-placed"), stats.placedNumbers);
                countUp(document.getElementById("stat-wrong"), stats.wrongPlacements);
                countUp(document.getElementById("stat-boss"), stats.bossKills);
                countUp(document.getElementById("stat-trials"), stats.trialWins);
                const t = document.getElementById("stat-time");
                t.textContent = formatPlayTime(stats.playTimeSec);
                t.parentElement.classList.add("bump");
            }, 650);
        } else {
            window.location.href = "/login";
        }
    } catch (err) {
        console.error("Errore caricamento dati utente:", err);
    }
});
