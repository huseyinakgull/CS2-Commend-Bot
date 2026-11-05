# CommendBotAuth

CounterStrikeSharp eklentisi. Bot hesaplarının Steam auth ticket'larını RCON üzerinden alır ve sunucu tarafında `BeginAuthSession` çağırarak botları sunucuda oturum açmış gibi kaydeder.

## Gereksinimler

- CS2 dedicated server
- Metamod:Source 2.x
- CounterStrikeSharp (runtime dahil sürüm)
- .NET 8 SDK

## Derleme

```bash
cd server-plugin
dotnet build -c Release
```

Çıktı: `bin/Release/net8.0/CommendBotAuth.dll`

## Kurulum

1. DLL'i sunucuya kopyala:

```
game/csgo/addons/counterstrikesharp/plugins/CommendBotAuth/CommendBotAuth.dll
```

2. `cs2-server/game/csgo/cfg/autoexec.cfg` içinde `rcon_password` ve `sv_password` değerlerini ayarla.
3. Sunucuyu yeniden başlat.

## RCON komutları

`css_auth_data`, `css_auth_go`, `css_auth_end`, `css_auth_clear`, `css_is_on_server`, `css_who`, `css_allow_target`, `css_disallow_target`, `css_allow_list`, `css_allow_clear`, `css_show_started`, `css_show_progress`, `css_show_done`, `css_show_clear`

## Akış

1. Bot hesabı Steam'e giriş yapar ve auth ticket oluşturur.
2. Ticket RCON ile sunucuya gönderilir.
3. Eklenti `BeginAuthSession` çağırır.
4. Steam/GC botu sunucuda kayıtlı görür.
5. Bot GC üzerinden commend mesajını gönderir.
