"use strict";
const q = new URLSearchParams(location.search);
const what = q.get("mode") === "view" ? "Layar dilihat oleh" : "Dikendalikan oleh";
document.getElementById("text").textContent = `${what} ${q.get("email") || "?"}`;
document.getElementById("end").addEventListener("click", () => window.od.endHosting());
