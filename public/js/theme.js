/* ============================================================
   TEMA — "pixel" (predefinito) o "classic" (lo stile di prima)
   Va caricato nell'<head> prima dei fogli di stile, così la pagina
   non lampeggia col tema sbagliato. La scelta resta nel browser.
   Il tema classico è in classic.css (regole sotto html[data-theme="classic"]).
   ============================================================ */
(function () {
    const KEY = "theme";
    const THEMES = ["pixel", "classic"];
    const root = document.documentElement;

    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* storage non disponibile */ }
    root.dataset.theme = THEMES.includes(saved) ? saved : "pixel";

    window.Theme = {
        get: () => root.dataset.theme,
        isClassic: () => root.dataset.theme === "classic",
        set(theme) {
            if (!THEMES.includes(theme) || theme === root.dataset.theme) return;
            root.dataset.theme = theme;
            try { localStorage.setItem(KEY, theme); } catch { /* storage non disponibile */ }
            dispatchEvent(new CustomEvent("themechange", { detail: theme }));
        }
    };
})();
