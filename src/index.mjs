/*
 */

// import dependencies
import SteamUser from "steam-user";
import tanjun from "tanjun-log";
import gamesJSON from "./games.json" with { type: 'json' }; // I know that I should use 'assert' instead of 'with'
                                                            // but well... blame node.js.
// games to idle
const gamesToIdle = gamesJSON.idle;

// constants
const USERNAME_IDX = 0;
const PASSWORD_IDX = 1;
const EXPONENTIAL_BCKOFF = 5000;

const handleCleanup = (steamClient) => {
  const cleanup = () => {
    tanjun.print("shutting down...", "yasi-bot", "warning", "!");
    
    // stop idling games and logoff 
    steamClient.gamesPlayed([]);
    steamClient.logOff();

    // exit bot
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
    
    // exit bot
    process.exit(1);
  }

  steamClient.on('steamGuard', (_domain, callback) => {
    tanjun.print(`steam guard code needed, please type it below:`, "yasi-bot", "warning", "!");
    
    // replace this with a proper prompt in the future
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      callback(data.toString().trim());
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
      }, EXPONENTIAL_BCKOFF * reconnectAttempts); // exponential backoff
    } else {
      tanjun.print("max reconnection attempts reached. shutting down.", "yasi-bot", "error", "!!");

      // exit bot
      process.exit(1);
    }
  });
};

(function main() {
  try { 
    // init steam client wrapper api
    const steamClient = new SteamUser();
    
    // handle bot cleanup process when closing
    handleCleanup(steamClient);

    // pass login info
    const loginPayload = [process.argv[2], process.argv[3]];
    
    // perform user login
    logIn(steamClient, loginPayload);
    
    // start idling games
    idleGames(steamClient, gamesToIdle);
  } catch (e) {
    tanjun.crash(`unexpected error: ${e}`, "yasi-bot", "fatal", false, "!!!");

    // exit bot on throw
    process.exit(1);
  }
})();
