/* ============================================================
   TEMA — "pixel" (predefinito) o "classic" (lo stile di prima)
   Va caricato nell'<head> prima dei fogli di stile, così la pagina
   non lampeggia col tema sbagliato. La scelta resta nel browser.
   Il tema classico è in classic.css (regole sotto html[data-theme="classic"]).
   Movimento: "retro" (predefinito: animazioni a scatti e sfondo della home a
   30 fps, come un vecchio gioco) o "smooth" (fluido, html[data-motion="smooth"],
   regole in pixel.css). Il tema classico è sempre fluido.
   ============================================================ */
(function () {
    const KEY = "theme";
    const THEMES = ["pixel", "classic"];
    const MOTION_KEY = "motion";
    const MOTIONS = ["retro", "smooth"];
    const root = document.documentElement;

    const load = key => { try { return localStorage.getItem(key); } catch { return null; } };
    const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage non disponibile */ } };

    const saved = load(KEY);
    root.dataset.theme = THEMES.includes(saved) ? saved : "pixel";
    const motion = load(MOTION_KEY);
    root.dataset.motion = MOTIONS.includes(motion) ? motion : "retro";

    window.Theme = {
        get: () => root.dataset.theme,
        isClassic: () => root.dataset.theme === "classic",
        set(theme) {
            if (!THEMES.includes(theme) || theme === root.dataset.theme) return;
            root.dataset.theme = theme;
            save(KEY, theme);
            dispatchEvent(new CustomEvent("themechange", { detail: theme }));
        },
        motion: () => root.dataset.motion,
        // animazioni senza scatti: tema classico, oppure movimento "fluido" scelto nelle impostazioni
        isSmooth: () => root.dataset.theme === "classic" || root.dataset.motion === "smooth",
        setMotion(m) {
            if (!MOTIONS.includes(m) || m === root.dataset.motion) return;
            root.dataset.motion = m;
            save(MOTION_KEY, m);
            dispatchEvent(new CustomEvent("themechange", { detail: root.dataset.theme }));
        }
    };
})();
