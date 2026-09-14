document.addEventListener("DOMContentLoaded", async () => {
    try {
        const response = await fetch("/api/player");
        const resData = await response.json();

        if (resData.status === "success") {
            const player = resData.data;

            // Popola l'header utente
            document.getElementById("player-username").innerText = player.username || player.name;
            
            // Popola le statistiche del giocatore
            if (player.stats) {
                document.getElementById("stat-completed").innerText = player.stats.completedSudokus || 0;
                document.getElementById("stat-placed").innerText = player.stats.placedNumbers || 0;
                document.getElementById("stat-wrong").innerText = player.stats.wrongPlacements || 0;
            }
        } else {
            window.location.href = "/login";
        }
    } catch (err) {
        console.error("Errore caricamento dati utente:", err);
    }
});