# `yasi-bot`
_(yet another steam idler bot)_

a very simple bot that allows you to idle multiple steam games simultaneously to accumulate playtime hours.

## tech stack
- node.js
- npm

## npm packages used
- [`steam-user`](https://www.npmjs.com/package/steam-user) - steam client API wrapper for node.js
- [`tanjun-log`](https://www.npmjs.com/package/tanjun-log) - simple logging utility

## features
- multi-game idling
- steam-guard support
- auto-reconnect with exponential backoff
- clean process handling

## installation
1. clone the repository using git or download the zip.
2. install dependencies:
```bash
npm install
```
3. run the bot using: 
```bash
npm start
```

## usage
1. configure the games that you want to idle in `games.json` following the example below:

```json
{
  "idle": [
    {
      "id": 1643320, // you can get the game AppID using SteamDB, or going into the game properties in your Steam library
      "name": "S.T.A.L.K.E.R. 2: Heart of Chornobyl" // this doesn't need to be the game title, can be anything, 
                                                     // its just a way for you to identify which game is being idle
    },
    {
      "id": 4500,
      "name": "S.T.A.L.K.E.R.: Shadow of Chernobyl"
    }
  ],
  "ignore": [ // reference only, you can interpret it as a "backup" of sorts
    {
      "id": 306130,
      "name": "The Elder Scrolls Online"
    }
  ]
}
```

_**note**_: the "ignore" section is for your reference only. the bot will only idle games listed in the idle array.

2. run the bot using:
```bash
npm start <username> <password>

```
 _replace `<username>` and `<password>` with your Steam credentials_.

_**note**_: if you have Steam Guard enabled, you'll be prompted to enter the code when logging in.

***

### LICENSE

this project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.