/*
 */

import express from 'express';
import SteamUser from "steam-user";
import tanjun from "tanjun-log";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import gamesJSON from "./games.json" with { type: 'json' }; // I know that I should use 'assert' instead of 'with'
                                                            // but well... blame node.js.
// 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// games to idle object
const gamesToIdle = gamesJSON.idle;

const VIEWS_DIR = path.join(__dirname, "views");
const USERNAME_IDX = 0;
const PASSWORD_IDX = 1;
const EXPONENTIAL_BCKOFF_TIMER = 5000; // 5 seconds
const RATELIMIT_TIMER = (10 * 60 * 1000) // 10 minutes
const TIMEOUT_TIME = 10000;
const WEBSERVER_PORT = 1337;


const renderView = (viewName, replacements = {}) => {
  const templatePath = path.join(VIEWS_DIR, viewName);
  let html = fs.readFileSync(templatePath, "utf-8");

  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${token}}}`, value);
  }

  return html;
};

const renderGuardForm = (errorMsg) => renderView("guard-form.html", {
  PORT: WEBSERVER_PORT,
  STATUS_DOT_CLASS: errorMsg ? "error" : "live",
  STATUS_LINE_CLASS: errorMsg ? "error" : "",
  STATUS_MESSAGE: errorMsg ? errorMsg : "waiting for steam guard code",
});

const renderGuardSuccess = () => renderView("guard-success.html", {
  PORT: WEBSERVER_PORT,
});

const handleCleanup = (steamClient) => {
  if (!steamClient) {
    tanjun.crash("steamClient API has not been initialized properly", "yasi-bot", "error", "!!");
    return;
  }

  const cleanup = () => {
    tanjun.print("shutting down", "yasi-bot", "warning", "!");

    // stop idling games and logoff
    steamClient.gamesPlayed([]);
    steamClient.logOff();

    process.exit(0);
  };

  // in case the process is killed or closed unexpectedly
  // run the cleanup process
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
};

const logIn = (steamClient, loginPayload, idleCallback) => {
  if (loginPayload.length === 0 || (!loginPayload[USERNAME_IDX] || !loginPayload[PASSWORD_IDX])) {
    tanjun.crash("empty login payload", "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }

  // handle steam api rate-limit
  steamClient.on("error", (e) => {
    tanjun.print(`steam client error: ${e.message || e}`, "yasi-bot", "error", "!!");

    if (e.eresult === SteamUser.EResult.RateLimitExceeded) {
      tanjun.print("rate limited by steam, waiting before retrying", "yasi-bot", "error", "!!");
      setTimeout(
        () => {
          steamClient.logOn({
            accountName: loginPayload[USERNAME_IDX],
            password: loginPayload[PASSWORD_IDX],
          });
        },
        RATELIMIT_TIMER,
      );
    }
  });

  steamClient.on("steamGuard", (_domain, callback) => {
    tanjun.print(
      `steam guard code needed, please visit: http://localhost:${WEBSERVER_PORT} to enter it.`,
      "yasi-bot",
      "warning",
      "!",
    );

    let steamGuardCode = null;

    // initialize web server and web ui 
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(VIEWS_DIR));

    let server = app.listen(WEBSERVER_PORT, () => {
      tanjun.print(
        `web interface ready @ http://localhost:${WEBSERVER_PORT}`,
        "yasi-bot",
        "success",
        "->",
      );
    });

    // render steam guard prompt panel
    app.get("/", (_req, res) => {
      res.send(renderGuardForm());
    });

    // send code back to the server
    app.post("/", (req, res) => {
      // get code from request
      steamGuardCode = req.body.code;

      if (!steamGuardCode) {
        res.send(renderGuardForm("invalid code, try again"));
        tanjun.print("invalid code, please type it again (RELOAD THE PAGE)", "yasi-bot", "warning", "!");
        return;
      }

      res.send(renderGuardSuccess());
      tanjun.print("code received, you can close the page now", "yasi-bot", "success", "->");

      // send code back to yasi-bot
      callback(steamGuardCode);

      // close web server after 10 seconds
      // NOTE: temporary, this will be turned into a standalone 
      // function once all the web ui views are finished 
      setTimeout(
        () =>
          server.close((_err) => {
            tanjun.print("stopping web server from receiving new connections", "yasi-bot", "warning", "!");
          }),
        TIMEOUT_TIME,
      );
    });
  });

  steamClient.logOn({
    accountName: loginPayload[USERNAME_IDX],
    password: loginPayload[PASSWORD_IDX],
  });
};

const idleGames = (steamClient, gamesArr, loginPayload) => {
  if (!Array.isArray(gamesArr) || gamesArr.length === 0) {
    tanjun.print("no games provided for idling", "yasi-bot", "warning", "!");
    return;
  }

  steamClient.on("loggedOn", () => {
    tanjun.print("user logged in", "yasi-bot", "success", "->");

    const gamesBeingIdle = [];
    gamesArr.forEach((game) => {
      // populate array for later use
      gamesBeingIdle.push(game.name);
    });

    // run games
    steamClient.gamesPlayed(gamesArr.map((game) => game.id));
    tanjun.print(`idling games: ${gamesBeingIdle.join(", ")}`, "yasi-bot", "info", "->");
  });

  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;

  steamClient.on("disconnected", (_eresult, msg) => {
    tanjun.print(`disconnected: ${msg || 'unknown reason'}`, "yasi-bot", "error", "!!");

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      tanjun.print(`attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, "yasi-bot", "info", "->");

      setTimeout(() => {
        steamClient.logOn({
          accountName: loginPayload[USERNAME_IDX],
          password: loginPayload[PASSWORD_IDX],
        });
      }, EXPONENTIAL_BCKOFF_TIMER * 2 ** reconnectAttempts);
    } else {
      tanjun.print("max reconnection attempts reached. shutting down", "yasi-bot", "error", "!!");
      process.exit(1);
    }
  });
};

(() => {
  try {
    // init steam client wrapper api
    const steamClient = new SteamUser();

    handleCleanup(steamClient);

    // parse login info
    const loginPayload = [process.argv[2], process.argv[3]];

    logIn(steamClient, loginPayload);

    // start idling games
    idleGames(steamClient, gamesToIdle, loginPayload);
  } catch (e) {
    tanjun.crash(`unexpected error: ${e}`, "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }
})();
