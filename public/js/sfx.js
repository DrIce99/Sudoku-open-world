/* ============================================================
   SFX 8-BIT — suoni sintetizzati con WebAudio (nessun file audio).
   Uso: SFX.play("place", { pitch: 1.2 })
   ============================================================ */
(function () {
    let ctx = null, master = null, noiseBuf = null;
    let muted = false;
    try { muted = localStorage.getItem("sfxMuted") === "1"; } catch { /* storage non disponibile */ }

    function ensure() {
        if (ctx) {
            if (ctx.state === "suspended") ctx.resume();
            return ctx;
        }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.22;
        master.connect(ctx.destination);

        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return ctx;
    }

    // Il browser sblocca l'audio solo dopo un gesto dell'utente
    ["keydown", "pointerdown"].forEach(ev =>
        window.addEventListener(ev, () => ensure(), { capture: true }));

    function tone(freq, dur, { type = "square", vol = 0.5, slide = 0, delay = 0 } = {}) {
        const t = ctx.currentTime + delay;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    function noise(dur, { vol = 0.5, freq = 1800, delay = 0, q = 0.8 } = {}) {
        const t = ctx.currentTime + delay;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(freq, t);
        f.frequency.exponentialRampToValueAtTime(80, t + dur);
        f.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f).connect(g).connect(master);
        src.start(t);
        src.stop(t + dur + 0.02);
    }

    const arp = (notes, step, opts) => notes.forEach((n, i) => tone(n, step * 1.6, { ...opts, delay: i * step }));

    const SOUNDS = {
        move: () => tone(180, 0.04, { vol: 0.12, type: "triangle" }),
        bump: () => tone(90, 0.08, { vol: 0.3, slide: 0.6 }),
        select: () => tone(660, 0.05, { vol: 0.25 }),
        confirm: () => arp([523, 784, 1046], 0.05, { vol: 0.3 }),
        place: ({ pitch = 1 } = {}) => {
            tone(520 * pitch, 0.07, { vol: 0.35 });
            tone(1040 * pitch, 0.09, { vol: 0.2, delay: 0.04, type: "triangle" });
        },
        dash: () => { noise(0.12, { vol: 0.25, freq: 4000 }); tone(300, 0.1, { vol: 0.2, slide: 2.4 }); },
        wrong: () => {
            tone(160, 0.22, { vol: 0.45, type: "sawtooth", slide: 0.5 });
            tone(110, 0.25, { vol: 0.35, delay: 0.06, slide: 0.5 });
            noise(0.15, { vol: 0.3, freq: 900 });
        },
        clear: () => arp([523, 659, 784, 1046, 1318], 0.06, { vol: 0.3 }),
        fanfare: () => {
            arp([392, 523, 659, 784], 0.09, { vol: 0.32 });
            arp([1046, 1046, 1318, 1568], 0.12, { vol: 0.28, delay: 0.4 });
            noise(0.5, { vol: 0.15, freq: 6000, delay: 0.36 });
        },
        levelup: () => arp([262, 330, 392, 523, 659, 784, 1046], 0.05, { vol: 0.3, type: "square" }),
        alarm: ({ pitch = 1 } = {}) => tone(880 * pitch, 0.07, { vol: 0.22, type: "square" }),
        warning: () => {
            for (let i = 0; i < 4; i++) {
                tone(440, 0.18, { vol: 0.3, type: "sawtooth", delay: i * 0.36, slide: 1.5 });
                tone(660, 0.16, { vol: 0.25, type: "sawtooth", delay: i * 0.36 + 0.18, slide: 0.66 });
            }
        },
        strike: () => { noise(0.35, { vol: 0.5, freq: 2400 }); tone(70, 0.3, { vol: 0.5, slide: 0.4 }); },
        hit: () => {
            noise(0.4, { vol: 0.65, freq: 3000 });
            tone(120, 0.35, { vol: 0.55, type: "sawtooth", slide: 0.3 });
        },
        dodge: () => {
            noise(0.25, { vol: 0.3, freq: 7000, q: 4 });
            tone(400, 0.25, { vol: 0.25, slide: 3, type: "triangle" });
            arp([988, 1318], 0.07, { vol: 0.2, delay: 0.12 });
        },
        boom: () => {
            noise(0.9, { vol: 0.7, freq: 1500 });
            tone(60, 0.8, { vol: 0.6, slide: 0.3 });
        },
        ko: () => arp([392, 330, 262, 196, 131], 0.12, { vol: 0.32, type: "triangle" }),
        vs: () => { tone(110, 0.5, { vol: 0.45, type: "sawtooth" }); noise(0.4, { vol: 0.35, freq: 1200 }); }
    };

    window.SFX = {
        play(name, opts) {
            if (muted || !SOUNDS[name] || !ensure() || ctx.state !== "running") return;
            try { SOUNDS[name](opts); } catch { /* audio non disponibile */ }
        },
        get muted() { return muted; },
        toggle() {
            muted = !muted;
            try { localStorage.setItem("sfxMuted", muted ? "1" : "0"); } catch { /* storage non disponibile */ }
            return muted;
        },
        // Collega un bottone che mostra/attiva l'audio
        bindToggle(btn) {
            if (!btn) return;
            const paint = () => {
                btn.textContent = muted ? "OFF" : "SFX";
                btn.title = muted ? "Audio disattivato" : "Audio attivo";
                btn.classList.toggle("red", muted);
            };
            paint();
            btn.addEventListener("click", e => {
                e.preventDefault();
                SFX.toggle();
                paint();
                SFX.play("select");
                btn.blur();
            });
        }
    };
})();
