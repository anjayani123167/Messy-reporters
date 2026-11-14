import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[config] ${(e as Error).message}`);
  process.exit(1);
}

const app = createApp(cfg);
app.server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`[server] ${cfg.appName} listening on http://${cfg.bindHost}:${cfg.port}`);
  console.log(`[server] sign-in allowed for: ${cfg.allowedDomains.map((d) => "@" + d).join(", ")}`);
  console.log(`[server] TURN relay: ${cfg.turn ? `${cfg.turn.host}:${cfg.turn.port}` : "not configured (same-network / easy NAT only)"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[server] ${sig}, shutting down`);
    app.close().then(() => process.exit(0));
  });
}
