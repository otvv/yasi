/*
 */

import express from "express";
import SteamUser from "steam-user";
import tanjun from "tanjun-log";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TODO: move some of these globals to a .env file

const HTML_VIEWS_DIR = path.join(__dirname, "views");
const GAMES_JSON_DIR = path.join(__dirname, "games.json");
const USERNAME_IDX = 0;
const PASSWORD_IDX = 1;
const EXPONENTIAL_BCKOFF_TIMER = 5000; // 5 seconds
const RATELIMIT_TIMER = 10 * 60 * 1000; // 10 minutes
const WEBSERVER_PORT = 1337;

// shared bot mutable state
const state = {
  sessionActive: false,
  isShuttingDown: false,
  server: null,
};

// json helpers
const readJsonFile = () => {
  return JSON.parse(fs.readFileSync(GAMES_JSON_DIR, "utf-8"));
};
const writeJsonFile = (payload) => {
  fs.writeFileSync(GAMES_JSON_DIR, JSON.stringify(payload, null, 2), "utf-8");
};

// render view helper
const renderView = (viewName, replacements = {}) => {
  let html = fs.readFileSync(path.join(HTML_VIEWS_DIR, viewName), "utf-8");
  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${token}}}`, value);
  }
  return html;
};

// web ui views wrappers
const renderGuardForm = (errorMsg) =>
  renderView("guard-form.html", {
    PORT: WEBSERVER_PORT,
    STATUS_DOT_CLASS: errorMsg ? "error" : "live",
    STATUS_LINE_CLASS: errorMsg ? "error" : "",
    STATUS_MESSAGE: errorMsg ? errorMsg : "waiting for steam guard code",
  });
const renderGuardSuccess = () =>
  renderView("guard-success.html", {
    PORT: WEBSERVER_PORT,
    SESSION_DOT_CLASS: "live",
  });
const renderGamesList = (game, isIdle) =>
  renderView("idler-list.html", {
    ROW_CHECKED_CLASS: isIdle ? "checked" : "",
    CHECKBOX_CHECKED_CLASS: isIdle ? "checked" : "",
    GAME_TITLE: game.name,
    APP_ID: game.id,

    STATUS_DOT_CLASS: "stopped",
    STATUS_LABEL_CLASS: "stopped",
    STATUS_LABEL: "not idling",
  });
const renderIdlerView = () => {
  const dataPayload = readJsonFile();
  const rows = [
    ...dataPayload.idle.map((game) => renderGamesList(game, true)),
    ...dataPayload.ignore.map((game) => renderGamesList(game, false)),
  ].join("\n");

  return renderView("idler-main.html", {
    SESSION_DOT_CLASS: "live",
    PORT: WEBSERVER_PORT,
    GAME_ROWS: rows,
  });
};

const handleCleanup = (steamClient) => {
  if (!steamClient) {
    tanjun.crash("steamClient API has not been initialized properly", "yasi-bot", "fatal", "!!!");
    process.exit(0);
  }

  const cleanup = () => {
    tanjun.print("shutting down", "yasi-bot", "warning", "!");

    // tell the server its time to shutdown
    state.isShuttingDown = true;

    steamClient.gamesPlayed([]);
    steamClient.logOff();

    if (state.server) {
      state.server.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return cleanup;
};

const startIdlerServer = (steamClient, cleanupCallback) => {
  const app = express();
  app.use(express.json());
  app.use(express.static(HTML_VIEWS_DIR));

  // reads games.json on every request so
  // the list can read the latest checkbox
  // state even after a page refresh
  app.get("/", (_req, res) => {
    res.send(renderIdlerView());
  });

  // sync sessionActive after a page refresh
  app.get("/api/state", (_req, res) => {
    res.json({ sessionActive: state.sessionActive });
  });

  app.post("/api/session/start", (_req, res) => {
    if (state.sessionActive) {
      return res.json({ ok: false, reason: "idling session is already active" });
    }

    const dataPayload = readJsonFile();
    if (!dataPayload.idle || dataPayload.idle.length === 0) {
      return res.json({ ok: false, reason: "no games selected to idle" });
    }

    // start idling games
    steamClient.gamesPlayed(dataPayload.idle.map((game) => game.id));
    state.sessionActive = true;

    tanjun.print(
      `idling: ${dataPayload.idle.map((game) => game.name).join(", ")}`,
      "yasi-bot",
      "success",
      "->",
    );

    res.json({ ok: true });
  });

  app.post("/api/games/add", (req, res) => {
    const { id, name } = req.body;
    const appId = parseInt(id, 10);

    if (!appId || appId <= 0 || !name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, reason: "invalid app id or name" });
    }

    const dataPayload = readJsonFile();
    const alreadyExists =
      dataPayload.idle.some((game) => game.id === appId) ||
      dataPayload.ignore.some((game) => game.id === appId);

    if (alreadyExists) {
      return res.json({ ok: false, reason: "game already exists in your list" });
    }

    dataPayload.ignore.push({ id: appId, name: name.trim() });
    writeJsonFile(dataPayload);

    tanjun.print(`game added: ${name.trim()} (${appId})`, "yasi-bot", "success", "->");

    res.json({ ok: true });
  });

  app.post("/api/session/stop", (_req, res) => {
    if (!state.sessionActive) {
      return res.json({ ok: false, reason: "no active idling session (idling stopped)" });
    }

    // empty games idle object and stop idle session
    steamClient.gamesPlayed([]);
    state.sessionActive = false;

    tanjun.print("idling stopped", "yasi-bot", "info", "->");

    res.json({ ok: true });
  });

  // moves a game between idle/ignore array after
  // checking/unchecking the game checkbox
  app.post("/api/games/:appId/toggle", (req, res) => {
    const appId = parseInt(req.params.appId, 10);
    const { idle: shouldIdle } = req.body;

    if (isNaN(appId) || typeof shouldIdle !== "boolean") {
      return res.status(400).json({ ok: false, reason: "invalid request" });
    }

    const dataPayload = readJsonFile();

    const inIdle = dataPayload.idle.findIndex((game) => game.id === appId);
    const inIgnore = dataPayload.ignore.findIndex((game) => game.id === appId);

    if (shouldIdle && inIdle === -1 && inIgnore !== -1) {
      // move games from ignore to idle array
      const [game] = dataPayload.ignore.splice(inIgnore, 1);
      dataPayload.idle.push(game);
    } else if (!shouldIdle && inIgnore === -1 && inIdle !== -1) {
      // move games to idle from ignore array
      const [game] = dataPayload.idle.splice(inIdle, 1);
      dataPayload.ignore.push(game);
    } else {
      return res.json({ ok: true, changed: false }); // already in the right array
    }

    writeJsonFile(dataPayload);

    res.json({ ok: true, changed: true });
  });

  // delete a single game row by appId
  app.delete("/api/games/:appId", (req, res) => {
    const appId = parseInt(req.params.appId, 10);

    if (isNaN(appId)) {
      return res.status(400).json({ ok: false, reason: "invalid app id" });
    }

    const dataPayload = readJsonFile();

    const inIdle = dataPayload.idle.findIndex((game) => game.id === appId);
    const inIgnore = dataPayload.ignore.findIndex((game) => game.id === appId);

    if (inIdle !== -1) {
      dataPayload.idle.splice(inIdle, 1);
    } else if (inIgnore !== -1) {
      dataPayload.ignore.splice(inIgnore, 1);
    } else {
      return res.json({ ok: false, reason: "game not found" });
    }

    writeJsonFile(dataPayload);
    tanjun.print(`game ${appId} removed`, "yasi-bot", "warning", "!");
    res.json({ ok: true });
  });

  // clear all games from the json file
  app.delete("/api/games", (_req, res) => {
    writeJsonFile({ idle: [], ignore: [] });

    tanjun.print("game list cleared", "yasi-bot", "warning", "!");
    res.json({ ok: true });
  });

  // shutdown bot in case the user clicks
  // in the close button
  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true }); // respond before killing the process

    cleanupCallback();
  });

  // create the persistent web server
  // to host the idler web ui
  state.server = app.listen(WEBSERVER_PORT, () => {
    tanjun.print("idler main view ready, redirecting user", "yasi-bot", "success", "->");
  });
};

const logIn = (steamClient, loginPayload) => {
  if (loginPayload.length === 0 || !loginPayload[USERNAME_IDX] || !loginPayload[PASSWORD_IDX]) {
    tanjun.crash("empty login payload", "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }

  steamClient.on("error", (err) => {
    const lowerCaseErrorMsg = (err.message || "unknown error").toLowerCase();

    tanjun.error(`steamClient API error: ${lowerCaseErrorMsg}`, "yasi-bot", "error", "!!");

    if (err.eresult === SteamUser.EResult.RateLimitExceeded) {
      tanjun.print("rate limited by steam, waiting before retrying", "yasi-bot", "error", "!!");
      setTimeout(() => {
        steamClient.logOn({
          accountName: loginPayload[USERNAME_IDX],
          password: loginPayload[PASSWORD_IDX],
        });
      }, RATELIMIT_TIMER);
    } else {
      // this will crash the app in case the steamClient API
      // throws any error other than RateLimitExceeded
      tanjun.crash("unrecoverable error, closing app", "yasi-bot", "fatal", "!!!");

      // close server too if it happens to be running already
      if (state.server) {
        state.server.close(() => process.exit(1));
      } else {
        process.exit(1);
      }
    }
  });

  steamClient.on("steamGuard", (_domain, callback) => {
    tanjun.print(
      `steam guard code needed, please visit the web interface in order to enter it`,
      "yasi-bot",
      "warning",
      "!",
    );

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(HTML_VIEWS_DIR));

    // guard server goes into state.server so cleanup can close it
    // even if loggedOn never fires
    state.server = app.listen(WEBSERVER_PORT, () => {
      tanjun.print(
        `web interface ready @ http://localhost:${WEBSERVER_PORT}`,
        "yasi-bot",
        "success",
        "->",
      );
    });

    app.get("/", (_req, res) => {
      res.send(renderGuardForm());
    });

    app.post("/", (req, res) => {
      const steamGuardCode = req.body.code;

      if (!steamGuardCode) {
        res.send(renderGuardForm("invalid code, try again"));
        tanjun.print("invalid code, please type it again", "yasi-bot", "warning", "!");
        return;
      }

      res.send(renderGuardSuccess());
      tanjun.print("code received", "yasi-bot", "success", "->");

      callback(steamGuardCode);

      // close immediately
      state.server.close(() => {
        state.server = null;
        tanjun.print("closing temporary steam guard web server", "yasi-bot", "info", "->");
      });
    });
  });

  steamClient.logOn({
    accountName: loginPayload[USERNAME_IDX],
    password: loginPayload[PASSWORD_IDX],
  });
};

