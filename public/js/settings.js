/* ============================================================
   IMPOSTAZIONI (home e gioco) — tema (pixel o classico) e movimento
   (retro a scatti o fluido, solo nel tema pixel)
   Riusa .social-box / .social-close di social.css; il tema è in theme.js.
   ============================================================ */
(function () {
    const THEMES = [
        { id: "pixel", name: "PIXEL", desc: "Pixel art cartoon con contorni spessi ed effetti a scatti." },
        { id: "classic", name: "CLASSICO", desc: "Lo stile di prima: morbido e pulito, con effetti sfumati." }
    ];

    const MOTIONS = [
        { id: "retro", name: "RETRO", desc: "Animazioni a scatti e sfondo a 30 fps, come un vecchio gioco." },
        { id: "smooth", name: "FLUIDO", desc: "Stesso stile pixel, ma animazioni morbide e senza scatti." }
    ];

    let open = false;

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

    // Anteprima: un 3x3 con qualche numero, disegnato con lo stile del tema
    const preview = id => h("span", { class: "set-preview", "data-preview": id },
        [5, 0, 3, 0, 7, 0, 1, 0, 9].map(d => h("i", { text: d || "" })));

    const themeBtns = THEMES.map(t => h("button", {
        class: "set-theme", type: "button", "data-theme-id": t.id,
        onclick: () => { window.Theme?.set(t.id); sfx("confirm"); paint(); }
    }, preview(t.id), h("span", { class: "set-text" }, h("b", { text: t.name }), h("small", { text: t.desc }))));

    // Movimento: mini-anteprima di un quadrato che si sposta, a scatti o fluido
    const motionBtns = MOTIONS.map(m => h("button", {
        class: "set-theme set-motion", type: "button", "data-motion-id": m.id,
        onclick: () => { window.Theme?.setMotion(m.id); sfx("confirm"); paint(); }
    }, h("span", { class: "set-motion-preview", "data-preview": m.id }, h("i")),
        h("span", { class: "set-text" }, h("b", { text: m.name }), h("small", { text: m.desc }))));
    const motionHint = h("p", { class: "set-hint" });

    const panel = h("div", { id: "setPanel", class: "hidden", onclick: e => { if (e.target === panel) close(); } },
        h("div", { class: "social-box px-panel set-box" },
            h("header", {},
                h("h2", { text: "IMPOSTAZIONI" }),
                h("button", { class: "px-btn red social-close", type: "button", text: "X", onclick: () => close() })),
            h("section", { class: "set-section" },
                h("h3", { text: "TEMA" }),
                h("div", { class: "set-themes" }, themeBtns),
                h("p", { class: "set-hint", text: "La scelta vale per questo browser e si applica subito." })),
            h("section", { class: "set-section" },
                h("h3", { text: "MOVIMENTO" }),
                h("div", { class: "set-themes" }, motionBtns),
                motionHint)));
    document.body.append(panel);

    function paint() {
        const cur = window.Theme?.get() || "pixel";
        themeBtns.forEach(b => b.classList.toggle("is-selected", b.dataset.themeId === cur));
        const motion = window.Theme?.motion() || "retro";
        const classic = cur === "classic";
        motionBtns.forEach(b => {
            b.classList.toggle("is-selected", b.dataset.motionId === motion);
            b.disabled = classic;
        });
        motionHint.textContent = classic
            ? "Il tema Classico è sempre fluido: questa scelta vale per il tema Pixel."
            : "Vale per animazioni, effetti speciali e sfondo della home.";
    }

    // il tema può cambiare anche da fuori (es. un'altra scheda del pannello): ridisegna le scelte
    addEventListener("themechange", paint);

    function close() {
        if (!open) return;
        open = false;
        panel.classList.add("hidden");
        sfx("select");
    }

    document.addEventListener("keydown", e => {
        if (open && e.key === "Escape") { close(); e.preventDefault(); }
    });

    document.querySelectorAll("[data-settings-open]").forEach(b =>
        b.addEventListener("click", e => { e.preventDefault(); window.Settings.open(); b.blur(); }));

    window.Settings = {
        open() {
            open = true;
            paint();
            panel.classList.remove("hidden");
            sfx("confirm");
        },
        close,
        isOpen: () => open
    };
})();
