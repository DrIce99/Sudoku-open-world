/* ============================================================
   PAGINA /version — patch notes (data/changelog.js) e, nella vista
   a destra, storico dei bilanciamenti (data/balance-history.js)
   ============================================================ */
(function () {
    const { VERDICTS, TARGETS, HISTORY } = window.Balance;
    const sfx = (name, opts) => window.SFX && SFX.play(name, opts);
    window.SFX?.bindToggle(document.getElementById("sfxBtn"));

    function makeElement(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    const formatDate = iso => new Date(`${iso}T00:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });

    // patch uscite dopo l'ultima visita (prima di segnarle come viste)
    const lastSeen = window.Balance.lastSeen();
    const seenIdx = CHANGELOG.findIndex(e => e.version === lastSeen);
    const isNewVersion = version => {
        const i = CHANGELOG.findIndex(e => e.version === version);
        return seenIdx === -1 || (i !== -1 && i < seenIdx);
    };
    window.Balance.markSeen();

    const balanceVersions = new Set(HISTORY.map(e => e.version));

    /* ===================== PATCH NOTES ===================== */
    function renderChangelog() {
        document.getElementById("version-title").textContent = `VERSIONE ${CURRENT_VERSION} · PATCH NOTES`;

        const container = document.getElementById("changelog");
        container.replaceChildren(...CHANGELOG.map((entry, index) => {
            const card = makeElement("div", "version-info px-panel");
            const date = makeElement("p", "version-date", formatDate(entry.date));
            if (isNewVersion(entry.version)) date.appendChild(makeElement("em", "v-new", "NEW"));
            card.appendChild(date);
            card.appendChild(makeElement("h2", index === 0 ? "special" : null, `Versione ${entry.version}: ${entry.title}`));

            // Le categorie compaiono sempre nello stesso ordine
            for (const [type, label] of Object.entries(CHANGE_TYPES)) {
                const items = entry.changes[type];
                if (!items?.length) continue;
                card.appendChild(makeElement("h3", "cat-" + type, label));
                const list = makeElement("ul", "version-changes");
                items.forEach(item => list.appendChild(makeElement("li", null, item)));
                card.appendChild(list);
            }

            // Versione con bilanciamenti: scorciatoia verso le sue schede
            if (balanceVersions.has(entry.version)) {
                const link = makeElement("button", "px-btn small yellow balance-link", "▲▼ VEDI I BILANCIAMENTI");
                link.type = "button";
                link.addEventListener("click", () => showBalance(true, { version: entry.version }));
                card.appendChild(link);
            }

            // Il contenitore esterno porta il "pad" sulla linea del tempo
            const wrapper = makeElement("div", index === 0 ? "version-entry current" : "version-entry");
            wrapper.classList.add("scroll-reveal");
            wrapper.appendChild(card);
            return wrapper;
        }));
    }

    /* ===================== BILANCIAMENTI ===================== */
    const formatNumber = n => String(Number(n.toFixed(2))).replace(".", ",");
    const formatValue = (value, unit) => `${formatNumber(value)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;

    function formatDelta(before, after) {
        if (before === after) return "=";
        if (before === 0) return after > 0 ? "+∞" : "−∞";
        const percent = Math.round((after - before) / Math.abs(before) * 100);
        return `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
    }

    // good = il nuovo valore favorisce il giocatore, bad = lo sfavorisce
    function statOutcome({ before, after, better = "higher" }) {
        if (before === after) return "same";
        return (after > before) === (better === "higher") ? "good" : "bad";
    }

    function statRow(stat, index) {
        const outcome = statOutcome(stat);
        const li = makeElement("li", `balance-stat ${outcome}`);

        const line = makeElement("div", "balance-stat-line");
        line.appendChild(makeElement("span", "balance-stat-label", stat.label));
        const values = makeElement("span", "balance-stat-values", `${formatValue(stat.before, stat.unit)} → `);
        values.appendChild(makeElement("strong", null, formatValue(stat.after, stat.unit)));
        line.appendChild(values);
        const arrow = outcome === "good" ? "▲ " : outcome === "bad" ? "▼ " : "";
        line.appendChild(makeElement("span", "balance-delta", arrow + formatDelta(stat.before, stat.after)));
        li.appendChild(line);

        // Due barre in scala tra loro: si vede subito quanto è cambiato il valore
        const max = Math.max(Math.abs(stat.before), Math.abs(stat.after)) || 1;
        const bars = makeElement("div", "balance-bars");
        bars.setAttribute("aria-hidden", "true");
        for (const [kind, value] of [["before", stat.before], ["after", stat.after]]) {
            const bar = makeElement("div", `balance-bar ${kind}`);
            const fill = makeElement("span");
            fill.style.setProperty("--w", `${Math.max(2, Math.abs(value) / max * 100)}%`);
            fill.style.setProperty("--delay", `${0.3 + index * 0.08 + (kind === "after" ? 0.15 : 0)}s`);
            bar.appendChild(fill);
            bars.appendChild(bar);
        }
        li.appendChild(bars);
        return li;
    }

    function verdictPill(verdict, text) {
        const { symbol, label } = VERDICTS[verdict];
        return makeElement("span", `verdict-pill ${verdict}`, `${symbol} ${text ?? label}`);
    }

    function targetDot(target) {
        const dot = makeElement("span", "el-dot", target === "economy" ? "◆" : target[0]);
        dot.style.setProperty("--el", (TARGETS[target] || [, "#94b0c2"])[1]);
        return dot;
    }

    function balanceCard(change) {
        const card = makeElement("article", `balance-card px-panel scroll-reveal ${change.verdict}`);
        card.dataset.target = change.target;

        const header = makeElement("div", "balance-card-header");
        const target = makeElement("div", "balance-target");
        const element = makeElement("span", "balance-element");
        element.append(targetDot(change.target), (TARGETS[change.target] || [change.target])[0]);
        target.append(element, makeElement("span", "balance-effect", change.effect));
        header.append(target, verdictPill(change.verdict));
        card.appendChild(header);

        if (change.note) card.appendChild(makeElement("p", "balance-note", change.note));

        if (change.stats?.length) {
            const stats = makeElement("ul", "balance-stats");
            change.stats.forEach((stat, i) => stats.appendChild(statRow(stat, i)));
            card.appendChild(stats);
        }
        return card;
    }

    function renderBalanceHistory() {
        const container = document.getElementById("balance-history");
        if (!HISTORY.length) {
            container.replaceChildren(makeElement("p", "balance-empty", "Nessun bilanciamento registrato."));
            return;
        }

        container.replaceChildren(...HISTORY.map(entry => {
            const section = makeElement("section", "balance-version");
            section.dataset.version = entry.version;

            const header = makeElement("header", "balance-version-header");
            const h2 = makeElement("h2", null, `Versione ${entry.version}${entry.title ? `: ${entry.title}` : ""}`);
            if (isNewVersion(entry.version)) h2.appendChild(makeElement("em", "v-new", "NEW"));
            header.appendChild(h2);
            header.appendChild(makeElement("span", "balance-version-date", formatDate(entry.date)));
            // Riepilogo: quanti buff, nerf e modifiche in questa versione
            const summary = makeElement("div", "balance-version-summary");
            for (const verdict of Object.keys(VERDICTS)) {
                const count = entry.changes.filter(c => c.verdict === verdict).length;
                if (count) summary.appendChild(verdictPill(verdict, String(count)));
            }
            header.appendChild(summary);
            section.appendChild(header);

            const grid = makeElement("div", "balance-grid");
            entry.changes.forEach(change => grid.appendChild(balanceCard(change)));
            section.appendChild(grid);
            return section;
        }));
    }

    // Filtri: "Tutti" + un bottone per ogni variante (o altro bersaglio) presente nello storico
    function renderBalanceFilters() {
        const targets = [...new Set(HISTORY.flatMap(entry => entry.changes.map(c => c.target)))]
            .sort((a, b) => a === "economy" ? 1 : b === "economy" ? -1 : a.localeCompare(b));
        if (targets.length < 2) return;

        const container = document.getElementById("balance-filters");
        const names = Object.fromEntries(HISTORY.flatMap(e => e.changes.map(c => [c.target, c.effect])));
        const buttons = [null, ...targets].map(target => {
            const btn = makeElement("button", "filter-chip");
            btn.type = "button";
            btn.setAttribute("aria-pressed", String(target === null));
            if (target) btn.append(targetDot(target), names[target]);
            else btn.textContent = "Tutti";
            btn.addEventListener("click", () => {
                buttons.forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
                applyBalanceFilter(target);
                sfx("select");
            });
            return btn;
        });
        container.replaceChildren(...buttons);
    }

    function applyBalanceFilter(target) {
        for (const card of document.querySelectorAll(".balance-card")) {
            card.hidden = target !== null && card.dataset.target !== target;
            // le schede appena mostrate rifanno crescere le barre
            if (!card.hidden) card.classList.add("in-view");
        }
        // Una versione senza schede visibili sparisce del tutto
        for (const section of document.querySelectorAll(".balance-version")) {
            section.hidden = !section.querySelector(".balance-card:not([hidden])");
        }
    }

    /* ===================== CAMBIO VISTA ===================== */
    const BALANCE_HASH = "#bilanciamenti";

    function showBalance(show, { version = null, sound = true } = {}) {
        const changed = document.body.classList.contains("show-balance") !== show;
        document.body.classList.toggle("show-balance", show);
        if (changed && sound) sfx("dash");
        // L'indirizzo ricorda la vista: /version#bilanciamenti apre direttamente lo storico
        history.replaceState(null, "", show ? BALANCE_HASH : location.pathname);
        if (show && version) {
            const section = document.querySelector(`.balance-version[data-version="${CSS.escape(version)}"]`);
            section?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    document.getElementById("open-balance-btn").addEventListener("click", () => showBalance(true));
    document.getElementById("close-balance-btn").addEventListener("click", () => showBalance(false));
    document.addEventListener("keydown", e => {
        if (e.key === "ArrowRight") showBalance(true);
        else if (e.key === "ArrowLeft") showBalance(false);
        else if (e.key === "Escape") location.href = "/";
    });

    renderChangelog();
    renderBalanceFilters();
    renderBalanceHistory();
    if (location.hash === BALANCE_HASH) showBalance(true, { sound: false });

    // Le schede compaiono quando entrano nello schermo (una volta sola); quelle dei
    // bilanciamenti fanno anche crescere le barre
    const revealObserver = new IntersectionObserver(entries => {
        entries.filter(entry => entry.isIntersecting).forEach((entry, i) => {
            entry.target.style.transitionDelay = `${0.15 + i * 0.08}s`;
            entry.target.classList.add("in-view");
            revealObserver.unobserve(entry.target);
        });
    }, { threshold: 0.12 });
    document.querySelectorAll(".scroll-reveal").forEach(el => revealObserver.observe(el));
})();
