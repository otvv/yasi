/*
 */

import express from 'express';
import SteamUser from "steam-user";
import tanjun from "tanjun-log";
import gamesJSON from "./games.json" with { type: 'json' }; // I know that I should use 'assert' instead of 'with'
                                                            // but well... blame node.js.
// games to idle object
const gamesToIdle = gamesJSON.idle;

const USERNAME_IDX = 0;
const PASSWORD_IDX = 1;
const EXPONENTIAL_BCKOFF = 5000;
const TIMEOUT_TIME = 5000;
const WEBSERVER_PORT = 1337;

const handleCleanup = (steamClient) => {
  if (!steamClient) {
    tanjun.crash("steamClient API has not been initialized properly.", "yasi-bot", "error", "!!");
    return;
  }

  const cleanup = () => {
    tanjun.print("shutting down...", "yasi-bot", "warning", "!");
    
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
    tanjun.crash("empty login payload.", "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }

  steamClient.on('steamGuard', (_domain, callback) => {
    tanjun.print(`steam guard code needed, please visit: http://localhost:${WEBSERVER_PORT} to enter it.`, "yasi-bot", "warning", "!");
    
    let steamGuardCode = null;

    // initialize web server
    const app = express();
    app.use(express.urlencoded({ extended: true }));

    app.listen(WEBSERVER_PORT, () => {
      tanjun.print(`web interface ready @ http://localhost:${WEBSERVER_PORT}`, "yasi-bot", "success", "->")
    });

    // create steam guard code prompt
    // TODO: stylize it at some point
    app.get('/', (_req, res) => {
      res.send(`
        <form method="POST">
          <label>Steam Guard Code:</label>
          <input name="code" required />
          <button type="submit">Submit</button>
        </form>
      `);
    });

    // after the user types the steam-guard 
    // code in the prompt send it back to yasi bot 
    app.post('/', (req, res) => {
      // get typed-in code from request
      steamGuardCode = req.body.code;

      if (!steamGuardCode) {
        res.send('[yasi-bot] - invalid code, please type it again. (RELOAD THE PAGE)');
        tanjun.print("invalid code, please type it again (RELOAD THE PAGE)", "yasi-bot", "warning", "!");
      }

      res.send('[yasi-bot] - code received. you can close this page now.');
      tanjun.print("invalid code, please type it again (RELOAD THE PAGE)", "yasi-bot", "warning", "!");


      // send code back to yasibot
      callback(steamGuardCode);

      // auto exit after 5 seconds
       setTimeout(() => process.exit(0), TIMEOUT_TIME);
    });
  });

  steamClient.logOn({
    accountName: loginPayload[USERNAME_IDX],
    password: loginPayload[PASSWORD_IDX],
  });
};

const idleGames = (steamClient, gamesArr) => {
  if (!Array.isArray(gamesArr) || gamesArr.length === 0) {
    tanjun.print("no games provided for idling", "yasi-bot", "warning", "!");
    return;
  }

  steamClient.on("loggedOn", () => {
    tanjun.print("user logged in!", "yasi-bot", "success", "->");

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
      tanjun.print(`attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, "yasi-bot", "info", "->");
      
      setTimeout(() => {
        steamClient.logOn({
          accountName: process.argv[2],
          password: process.argv[3],
        });
      }, EXPONENTIAL_BCKOFF * reconnectAttempts);
    } else {
      tanjun.print("max reconnection attempts reached. shutting down.", "yasi-bot", "error", "!!");
      process.exit(1);
    }
  });
};

(() =>  {
  try { 
    // init steam client wrapper api
    const steamClient = new SteamUser();
    
    handleCleanup(steamClient);

    // parse login info
    const loginPayload = [process.argv[2], process.argv[3]];
    
    logIn(steamClient, loginPayload);
    
    // start idling games
    idleGames(steamClient, gamesToIdle);
  } catch (e) {
    tanjun.crash(`unexpected error: ${e}`, "yasi-bot", "fatal", false, "!!!");
    process.exit(1);
  }
})();
