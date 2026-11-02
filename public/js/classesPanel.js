/* ============================================================
   CLASSI E GACHA (home)
   - collezione: le 9 classi in una griglia 3x3, varianti con livello
     e copie, scelta della classe (solo varianti sbloccate);
   - gacha: tirate x1 / x10 con i Frammenti, rivelazione delle carte.
   Dati da /api/classes, tirate su /api/gacha/pull.
   ============================================================ */
(function () {
    let data = null, tab = "collection", open = false, focusClass = null, pulling = false;

    function h(tag, attrs = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "style") el.style.cssText = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : v);
        }
        for (const c of children.flat()) if (c != null && c !== false) el.append(c);
        return el;
    }

    const sfx = name => window.SFX && SFX.play(name);

    function notify(message, bad) {
        const t = h("div", { class: "social-toast" + (bad ? " bad" : ""), text: message });
        (document.getElementById("socialToasts") || document.body).appendChild(t);
        setTimeout(() => t.remove(), 2600);
    }

    async function api(path, body) {
        try {
            const res = await fetch(path, body ? {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            } : undefined);
            return await res.json();
        } catch {
            return { status: "error", message: "Server non raggiungibile" };
        }
    }

    /* ---------------- struttura ---------------- */
    const gems = h("span", { class: "cl-gems", title: "Frammenti: si ottengono scrivendo numeri nuovi" });
    const body = h("div", { class: "cl-body" });
    const tabBtns = {
        collection: h("button", { class: "px-btn ghost", type: "button", text: "COLLEZIONE", onclick: () => setTab("collection") }),
        gacha: h("button", { class: "px-btn ghost", type: "button", text: "GACHA", onclick: () => setTab("gacha") })
    };
    const panel = h("div", { id: "clPanel", class: "hidden", onclick: e => { if (e.target === panel) close(); } },
        h("div", { class: "social-box px-panel cl-box" },
            h("header", {},
                h("h2", { text: "CLASSI" }),
                gems,
                h("button", { class: "px-btn red social-close", type: "button", text: "X", onclick: () => close() })),
            h("nav", { class: "lb-tabs" }, Object.values(tabBtns)),
            body));
    const reveal = h("div", { id: "gachaReveal", class: "hidden" });
    document.body.append(panel, reveal);

    function setTab(t) {
        tab = t;
        sfx("select");
        render();
    }

    const variantOf = (cls, id) => cls.variants.find(v => v.id === id);

    function levelBar(x) {
        const pct = x.need ? Math.round(x.progress / x.need * 100) : 100;
        return h("div", { class: "cl-lvbar", title: x.need ? `${x.progress}/${x.need} doppioni per il livello ${x.level + 1}` : "Livello massimo" },
            h("i", { style: `width:${pct}%` }));
    }

    /* ---------------- collezione ---------------- */
    function renderCollection() {
        const owned = data.classes.filter(c => c.level > 0).length;
        body.append(h("p", { class: "lb-hint", text: `${owned}/9 classi sbloccate · scegli una variante sbloccata per usarla in gioco` }));

        body.append(h("div", { class: "cl-grid" }, data.classes.map(cls => {
            const locked = cls.level === 0;
            const selected = data.selected?.classId === cls.id;
            return h("button", {
                type: "button",
                class: "cl-card" + (locked ? " locked" : "") + (selected ? " selected" : "") + (focusClass === cls.id ? " focus" : ""),
                style: `--cls:${cls.color}`,
                onclick: () => { focusClass = cls.id; sfx("select"); render(); }
            },
                h("span", { class: "cl-num", text: cls.id }),
                h("span", { class: "cl-name", text: locked ? "???" : cls.name }),
                h("span", { class: "cl-lv", text: locked ? "BLOCCATA" : `LV ${cls.level}` }),
                selected ? h("span", { class: "cl-badge", text: "IN USO" }) : null);
        })));

        const cls = data.classes.find(c => c.id === focusClass);
        if (!cls) return;
        body.append(h("div", { class: "cl-detail", style: `--cls:${cls.color}` },
            h("h3", {}, h("span", { class: "cl-dnum", text: cls.id }), ` ${cls.level ? cls.name : "Classe bloccata"} `, h("small", { text: cls.role })),
            cls.level ? levelBar(cls) : null,
            h("ul", { class: "cl-variants" }, cls.variants.map(v => {
                const inUse = data.selected?.classId === cls.id && data.selected?.variant === v.id;
                return h("li", { class: v.level ? "" : "locked" },
                    h("div", { class: "cl-vhead" },
                        h("b", { text: v.level ? v.name : "Variante bloccata" }),
                        h("span", { class: "cl-vlv", text: v.level ? `LV ${v.level} · ${v.copies} copie` : "Da trovare nel gacha" })),
                    h("p", { text: v.desc }),
                    v.level ? levelBar(v) : null,
                    v.level ? h("button", {
                        class: "px-btn small " + (inUse ? "ghost" : "green"), type: "button",
                        text: inUse ? "IN USO" : "SCEGLI", disabled: inUse,
                        onclick: () => select(cls.id, v.id)
                    }) : null);
            }))));
    }

    async function select(classId, variant) {
        const r = await api("/api/classes/select", { classId, variant });
        notify(r.message, r.status !== "success");
        if (r.status !== "success") return sfx("bump");
        sfx("confirm");
        data.selected = r.selected;
        updateCard();
        render();
    }

    /* ---------------- gacha ---------------- */
    function renderGacha() {
        const can1 = data.currency >= data.pullCost, can10 = data.currency >= data.tenPullCost;
        body.append(
            h("div", { class: "gacha-machine" },
                h("div", { class: "gacha-grid" }, Array.from({ length: 9 }, (_, i) =>
                    h("span", { style: `--cls:${data.classes[i].color}; --d:${i * 0.12}s`, text: i + 1 }))),
                h("p", { class: "gacha-info" },
                    "Ogni tirata dà una classe a caso (tutte con la stessa probabilità) e una sua variante. ",
                    "I doppioni fanno salire di livello variante e classe: ogni livello richiede un doppione in più del precedente."),
                h("div", { class: "gacha-btns" },
                    h("button", { class: "px-btn yellow", type: "button", disabled: !can1 || pulling, onclick: () => pull(1) },
                        "TIRA x1 ", h("span", { class: "cost", text: `◆ ${data.pullCost}` })),
                    h("button", { class: "px-btn green", type: "button", disabled: !can10 || pulling, onclick: () => pull(10) },
                        "TIRA x10 ", h("span", { class: "cost", text: `◆ ${data.tenPullCost}` }))),
                !can1 ? h("p", { class: "gacha-hint", text: `Ti mancano ${data.pullCost - data.currency} Frammenti: scrivi numeri nuovi nel mondo per guadagnarli (+1 per numero).` }) : null));
    }

    async function pull(count) {
        if (pulling) return;
        pulling = true;
        render();
        sfx("confirm");
        const r = await api("/api/gacha/pull", { count });
        pulling = false;
        if (r.status !== "success") {
            notify(r.message, true);
            sfx("bump");
            return render();
        }
        data.currency = r.currency;
        showReveal(r.results);
        await load();
    }

    // Carte coperte che si girano una dopo l'altra
    function showReveal(results) {
        const byId = id => data.classes.find(c => c.id === id);
        const cards = results.map((r, i) => {
            const cls = byId(r.classId);
            const v = variantOf(cls, r.variant);
            const tag = r.newClass ? "NUOVA CLASSE!" : r.isNew ? "NUOVA VARIANTE!" : r.levelUp ? `LV ${r.level}!` : `+1 COPIA`;
            const rare = r.newClass || r.isNew || r.levelUp;
            return h("div", { class: "g-card" + (rare ? " rare" : ""), style: `--cls:${cls.color}; --i:${i}` },
                h("div", { class: "g-back", text: "?" }),
                h("div", { class: "g-front" },
                    h("span", { class: "g-num", text: cls.id }),
                    h("span", { class: "g-name", text: cls.name }),
                    h("span", { class: "g-var", text: v.name }),
                    h("span", { class: "g-tag", text: tag }),
                    h("span", { class: "g-lv", text: `VARIANTE LV ${r.level} · CLASSE LV ${r.classLevel}` })));
        });
        reveal.replaceChildren(h("div", { class: "g-stage" + (results.length > 1 ? " ten" : "") },
            h("h2", { text: results.length > 1 ? "10 TIRATE" : "TIRATA" }),
            h("div", { class: "g-cards" }, cards),
            h("button", { class: "px-btn green g-ok", type: "button", text: "CONTINUA", onclick: closeReveal })));
        reveal.classList.remove("hidden");

        cards.forEach((c, i) => setTimeout(() => {
            c.classList.add("flip");
            sfx(c.classList.contains("rare") ? "clear" : "place");
        }, 400 + i * 220));
    }

    function closeReveal() {
        reveal.classList.add("hidden");
        sfx("select");
        render();
    }

    /* ---------------- generale ---------------- */
    function render() {
        Object.entries(tabBtns).forEach(([t, b]) => b.classList.toggle("is-selected", t === tab));
        gems.textContent = data ? `◆ ${data.currency}` : "◆ …";
        body.replaceChildren();
        if (!data) return body.append(h("p", { class: "social-empty", text: "Caricamento…" }));
        if (data.error) return body.append(h("p", { class: "social-empty", text: data.error }));
        if (tab === "collection") renderCollection();
        else renderGacha();
    }

    // Classe e Frammenti nella scheda del giocatore in home
    function updateCard() {
        const clsEl = document.getElementById("player-class");
        const gemsEl = document.getElementById("player-gems");
        if (!data || data.error) return;
        if (gemsEl) gemsEl.textContent = `◆ ${data.currency}`;
        if (!clsEl) return;
        const cls = data.selected && data.classes.find(c => c.id === data.selected.classId);
        const v = cls && variantOf(cls, data.selected.variant);
        clsEl.textContent = v ? `${cls.id} · ${v.name} LV ${v.level}` : "Nessuna classe";
        clsEl.style.setProperty("--cls", cls ? cls.color : "");
    }

    async function load() {
        const r = await api("/api/classes");
        data = r.status === "success" ? r : { error: r.message || "Classi non disponibili", currency: 0 };
        if (focusClass == null && data.selected) focusClass = data.selected.classId;
        updateCard();
        if (open) render();
    }

    function close() {
        if (!open) return;
        open = false;
        panel.classList.add("hidden");
        sfx("select");
    }

    document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        if (!reveal.classList.contains("hidden")) { closeReveal(); e.preventDefault(); }
        else if (open) { close(); e.preventDefault(); }
    });

    document.querySelectorAll("[data-classes-open]").forEach(b =>
        b.addEventListener("click", e => { e.preventDefault(); window.ClassesPanel.open(b.dataset.classesOpen || undefined); b.blur(); }));

    load();

    window.ClassesPanel = {
        open(which) {
            if (which === "gacha" || which === "collection") tab = which;
            open = true;
            panel.classList.remove("hidden");
            sfx("confirm");
            render();
            load();
        },
        close,
        isOpen: () => open || !reveal.classList.contains("hidden")
    };
})();
