/* ============================================================
   SOCIAL — ricerca giocatori e amici (API REST) e party (WebSocket)
   Usato sia dalla home (che apre una connessione "lobby": online per
   amici e party, ma fuori dal mondo) sia dal gioco (in più: HUD dei
   membri e indicatori di posizione fuori schermo).
   ============================================================ */
(function () {
    const S = {
        mode: "home",
        getWs: () => null,
        getMe: () => null,
        guest: false,
        data: null,          // risposta di /api/friends
        party: null,         // stato del party dal server
        players: [],         // ultimo elenco giocatori online (posizioni)
        tab: "search",
        open: false,
        confirmRemove: null,
        search: null,        // risultati dell'ultima ricerca
        searchLoading: false,
        invited: new Set()   // playerId invitati al party da questa ricerca
    };

    /* ---------------- utilità DOM ---------------- */
    function h(tag, attrs = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else if (k === "style") el.style.cssText = v;
            else el.setAttribute(k, v === true ? "" : v);
        }
        for (const c of children.flat()) if (c != null && c !== false) el.append(c);
        return el;
    }

    const sfx = name => window.SFX && SFX.play(name);

    function notify(message, bad) {
        if (!message) return;
        if (typeof toast === "function") return toast(message, bad ? "bad" : "gold");
        const t = h("div", { class: "social-toast" + (bad ? " bad" : ""), text: message });
        toasts.appendChild(t);
        setTimeout(() => t.remove(), 2600);
    }

    async function api(path, body) {
        try {
            const res = await fetch(path, body ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            } : undefined);
            const data = await res.json();
            if (res.status === 403) S.guest = true;
            return data;
        } catch {
            return { status: "error", message: "Server non raggiungibile" };
        }
    }

    function wsSend(data) {
        const ws = S.getWs();
        if (!ws || ws.readyState !== 1) {
            notify("Non sei connesso al server", true);
            return false;
        }
        ws.send(JSON.stringify(data));
        return true;
    }

    const myId = () => S.getMe() || S.data?.me?.playerId || null;

    /* ---------------- PANNELLO ---------------- */
    const toasts = h("div", { id: "socialToasts" });
    const body = h("div", { class: "social-body" });
    const tabBtns = {};
    const tabs = h("nav", { class: "social-tabs" },
        ["search", "friends", "requests", "party"].map(t => tabBtns[t] = h("button", {
            class: "px-btn ghost", type: "button", "data-tab": t,
            onclick: () => { S.tab = t; sfx("select"); render(); focusSearch(); }
        }, { search: "CERCA", friends: "AMICI", requests: "RICHIESTE", party: "PARTY" }[t], h("span", { class: "badge" }))));

    const panel = h("div", { id: "socialPanel", class: "hidden", onclick: e => { if (e.target === panel) close(); } },
        h("div", { class: "social-box px-panel" },
            h("header", {},
                h("h2", { text: "SOCIAL" }),
                h("button", { class: "px-btn red social-close", type: "button", text: "X", onclick: () => close() })),
            tabs,
            body));

    const invitesBox = h("div", { id: "partyInvites" });

    // lo script è caricato in fondo al body
    document.body.append(panel, invitesBox, toasts);

    function open(tab) {
        if (tab) S.tab = tab;
        S.open = true;
        panel.classList.remove("hidden");
        sfx("confirm");
        render();
        refresh();
        focusSearch();
        if (S.tab === "search" && searchInput.value.trim()) runSearch();
    }

    function close() {
        if (!S.open) return;
        S.open = false;
        S.confirmRemove = null;
        panel.classList.add("hidden");
        sfx("select");
        document.activeElement?.blur?.();
    }

    // Esc chiude il pannello (gioco e home ignorano i tasti finché è aperto: Social.isOpen())
    document.addEventListener("keydown", e => {
        if (S.open && e.key === "Escape") { close(); e.preventDefault(); }
    });

    async function refresh() {
        if (S.guest) return render();
        const data = await api("/api/friends");
        if (data.status === "success") S.data = data;
        updateBadges();
        render();
    }

    function updateBadges() {
        const n = S.data?.incoming?.length || 0;
        document.querySelectorAll("[data-social-badge]").forEach(b => {
            b.textContent = n;
            b.hidden = !n;
        });
        tabBtns.requests.querySelector(".badge").textContent = n || "";
        tabBtns.party.querySelector(".badge").textContent = S.party ? S.party.members.length : "";
    }

    function inputRow(placeholder, label, onSubmit) {
        const input = h("input", { type: "text", maxlength: "40", placeholder, spellcheck: "false", autocomplete: "off" });
        const submit = () => { const v = input.value.trim(); if (v) onSubmit(v, input); };
        input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
        return h("div", { class: "social-form" }, input, h("button", { class: "px-btn green", type: "button", text: label, onclick: submit }));
    }

    const empty = text => h("p", { class: "social-empty", text });
    const dot = online => h("i", { class: "dot" + (online ? " on" : ""), title: online ? "Online" : "Offline" });

    function render() {
        Object.entries(tabBtns).forEach(([t, b]) => b.classList.toggle("is-selected", t === S.tab));
        updateBadges();
        if (S.guest) {
            body.replaceChildren(empty("Gli ospiti non possono cercare giocatori, avere amici o entrare in un party. Accedi con Google per giocare insieme agli altri."));
            return;
        }
        if (S.tab === "search") {
            if (body.firstChild !== searchView) body.replaceChildren(searchView);
            return renderSearchResults();
        }
        body.replaceChildren();
        if (S.tab === "friends") renderFriends();
        else if (S.tab === "requests") renderRequests();
        else renderParty();
    }

    async function friendAction(path, playerId, input) {
        const r = await api(path, { playerId });
        notify(r.message, r.status !== "success");
        if (r.status === "success") {
            sfx(path.endsWith("remove") || path.endsWith("decline") || path.endsWith("cancel") ? "select" : "confirm");
            if (input) input.value = "";
            refresh();
            if (S.tab === "search") runSearch();
        } else sfx("bump");
    }

    const presenceText = p => p === "game" ? "in gioco" : p === "home" ? "in home" : "offline";

    // Si può invitare se si è connessi e non si è in un party di cui non si è il capo
    function canInvite() {
        const ws = S.getWs();
        const p = S.party;
        return !!ws && ws.readyState === 1 && (!p || (p.leader === myId() && p.members.length < p.max));
    }

    function invite(playerId) {
        if (!wsSend({ type: "party_invite", playerId })) return;
        S.invited.add(playerId);
        sfx("confirm");
        render();
    }

    /* ---------------- RICERCA GIOCATORI ---------------- */
    const searchInput = h("input", {
        type: "search", maxlength: "40", spellcheck: "false", autocomplete: "off",
        placeholder: "Nome o ID del giocatore (es. Mario o Mario#4821)"
    });
    const searchResults = h("div", { class: "search-results" });
    const searchView = h("div", { class: "search-view" },
        h("div", { class: "social-form" }, searchInput),
        searchResults);

    let searchTimer = null, searchSeq = 0;
    searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 250);
    });
    searchInput.addEventListener("keydown", e => {
        if (e.key === "Enter") { clearTimeout(searchTimer); runSearch(); }
    });

    function focusSearch() {
        if (S.open && S.tab === "search") setTimeout(() => searchInput.focus(), 0);
    }

    async function runSearch() {
        const q = searchInput.value.trim();
        const seq = ++searchSeq;
        if (!q) {
            S.search = null;
            S.searchLoading = false;
            return renderSearchResults();
        }
        S.searchLoading = true;
        renderSearchResults();
        const r = await api(`/api/players/search?q=${encodeURIComponent(q)}`);
        if (seq !== searchSeq) return;   // nel frattempo è partita una ricerca più nuova
        S.searchLoading = false;
        S.search = r.status === "success" ? r.results : [];
        if (r.status !== "success") notify(r.message, true);
        renderSearchResults();
    }

    function renderSearchResults() {
        const q = searchInput.value.trim();
        if (!q) {
            searchResults.replaceChildren(empty("Scrivi l'inizio del nome o l'ID di un giocatore per aggiungerlo agli amici o invitarlo nel tuo party."));
            return;
        }
        if (S.searchLoading && !S.search) {
            searchResults.replaceChildren(empty("Ricerca…"));
            return;
        }
        if (!S.search?.length) {
            searchResults.replaceChildren(empty(`Nessun giocatore trovato per "${q}".`));
            return;
        }

        const inviteOk = canInvite();
        searchResults.replaceChildren(h("ul", { class: "social-list" }, S.search.map(r => {
            const inMyParty = r.inMyParty || S.party?.members.some(m => m.playerId === r.playerId);

            let friendCtl;
            if (r.friend) friendCtl = h("span", { class: "tag", text: "AMICO" });
            else if (r.requestReceived) friendCtl = h("button", { class: "px-btn green small", type: "button", text: "ACCETTA", onclick: () => friendAction("/api/friends/accept", r.playerId) });
            else if (r.requestSent) friendCtl = h("span", { class: "tag muted", text: "RICHIESTA INVIATA" });
            else friendCtl = h("button", { class: "px-btn green small", type: "button", text: "+ AMICO", onclick: () => friendAction("/api/friends/request", r.playerId) });

            let partyCtl = null;
            if (inMyParty) partyCtl = h("span", { class: "tag", text: "PARTY" });
            else if (S.invited.has(r.playerId)) partyCtl = h("span", { class: "tag muted", text: "INVITATO" });
            else if (r.presence && r.inParty) partyCtl = h("span", { class: "tag muted", text: "IN UN PARTY" });
            else if (r.presence && inviteOk) partyCtl = h("button", { class: "px-btn yellow small", type: "button", text: "INVITA PARTY", onclick: () => invite(r.playerId) });

            return h("li", {},
                dot(!!r.presence),
                h("div", { class: "who" }, h("b", { text: r.username }), h("small", { text: `${r.playerId} · LV ${r.level} · ${presenceText(r.presence)}` })),
                h("div", { class: "row-actions" }, friendCtl, partyCtl));
        })));
    }

    function renderFriends() {
        const d = S.data;
        if (!d) return body.append(empty("Caricamento…"));

        body.append(
            h("div", { class: "social-me" },
                h("span", { text: "IL TUO ID" }),
                h("strong", { text: d.me.playerId }),
                h("button", {
                    class: "px-btn ghost small", type: "button", text: "COPIA",
                    onclick: () => navigator.clipboard?.writeText(d.me.playerId).then(() => notify("ID copiato!"))
                })),
            inputRow("ID amico (es. Mario#4821)", "AGGIUNGI", (v, input) => friendAction("/api/friends/request", v, input))
        );

        if (!d.friends.length) return body.append(empty("Nessun amico ancora. Fatti dare il loro ID e aggiungili qui sopra!"));

        const online = d.friends.filter(f => f.online).length;
        body.append(h("h3", { text: `AMICI ${online}/${d.friends.length} ONLINE` }));
        const inviteOk = canInvite();

        body.append(h("ul", { class: "social-list" }, d.friends.map(f => {
            const confirming = S.confirmRemove === f.playerId;
            const inParty = S.party?.members.some(m => m.playerId === f.playerId);
            return h("li", {},
                dot(f.online),
                h("div", { class: "who" }, h("b", { text: f.username }), h("small", { text: `${f.playerId} · LV ${f.level} · ${presenceText(f.presence)}` })),
                inParty ? h("span", { class: "tag", text: "PARTY" }) :
                    S.invited.has(f.playerId) ? h("span", { class: "tag muted", text: "INVITATO" }) :
                    (inviteOk && f.online) ? h("button", {
                        class: "px-btn yellow small", type: "button", text: "INVITA",
                        onclick: () => invite(f.playerId)
                    }) : null,
                h("button", {
                    class: "px-btn red small", type: "button", text: confirming ? "SICURO?" : "✕", title: "Rimuovi amico",
                    onclick: () => {
                        if (confirming) { S.confirmRemove = null; friendAction("/api/friends/remove", f.playerId); }
                        else { S.confirmRemove = f.playerId; render(); }
                    }
                }));
        })));
    }

    function renderRequests() {
        const d = S.data;
        if (!d) return body.append(empty("Caricamento…"));

        body.append(h("h3", { text: "RICEVUTE" }));
        body.append(d.incoming.length ? h("ul", { class: "social-list" }, d.incoming.map(r => h("li", {},
            h("div", { class: "who" }, h("b", { text: r.username }), h("small", { text: r.playerId })),
            h("button", { class: "px-btn green small", type: "button", text: "ACCETTA", onclick: () => friendAction("/api/friends/accept", r.playerId) }),
            h("button", { class: "px-btn red small", type: "button", text: "✕", title: "Rifiuta", onclick: () => friendAction("/api/friends/decline", r.playerId) })
        ))) : empty("Nessuna richiesta ricevuta."));

        body.append(h("h3", { text: "INVIATE" }));
        body.append(d.outgoing.length ? h("ul", { class: "social-list" }, d.outgoing.map(r => h("li", {},
            h("div", { class: "who" }, h("b", { text: r.username }), h("small", { text: r.playerId + " · in attesa" })),
            h("button", { class: "px-btn ghost small", type: "button", text: "ANNULLA", onclick: () => friendAction("/api/friends/cancel", r.playerId) })
        ))) : empty("Nessuna richiesta in attesa."));
    }

    function hpBar(m) {
        const known = m.hp != null && m.maxHp;
        return h("div", { class: "mini-hp" + (known ? "" : " unknown") },
            h("i", { style: `width:${known ? Math.max(0, m.hp / m.maxHp * 100) : 100}%` }));
    }

    function renderParty() {
        if (!S.getWs() || S.getWs().readyState !== 1) return body.append(empty("Il party richiede la connessione al server: riprova tra qualche secondo."));

        const p = S.party;
        const me = myId();
        const isLeader = p && p.leader === me;

        if (!p) {
            body.append(empty(`Non sei in un party. Cerca un giocatore online nella scheda CERCA o invita un amico dalla scheda AMICI (max 4 giocatori).`));
        } else {
            body.append(h("h3", { text: `PARTY ${p.members.length}/${p.max}` }));
            body.append(h("ul", { class: "social-list" }, p.members.map(m => h("li", { style: `--p-color:${m.color}` },
                dot(m.online),
                h("div", { class: "who" },
                    h("b", { class: "pname" }, p.leader === m.playerId ? h("span", { class: "crown", title: "Capo party", text: "♛ " }) : null, m.name + (m.playerId === me ? " (tu)" : "")),
                    h("small", { text: `${m.playerId}${m.level ? " · LV " + m.level : ""} · ${m.online ? (m.inWorld ? "in gioco" : "in home") : "offline"}` }),
                    hpBar(m)),
                isLeader && m.playerId !== me ? h("button", {
                    class: "px-btn red small", type: "button", text: "ESPELLI",
                    onclick: () => wsSend({ type: "party_kick", playerId: m.playerId })
                }) : null
            ))));
        }

        if (!p || (isLeader && p.members.length < p.max)) {
            body.append(inputRow("ID giocatore online", "INVITA", (v, input) => {
                invite(v);
                input.value = "";
            }));
        }
        if (p) {
            body.append(h("button", {
                class: "px-btn red social-leave", type: "button", text: "ESCI DAL PARTY",
                onclick: () => wsSend({ type: "party_leave" })
            }));
        }
    }

    /* ---------------- INVITI AL PARTY ---------------- */
    function showInvite(from, ttl) {
        invitesBox.querySelector(`[data-from="${CSS.escape(from.playerId)}"]`)?.remove();
        const card = h("div", { class: "invite-card px-panel", "data-from": from.playerId, style: `--p-color:${from.color || "#73eff7"}` },
            h("div", { class: "invite-title", text: "INVITO PARTY" }),
            h("p", {}, h("b", { text: from.name }), " ti invita nel suo party"),
            h("div", { class: "invite-btns" },
                h("button", { class: "px-btn green small", type: "button", text: "ACCETTA", onclick: () => { wsSend({ type: "party_accept", playerId: from.playerId }); card.remove(); } }),
                h("button", { class: "px-btn red small", type: "button", text: "RIFIUTA", onclick: () => { wsSend({ type: "party_decline", playerId: from.playerId }); card.remove(); } })),
            h("div", { class: "invite-time" }, h("i", { style: `animation-duration:${ttl}ms` })));
        invitesBox.appendChild(card);
        setTimeout(() => card.remove(), ttl);
        sfx("confirm");
    }

    /* ---------------- HUD DEL PARTY (sopra la propria barra HP) ---------------- */
    let hudEl = null;
    const lastHp = new Map();

    function renderPartyHud() {
        if (S.mode !== "game") return;
        if (!hudEl) {
            hudEl = h("div", { id: "partyHud" });
            const hud = document.getElementById("hud");
            hud?.prepend(hudEl);
        }
        hudEl.replaceChildren();
        const others = S.party ? S.party.members.filter(m => m.playerId !== myId()) : [];
        hudEl.hidden = !others.length;

        for (const m of others) {
            const row = h("div", { class: "pm-row" + (m.online ? "" : " off"), style: `--p-color:${m.color}` },
                h("span", { class: "pm-name" }, S.party.leader === m.playerId ? h("span", { class: "crown", text: "♛" }) : null, m.name),
                hpBar(m),
                h("span", { class: "pm-lv", text: !m.online ? "OFF" : !m.inWorld ? "HOME" : (m.level ? "LV " + m.level : "") }));
            // lampeggia se ha appena perso vita
            const prev = lastHp.get(m.playerId);
            if (prev != null && m.hp != null && m.hp < prev) row.classList.add("hurt");
            lastHp.set(m.playerId, m.hp);
            hudEl.appendChild(row);
        }
        hudEl.prepend(others.length ? h("div", { class: "pm-title", text: "PARTY" }) : "");
    }

    /* ---------------- INDICATORI FUORI SCHERMO ---------------- */
    const pointers = new Map();
    const pointerLayer = h("div", { id: "partyPointers" });
    document.body.append(pointerLayer);

    function memberPos(m) {
        const live = S.players.find(p => p.playerId === m.playerId);
        return live ? { x: live.x, y: live.y } : { x: m.x, y: m.y };
    }

    function updatePointers() {
        requestAnimationFrame(updatePointers);
        if (S.mode !== "game" || typeof cam === "undefined" || typeof CELL === "undefined" || typeof player === "undefined") return;

        const others = S.party ? S.party.members.filter(m => m.playerId !== myId()) : [];
        const alive = new Set();
        const W = innerWidth, H = innerHeight;
        const margin = 46, top = 70;

        for (const m of others) {
            if (m.online && !m.inWorld) continue;   // è in home: non ha una posizione
            const pos = memberPos(m);
            const sx = (pos.x + 0.5 - cam.x) * CELL + W / 2;
            const sy = (pos.y + 0.5 - cam.y) * CELL + H / 2;
            const inside = sx > margin && sx < W - margin && sy > top && sy < H - margin;
            if (inside) continue;
            alive.add(m.playerId);

            let el = pointers.get(m.playerId);
            if (!el) {
                el = h("div", { class: "party-ptr" }, h("div", { class: "arrow", text: "▲" }), h("div", { class: "lbl" }));
                pointerLayer.appendChild(el);
                pointers.set(m.playerId, el);
            }
            const dist = Math.round(Math.hypot(pos.x - player.x, pos.y - player.y));
            el.style.setProperty("--p-color", m.color);
            el.classList.toggle("off", !m.online);
            el.style.left = Math.max(margin, Math.min(W - margin, sx)) + "px";
            el.style.top = Math.max(top, Math.min(H - margin, sy)) + "px";
            el.querySelector(".arrow").style.transform = `rotate(${Math.atan2(sy - H / 2, sx - W / 2) + Math.PI / 2}rad)`;
            const lbl = `${m.name} · ${dist} celle`;
            const lblEl = el.querySelector(".lbl");
            if (lblEl.textContent !== lbl) lblEl.textContent = lbl;
        }

        for (const [pid, el] of pointers) {
            if (!alive.has(pid)) { el.remove(); pointers.delete(pid); }
        }
    }
    requestAnimationFrame(updatePointers);

    /* ---------------- STATO DEL PARTY ---------------- */
    function setParty(party, reason) {
        const before = S.party;
        const me = myId();
        S.party = party;
        for (const m of party?.members || []) S.invited.delete(m.playerId);

        const names = p => new Map((p?.members || []).map(m => [m.playerId, m.name]));
        const oldM = names(before), newM = names(party);

        if (!before && party) {
            notify("Sei entrato in un party!");
            window.FX?.banner("PARTY!", { cls: "small cyan", sub: `${party.members.length} GIOCATORI`, dur: 1200 });
            sfx("clear");
        } else if (before && !party) {
            notify({ kicked: "Sei stato espulso dal party", disbanded: "Il party si è sciolto", timeout: "Sei uscito dal party (disconnesso)", disconnected: "Connessione persa: il party riprende quando torni online" }[reason] || "Hai lasciato il party", reason !== "left");
        } else if (before && party) {
            for (const [pid, name] of newM) if (!oldM.has(pid) && pid !== me) { notify(`${name} è entrato nel party`); sfx("confirm"); }
            for (const [pid, name] of oldM) if (!newM.has(pid) && pid !== me) notify(`${name} ha lasciato il party`, true);
            if (before.leader !== party.leader && party.leader === me) notify("Ora sei il capo party");
        }

        renderPartyHud();
        if (S.open) render();
    }

    /* ---------------- STATISTICHE PROPRIE (HP / livello) ---------------- */
    let stats = null, sentKey = "", statsTimer = null;
    function flushStats() {
        statsTimer = null;
        const ws = S.getWs();
        if (!stats || !ws || ws.readyState !== 1) return;
        const key = stats.hp + "/" + stats.maxHp + "/" + stats.level;
        if (key === sentKey) return;
        sentKey = key;
        ws.send(JSON.stringify({ type: "stats", ...stats }));
    }

    /* ---------------- CONNESSIONE LOBBY (solo home) ---------------- */
    let lobbyWs = null, lobbyDelay = 1000, lobbyStop = false;
    function connectLobby() {
        if (lobbyWs || lobbyStop || S.guest) return;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = lobbyWs = new WebSocket(`${proto}//${location.host}/?lobby=1`);
        ws.onopen = () => {
            lobbyDelay = 1000;
            ws.send(JSON.stringify({ type: "join" }));
            if (S.open) render();
        };
        ws.onmessage = e => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            window.Social.onMessage(msg);
        };
        ws.onclose = e => {
            lobbyWs = null;
            if (S.party) setParty(null, "disconnected");
            // 4000 = lo stesso account è entrato in gioco da un'altra scheda: niente riconnessione
            if (lobbyStop || e.code === 4000) return;
            setTimeout(connectLobby, lobbyDelay);
            lobbyDelay = Math.min(lobbyDelay * 2, 30000);
        };
    }
    addEventListener("pagehide", () => { lobbyStop = true; lobbyWs?.close(1000); });

    /* ============================================================
       API PUBBLICA
       ============================================================ */
    window.Social = {
        init({ mode = "home", getWs, getMe } = {}) {
            S.mode = mode;
            if (getWs) S.getWs = getWs;
            if (getMe) S.getMe = getMe;
            document.querySelectorAll("[data-social-open]").forEach(b =>
                b.addEventListener("click", e => { e.preventDefault(); open(b.dataset.socialOpen || "search"); b.blur(); }));
            if (mode === "home") S.getWs = () => lobbyWs;
            // refresh() scopre anche se l'utente è un ospite (403): solo dopo si apre la lobby
            refresh().then(() => { if (mode === "home") connectLobby(); });
            setInterval(() => { if (S.open && !S.guest) refresh(); }, 20000);
        },
        open,
        close,
        isOpen: () => S.open,
        isPartyMember: pid => !!S.party?.members.some(m => m.playerId === pid),

        // Messaggi WebSocket rilevanti (gli altri vengono ignorati)
        onMessage(msg) {
            if (msg.type === "players") {
                S.players = msg.data || [];
            } else if (msg.type === "party") {
                setParty(msg.party, msg.reason);
            } else if (msg.type === "party_invite") {
                showInvite(msg.from, msg.ttl || 60000);
                notify(`${msg.from.name} ti ha invitato nel suo party`);
            } else if (msg.type === "social_info") {
                notify(msg.message, msg.error);
                if (msg.error) sfx("bump");
                // invito rifiutato o non riuscito: il pulsante torna disponibile
                if (msg.error) { S.invited.clear(); if (S.open) render(); }
            } else if (msg.type === "friend_request") {
                notify(`${msg.from.username} vuole essere tuo amico`);
                sfx("confirm");
                refresh();
            } else if (msg.type === "friends_changed") {
                if (msg.message) notify(msg.message);
                refresh();
            }
        },
        onConnected() {
            sentKey = "";
            flushStats();
        },
        onDisconnected() {
            S.players = [];
            if (S.party) setParty(null, "disconnected");
        },
        reportStats(hp, maxHp, level) {
            stats = { hp: Math.max(0, Math.round(hp)), maxHp: Math.round(maxHp), level };
            if (!statsTimer) statsTimer = setTimeout(flushStats, 150);
        }
    };
})();
