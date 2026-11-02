/* ============================================================
   CLASSIFICHE (home) — generale e "fighters", da /api/leaderboard
   ============================================================ */
(function () {
    const TABS = {
        general: {
            label: "GENERALE",
            hint: "Ordinata per livello, poi per XP",
            cols: [
                ["LV", e => e.level || 1],
                ["XP", e => e.xp || 0],
                ["SUDOKU", e => e.completedSudokus || 0]
            ]
        },
        fighters: {
            label: "FIGHTERS",
            hint: "Ordinata per vittorie (boss + survival), poi per numeri scritti nelle arene",
            cols: [
                ["VITT.", e => (e.bossKills || 0) + (e.trialWins || 0)],
                ["BOSS", e => e.bossKills || 0],
                ["TRIAL", e => e.trialWins || 0],
                ["ARENA", e => e.arenaNumbers || 0]
            ]
        }
    };

    let tab = "general", open = false, seq = 0;

    function h(tag, attrs = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v);
        }
        for (const c of children.flat()) if (c != null && c !== false) el.append(c);
        return el;
    }

    const sfx = name => window.SFX && SFX.play(name);

    const body = h("div", { class: "lb-body" });
    const hint = h("p", { class: "lb-hint" });
    const tabBtns = Object.fromEntries(Object.entries(TABS).map(([t, cfg]) => [t, h("button", {
        class: "px-btn ghost", type: "button", text: cfg.label,
        onclick: () => { tab = t; sfx("select"); load(); }
    })]));

    const panel = h("div", { id: "lbPanel", class: "hidden", onclick: e => { if (e.target === panel) close(); } },
        h("div", { class: "social-box px-panel lb-box" },
            h("header", {},
                h("h2", { text: "CLASSIFICA" }),
                h("button", { class: "px-btn red social-close", type: "button", text: "X", onclick: () => close() })),
            h("nav", { class: "lb-tabs" }, Object.values(tabBtns)),
            hint,
            body));
    document.body.append(panel);

    function row(e, cfg) {
        const medal = e.rank <= 3 ? " medal m" + e.rank : "";
        return h("li", { class: "lb-row" + (e.me ? " me" : "") },
            h("span", { class: "lb-rank" + medal, text: e.rank }),
            h("div", { class: "lb-who" }, h("b", { text: e.username || e.playerId }), h("small", { text: e.playerId })),
            cfg.cols.map(([label, get]) => h("span", { class: "lb-val" }, h("i", { text: label }), String(get(e)))));
    }

    async function load() {
        Object.entries(tabBtns).forEach(([t, b]) => b.classList.toggle("is-selected", t === tab));
        const cfg = TABS[tab];
        hint.textContent = cfg.hint;
        body.replaceChildren(h("p", { class: "social-empty", text: "Caricamento…" }));

        const mySeq = ++seq;
        let data;
        try {
            data = await (await fetch(`/api/leaderboard?type=${tab}`)).json();
        } catch {
            data = { status: "error" };
        }
        if (mySeq !== seq) return;   // nel frattempo è stata scelta un'altra scheda

        if (data.status !== "success") {
            body.replaceChildren(h("p", { class: "social-empty", text: "Classifica non disponibile al momento." }));
            return;
        }
        if (!data.entries.length) {
            body.replaceChildren(h("p", { class: "social-empty", text: tab === "fighters"
                ? "Nessun combattente ancora: sconfiggi un boss o supera una Survival Trial per entrare in classifica!"
                : "Classifica vuota." }));
            return;
        }

        const list = h("ol", { class: "lb-list" }, data.entries.map(e => row(e, cfg)));
        body.replaceChildren(list);
        // la propria posizione, se fuori dai primi mostrati
        if (data.me && !data.entries.some(e => e.me)) {
            body.append(h("div", { class: "lb-sep", text: "· · ·" }), h("ol", { class: "lb-list" }, row({ ...data.me, me: true }, cfg)));
        }
        body.append(h("p", { class: "lb-total", text: `${data.total} giocatori in classifica` }));
        body.querySelector(".lb-row.me")?.scrollIntoView({ block: "nearest" });
    }

    function close() {
        if (!open) return;
        open = false;
        panel.classList.add("hidden");
        sfx("select");
    }

    document.addEventListener("keydown", e => {
        if (open && e.key === "Escape") { close(); e.preventDefault(); }
    });

    document.querySelectorAll("[data-leaderboard-open]").forEach(b =>
        b.addEventListener("click", e => { e.preventDefault(); window.Leaderboard.open(); b.blur(); }));

    window.Leaderboard = {
        open(which) {
            if (which && TABS[which]) tab = which;
            open = true;
            panel.classList.remove("hidden");
            sfx("confirm");
            load();
        },
        close,
        isOpen: () => open
    };
})();
