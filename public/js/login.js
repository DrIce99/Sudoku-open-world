// Configura le tue chiavi client Firebase
const firebaseConfig = {
    apiKey: "AIzaSyBx8cUP4IdSiFmJNurBianw5UlAzjrKuqA",
    authDomain: "infinite-doku.firebaseapp.com",
    databaseURL: "https://infinite-doku-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "infinite-doku",
    storageBucket: "infinite-doku.firebasestorage.app",
    messagingSenderId: "801642045128",
    appId: "1:801642045128:web:b9c5f993234b2ada414ffd",
    measurementId: "G-8BYGKZWDKK"
};

firebase.initializeApp(firebaseConfig);
const provider = new firebase.auth.GoogleAuthProvider();

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("google-login-btn").addEventListener("click", async () => {
        try {
            const result = await firebase.auth().signInWithPopup(provider);
            const idToken = await result.user.getIdToken();

            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken })
            });

            const data = await res.json();

            if (data.status === "need_username") {
                document.getElementById("login-section").classList.add("hidden");
                document.getElementById("username-section").classList.remove("hidden");
            } else if (data.status === "success") {
                window.location.href = "/";
            }
        } catch (err) {
            alert("Errore di autenticazione: " + err.message);
        }
    });

    document.getElementById("save-username-btn").addEventListener("click", async () => {
        const username = document.getElementById("username-input").value;
        const res = await fetch("/api/set-username", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (data.status === "success") {
            window.location.href = "/";
        } else {
            alert(data.message);
        }
    });


    document.getElementById("guest-login-btn")?.addEventListener("click", async () => {
        try {
            const res = await fetch("/api/guest-login", { method: "POST" });
            const data = await res.json();
            if (data.status === "success") {
                window.location.href = "/game";
            }
        } catch (err) {
            console.warn("Server offline, reindirizzamento diretto al gioco.");
            window.location.href = "/game";
        }
    });
});
