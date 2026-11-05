<h1 align="center">CS Commends</h1>

<p align="center">
  Counter-Strike 2 commend, hours boost and Steam group automation.
  <br>
  <a href="README.tr.md">Türkçe</a>
</p>

---

> **For educational purposes only.** This project was built to study the Steam client protocol, the CS2 Game Coordinator and CounterStrikeSharp plugins. Using bot accounts this way violates the Steam Subscriber Agreement and can get accounts banned. Use at your own risk.

## What it does

A web panel takes orders, and a pool of Steam bot accounts fulfils them:

- **Commends** – Friendly, Teaching, Leader
- **Hours boost** – idles games on Steam
- **Group join** – adds bots to a Steam group

It also has customer, reseller and admin panels, crypto payments and marketplace integrations.

## Stack

Node.js · Express · SQLite · steam-user · CounterStrikeSharp (C#)

## Structure

```
web/             web panel, API, database, background services
commend-single.js  single commend worker (one process per bot)
server-plugin/   CounterStrikeSharp plugin for bot auth sessions
cs2-server/      CS2 server start script and configs
helpers/         RCON client, protobuf loader
protobufs/       Steam and CS2 protobuf definitions
```

## Quick start

```bash
npm ci && cd web && npm ci && cd ..

cp .env.example .env
cp config.example.json config.json
cp web/config.example.json web/config.json
cp accounts.example.json accounts.json
cp web/proxies.example.json web/proxies.json

node service.js
```

The bots need a password protected CS2 server with Metamod:Source, CounterStrikeSharp and the `CommendBotAuth` plugin. See [server-plugin/KURULUM.md](server-plugin/KURULUM.md).

Tested on Windows Server only.

## Development

```bash
npm test
npm run check
```

## Credits

[node-steam-user](https://github.com/DoctorMcKay/node-steam-user) ·
[SteamDatabase/Protobufs](https://github.com/SteamDatabase/Protobufs) ·
[CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) ·
[BeepIsla/csgo-commend-bot](https://github.com/BeepIsla/csgo-commend-bot) ·
[Juknum/counter-strike-icons](https://github.com/Juknum/counter-strike-icons) ·
[MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons) ·
[vgalisson/csgo-map-icons](https://github.com/vgalisson/csgo-map-icons)

Counter-Strike and CS2 are trademarks of Valve Corporation. This project is not affiliated with Valve.

## License

[AGPL-3.0](LICENSE)
