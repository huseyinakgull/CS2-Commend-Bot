<h1 align="center">CS Commends</h1>

<p align="center">
  Counter-Strike 2 için commend, saat boost ve Steam grup otomasyonu.
  <br>
  <a href="README.md">English</a>
</p>

---

> **Yalnızca eğitim amaçlıdır.** Bu proje Steam istemci protokolünü, CS2 Game Coordinator'ü ve CounterStrikeSharp eklentilerini öğrenmek için yapıldı. Bot hesapları bu şekilde kullanmak Steam Abonelik Sözleşmesi'ne aykırıdır ve hesapların yasaklanmasına yol açabilir. Kullanım sorumluluğu sana aittir.

## Ne yapar

Web panel sipariş alır, Steam bot hesaplarından oluşan havuz siparişi tamamlar:

- **Commend** – Friendly, Teaching, Leader
- **Saat boost** – Steam'de oyun saati kasar
- **Grup üyeliği** – botları bir Steam grubuna ekler

Ayrıca müşteri, bayi ve admin panelleri, kripto ödeme ve pazar yeri entegrasyonları içerir.

## Teknolojiler

Node.js · Express · SQLite · steam-user · CounterStrikeSharp (C#)

## Yapı

```
web/             web panel, API, veritabanı, arka plan servisleri
commend-single.js  tekil commend işçisi (her bot için ayrı süreç)
server-plugin/   bot oturumları için CounterStrikeSharp eklentisi
cs2-server/      CS2 sunucu başlatma betiği ve ayarlar
helpers/         RCON istemcisi, protobuf yükleyici
protobufs/       Steam ve CS2 protobuf tanımları
```

## Hızlı başlangıç

```bash
npm ci && cd web && npm ci && cd ..

cp .env.example .env
cp config.example.json config.json
cp web/config.example.json web/config.json
cp accounts.example.json accounts.json
cp web/proxies.example.json web/proxies.json

node service.js
```

Botlar için Metamod:Source, CounterStrikeSharp ve `CommendBotAuth` eklentisi kurulu, şifre korumalı bir CS2 sunucusu gerekir. Bkz. [server-plugin/KURULUM.md](server-plugin/KURULUM.md).

Sadece Windows Server üzerinde denendi.

## Geliştirme

```bash
npm test
npm run check
```

## Teşekkürler

[node-steam-user](https://github.com/DoctorMcKay/node-steam-user) ·
[SteamDatabase/Protobufs](https://github.com/SteamDatabase/Protobufs) ·
[CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) ·
[BeepIsla/csgo-commend-bot](https://github.com/BeepIsla/csgo-commend-bot) ·
[Juknum/counter-strike-icons](https://github.com/Juknum/counter-strike-icons) ·
[MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons) ·
[vgalisson/csgo-map-icons](https://github.com/vgalisson/csgo-map-icons)

Counter-Strike ve CS2, Valve Corporation'ın ticari markalarıdır. Bu proje Valve ile bağlantılı değildir.

## Lisans

[AGPL-3.0](LICENSE)