const idleGames = (steamClient, loginPayload, cleanupCallback) => {
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;

  steamClient.on("loggedOn", () => {
    tanjun.print("user logged in", "yasi-bot", "success", "->");
    startIdlerServer(steamClient, cleanupCallback);
  });

  steamClient.on("disconnected", (_eresult, err) => {
    if (state.isShuttingDown) {
      return;
    }

    const lowerCaseErrorMsg = (err || "unknown error").toLowerCase();
    tanjun.print(`disconnected: ${lowerCaseErrorMsg}`, "yasi-bot", "error", "!!");

    // clear session state so the UI refreshes the
    // current idle session status on next page load
    state.sessionActive = false;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      tanjun.print(
        `attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
        "yasi-bot",
        "info",
        "->",
      );

      setTimeout(
        () => {
          steamClient.logOn({
            accountName: loginPayload[USERNAME_IDX],
            password: loginPayload[PASSWORD_IDX],
          });
        },
        EXPONENTIAL_BCKOFF_TIMER * 2 ** reconnectAttempts,
      );
    } else {
      tanjun.print("max reconnection attempts reached. shutting down", "yasi-bot", "error", "!!");
      process.exit(1);
    }
  });
};

(() => {
  try {
    const steamClient = new SteamUser();
    const loginPayload = [process.argv[2], process.argv[3]];

    const cleanup = handleCleanup(steamClient);

    logIn(steamClient, loginPayload);
    idleGames(steamClient, loginPayload, cleanup);
  } catch (err) {
    tanjun.crash(`unexpected error: ${err?.message?.toLowerCase()}`, "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }
})();
