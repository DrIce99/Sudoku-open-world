const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let ws = null;
let playerPos = { x: 0, y: 0 };
let playerUsername = "Player";

function initCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener("resize", initCanvas);
initCanvas();

async function loadPlayerData() {
    try {
        const res = await fetch("/api/player");
        const data = await res.json();
        if (data.status === "success") {
            playerUsername = data.data.username || data.data.name;
            document.getElementById("hud-username").innerText = playerUsername;
        }
    } catch (e) {
        console.error("Errore recupero player:", e);
    }
}

function initWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
        console.log("Connesso al WebSocket di gioco");
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "update") {
            drawGrid();
        }
    };

    ws.onerror = (err) => {
        console.error("Errore WebSocket:", err);
    };
}

function sendNumberWrite(zoneKey, cx, cy, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: "write",
        zoneKey: zoneKey,
        cx: cx,
        cy: cy,
        writeData: {
            val: value,
            color: "#38bdf8",
            user: playerUsername
        }
    }));
}

function drawGrid() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const cellSize = 50;

    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;

    for (let x = 0; x < canvas.width; x += cellSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }

    for (let y = 0; y < canvas.height; y += cellSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

    // Marker del giocatore al centro
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(centerX, centerY, 12, 0, Math.PI * 2);
    ctx.fill();

    document.getElementById("hud-pos").innerText = `${playerPos.x}, ${playerPos.y}`;
}

window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "w", "W"].includes(e.key)) playerPos.y -= 1;
    if (["ArrowDown", "s", "S"].includes(e.key)) playerPos.y += 1;
    if (["ArrowLeft", "a", "A"].includes(e.key)) playerPos.x -= 1;
    if (["ArrowRight", "d", "D"].includes(e.key)) playerPos.x += 1;

    if (e.key >= "1" && e.key <= "9") {
        const currentZone = `${Math.floor(playerPos.x / 3)},${Math.floor(playerPos.y / 3)}`;
        const cx = ((playerPos.x % 3) + 3) % 3;
        const cy = ((playerPos.y % 3) + 3) % 3;
        sendNumberWrite(currentZone, cx, cy, parseInt(e.key));
    }

    drawGrid();
});

loadPlayerData();
initWebSocket();
drawGrid();