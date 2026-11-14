import { createServer, type Server } from "node:http";
import { Auth, type AuthOptions } from "./auth.ts";
import type { Config } from "./config.ts";
import { Store } from "./db.ts";
import { clientIpFor, createHttpHandler } from "./http.ts";
import { createMailer, type Mailer } from "./mailer.ts";
import { Hub, type HubOptions } from "./signaling.ts";

export interface AppOptions {
  mailer?: Mailer;
  auth?: AuthOptions;
  hub?: HubOptions;
}

export interface App {
  server: Server;
  store: Store;
  auth: Auth;
  hub: Hub;
  close(): Promise<void>;
}

/** Wires store, auth, HTTP API and signaling onto one HTTP server (not yet listening). */
export function createApp(cfg: Config, opts: AppOptions = {}): App {
  const store = new Store(cfg.dbPath);
  const auth = new Auth(cfg, store, opts.mailer ?? createMailer(cfg), opts.auth);
  const hub = new Hub(cfg, store, auth, opts.hub);
  const server = createServer(createHttpHandler({ cfg, store, auth, hub }));
  hub.attach(server, clientIpFor(cfg));
  const sweep = setInterval(() => auth.sweep(), 5 * 60_000);
  sweep.unref();

  return {
    server,
    store,
    auth,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        hub.close();
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
