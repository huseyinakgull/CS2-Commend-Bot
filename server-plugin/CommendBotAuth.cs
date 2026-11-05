using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace CommendBotAuth;

// Lets bot accounts appear as authenticated players on this server without
// actually joining it. The Node service uploads each bot's Steam auth ticket over
// RCON and the plugin passes it to ISteamGameServer::BeginAuthSession. The plugin
// also posts order progress to the target player's chat and keeps real players
// in spectator mode.
public class CommendBotAuth : BasePlugin
{
    public override string ModuleName => "CommendBotAuth";
    public override string ModuleVersion => "1.7.0";
    public override string ModuleAuthor => "CS Commends";
    public override string ModuleDescription => "Bot auth sessions, order progress chat messages and spectator enforcement";

    // RCON commands are length limited, so a ticket arrives as several
    // css_auth_data chunks followed by css_auth_go.
    private string _ticketBuffer = "";

    private readonly List<ulong> _authenticatedBots = new();

    private readonly Dictionary<ulong, DateTime> _allowedTargets = new();
    private const int WHITELIST_TTL_MINUTES = 60;

    private class ProgressInfo
    {
        public int Current;
        public int Total;
        public int Success;
        public int Fail;
        public string OrderId = "";
        public string Status = "active";
        public int LastAnnouncedPct = -1;
        public DateTime ExpiresAt;
    }
    private readonly Dictionary<ulong, ProgressInfo> _progress = new();
    private CounterStrikeSharp.API.Modules.Timers.Timer? _maintenanceTimer;

    public override void Load(bool hotReload)
    {
        Console.WriteLine("[CommendBotAuth] Plugin v1.7.0 loaded");
        Console.WriteLine("[CommendBotAuth] Auth: css_auth_data, css_auth_go, css_auth_end, css_auth_clear");
        Console.WriteLine("[CommendBotAuth] Chat: css_show_started, css_show_progress, css_show_done, css_show_clear");
        Console.WriteLine("[CommendBotAuth] Whitelist: css_allow_target, css_disallow_target, css_allow_clear, css_allow_list");

        _maintenanceTimer = AddTimer(30.0f, () => { CleanupExpiredWhitelist(); CleanupExpiredProgress(); CleanupRecentlySpecced(); }, TimerFlags.REPEAT);

        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);

    }

    private readonly Dictionary<ulong, DateTime> _recentlySpecced = new();
    private const int CHANGE_TEAM_COOLDOWN_SEC = 10;

    private void CleanupRecentlySpecced()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-5);
        var stale = new List<ulong>();
        foreach (var kvp in _recentlySpecced)
            if (kvp.Value < cutoff) stale.Add(kvp.Key);
        foreach (var sid in stale) _recentlySpecced.Remove(sid);
    }

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (player == null || !player.IsValid || player.IsBot || player.IsHLTV) return HookResult.Continue;

        ulong sid;
        try { sid = player.SteamID; } catch { return HookResult.Continue; }

        if (_recentlySpecced.TryGetValue(sid, out var lastTs))
        {
            if ((DateTime.UtcNow - lastTs).TotalSeconds < CHANGE_TEAM_COOLDOWN_SEC)
            {
                return HookResult.Continue;
            }
        }
        _recentlySpecced[sid] = DateTime.UtcNow;

        // The team change is deferred because it is ignored if issued while the
        // client is still finishing the connection.
        AddTimer(2.0f, () =>
        {
            try
            {
                if (!player.IsValid) return;
                if (player.Team != CsTeam.Spectator)
                {
                    player.ChangeTeam(CsTeam.Spectator);
                }
                player.PrintToChat($" {ChatColors.Gold}[CS Commends] {ChatColors.White}Hoş geldin! İzleyici modunda kal, övgü işlemin başlayınca bildirim alacaksın. {ChatColors.Gold}cscommends.com");
            }
            catch (Exception ex) { Console.WriteLine($"[CommendBotAuth] OnPlayerConnectFull err: {ex.Message}"); }
        });
        return HookResult.Continue;
    }

    private void CleanupExpiredWhitelist()
    {
        var now = DateTime.UtcNow;
        var expired = new List<ulong>();
        foreach (var kvp in _allowedTargets)
            if (kvp.Value < now) expired.Add(kvp.Key);
        foreach (var sid in expired) _allowedTargets.Remove(sid);
    }

    private void CleanupExpiredProgress()
    {
        var now = DateTime.UtcNow;
        var expired = new List<ulong>();
        foreach (var kvp in _progress)
            if (kvp.Value.ExpiresAt < now) expired.Add(kvp.Key);
        foreach (var sid in expired) _progress.Remove(sid);
    }

    private void AllowTargetInternal(ulong sid)
    {
        _allowedTargets[sid] = DateTime.UtcNow.AddMinutes(WHITELIST_TTL_MINUTES);
    }

    [ConsoleCommand("css_auth_data", "Buffer ticket hex data (chunked)")]
    [CommandHelper(minArgs: 1, usage: "<hex_chunk>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAuthData(CCSPlayerController? player, CommandInfo command)
    {
        string chunk = command.GetArg(1);
        _ticketBuffer += chunk;
        Console.WriteLine($"[CommendBotAuth] Buffered {chunk.Length} hex chars (total: {_ticketBuffer.Length})");
        command.ReplyToCommand($"OK buffered {_ticketBuffer.Length}");
    }

    [ConsoleCommand("css_auth_go", "Authenticate bot with buffered ticket data")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAuthGo(CCSPlayerController? player, CommandInfo command)
    {
        string steamId64Str = command.GetArg(1);

        if (!ulong.TryParse(steamId64Str, out ulong steamId64))
        {
            command.ReplyToCommand("ERR invalid_steamid");
            _ticketBuffer = "";
            return;
        }

        if (string.IsNullOrEmpty(_ticketBuffer) || _ticketBuffer.Length < 20)
        {
            command.ReplyToCommand("ERR no_ticket_data");
            _ticketBuffer = "";
            return;
        }

        byte[] ticketBytes;
        try
        {
            ticketBytes = HexToBytes(_ticketBuffer);
        }
        catch (Exception ex)
        {
            command.ReplyToCommand($"ERR bad_hex: {ex.Message}");
            _ticketBuffer = "";
            return;
        }

        int totalBytes = ticketBytes.Length;
        _ticketBuffer = "";

        Console.WriteLine($"[CommendBotAuth] BeginAuthSession for {steamId64} ({totalBytes} bytes)...");

        try
        {
            int result = CallBeginAuthSession(ticketBytes, steamId64);
            // EBeginAuthSessionResult from the Steamworks SDK.
            string resultName = result switch
            {
                0 => "OK",
                1 => "InvalidTicket",
                2 => "DuplicateRequest",
                3 => "InvalidVersion",
                4 => "GameMismatch",
                5 => "ExpiredTicket",
                _ => $"Unknown({result})"
            };

            Console.WriteLine($"[CommendBotAuth] Result: {resultName} ({result})");
            command.ReplyToCommand($"AUTH {result} {resultName}");

            if (result == 0)
            {
                _authenticatedBots.Add(steamId64);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CommendBotAuth] Error: {ex.Message}");
            command.ReplyToCommand($"ERR exception: {ex.Message}");
        }
    }

    [ConsoleCommand("css_auth_end", "End auth session for a bot")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAuthEnd(CCSPlayerController? player, CommandInfo command)
    {
        if (ulong.TryParse(command.GetArg(1), out ulong steamId64))
        {
            try
            {
                CallEndAuthSession(steamId64);
                _authenticatedBots.Remove(steamId64);
                Console.WriteLine($"[CommendBotAuth] Ended auth for {steamId64}");
                command.ReplyToCommand($"OK ended {steamId64}");
            }
            catch (Exception ex)
            {
                command.ReplyToCommand($"ERR {ex.Message}");
            }
        }
    }

    [ConsoleCommand("css_auth_clear", "Clear all bot auth sessions")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAuthClear(CCSPlayerController? player, CommandInfo command)
    {
        foreach (var sid in _authenticatedBots)
        {
            try { CallEndAuthSession(sid); } catch {}
        }
        int count = _authenticatedBots.Count;
        _authenticatedBots.Clear();
        _ticketBuffer = "";
        Console.WriteLine($"[CommendBotAuth] Cleared {count} auth sessions");
        command.ReplyToCommand($"OK cleared {count}");
    }

    [ConsoleCommand("css_is_on_server", "Check if player is connected to server")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnIsOnServer(CCSPlayerController? player, CommandInfo command)
    {
        string arg = command.GetArg(1);
        if (!ulong.TryParse(arg, out ulong target))
        {
            command.ReplyToCommand($"ERR invalid_steamid {arg}");
            return;
        }

        bool found = false;
        try
        {
            foreach (var p in Utilities.GetPlayers())
            {
                if (p == null || !p.IsValid) continue;
                if (p.IsBot || p.IsHLTV) continue;
                var sid = p.SteamID;
                if (sid == target)
                {
                    found = true;
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            command.ReplyToCommand($"ERR lookup_failed {ex.Message}");
            return;
        }

        command.ReplyToCommand(found ? $"ON {target}" : $"OFF {target}");
    }

    [ConsoleCommand("css_who", "Dump all connected player steamid64s")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnWho(CCSPlayerController? player, CommandInfo command)
    {
        var ids = new List<string>();
        try
        {
            foreach (var p in Utilities.GetPlayers())
            {
                if (p == null || !p.IsValid) continue;
                if (p.IsBot || p.IsHLTV) continue;
                ids.Add(p.SteamID.ToString());
            }
        }
        catch (Exception ex)
        {
            command.ReplyToCommand($"ERR who_failed {ex.Message}");
            return;
        }

        command.ReplyToCommand($"WHO {string.Join(",", ids)}");
    }

    public override void Unload(bool hotReload)
    {
        _maintenanceTimer?.Kill();
        _progress.Clear();
        _allowedTargets.Clear();
        foreach (var sid in _authenticatedBots)
        {
            try { CallEndAuthSession(sid); } catch {}
        }
        _authenticatedBots.Clear();
    }

    private CCSPlayerController? FindPlayer(ulong steamId)
    {
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
            if (p.SteamID == steamId) return p;
        }
        return null;
    }

    [ConsoleCommand("css_show_started", "Sipariş başladı chat duyurusu")]
    [CommandHelper(minArgs: 2, usage: "<steamid64> <total> [orderId]", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnShowStarted(CCSPlayerController? player, CommandInfo command)
    {
        if (!ulong.TryParse(command.GetArg(1), out ulong sid)) { command.ReplyToCommand("ERR sid"); return; }
        if (!int.TryParse(command.GetArg(2), out int total)) { command.ReplyToCommand("ERR total"); return; }
        string orderId = command.ArgCount > 3 ? command.GetArg(3) : "";

        AllowTargetInternal(sid);

        _progress[sid] = new ProgressInfo
        {
            Current = 0, Total = total, OrderId = orderId,
            Status = "active",
            LastAnnouncedPct = 0,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        };

        var p = FindPlayer(sid);
        if (p != null)
        {
            p.PrintToChat($" {ChatColors.Gold}★ [CS Commends] {ChatColors.White}Övgü işlemin {ChatColors.Green}başladı{ChatColors.White}!");
            p.PrintToChat($" {ChatColors.LightBlue}Toplam: {ChatColors.Green}{total} commend{ChatColors.LightBlue} gönderilecek.");
            if (!string.IsNullOrEmpty(orderId))
                p.PrintToChat($" {ChatColors.Grey}Sipariş #{orderId}");
            p.PrintToChat($" {ChatColors.Grey}İşlem süresince izleyici modunda kalman gerekiyor — sunucudan ayrılma.");
        }
        Console.WriteLine($"[CommendBotAuth] Chat started: {sid} total={total} order={orderId}");
        command.ReplyToCommand($"OK started {sid} total={total}");
    }

    [ConsoleCommand("css_show_progress", "Progress güncelle (milestone bazlı chat: %25/50/75)")]
    [CommandHelper(minArgs: 3, usage: "<steamid64> <current> <total>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnShowProgress(CCSPlayerController? player, CommandInfo command)
    {
        if (!ulong.TryParse(command.GetArg(1), out ulong sid)) { command.ReplyToCommand("ERR sid"); return; }
        if (!int.TryParse(command.GetArg(2), out int current)) { command.ReplyToCommand("ERR cur"); return; }
        if (!int.TryParse(command.GetArg(3), out int total)) { command.ReplyToCommand("ERR total"); return; }

        AllowTargetInternal(sid);

        if (!_progress.ContainsKey(sid))
        {
            _progress[sid] = new ProgressInfo
            {
                Status = "active",
                LastAnnouncedPct = 0,
                ExpiresAt = DateTime.UtcNow.AddHours(1)
            };
        }
        var info = _progress[sid];
        info.Current = current;
        info.Total = total;
        info.Status = "active";
        info.ExpiresAt = DateTime.UtcNow.AddHours(1);

        int pct = total > 0 ? (current * 100 / total) : 0;
        int currentMilestone = pct switch
        {
            >= 75 => 75,
            >= 50 => 50,
            >= 25 => 25,
            _ => 0
        };

        if (currentMilestone > info.LastAnnouncedPct)
        {
            info.LastAnnouncedPct = currentMilestone;
            var p = FindPlayer(sid);
            if (p != null && currentMilestone > 0)
            {
                p.PrintToChat($" {ChatColors.Gold}★ [CS Commends] {ChatColors.LightBlue}İlerleme: {ChatColors.Green}%{currentMilestone}{ChatColors.LightBlue} ({current}/{total})");
            }
        }

        command.ReplyToCommand($"OK progress {current}/{total} pct={pct} milestone={currentMilestone}");
    }

    [ConsoleCommand("css_allow_target", "Whitelist a SteamID (active order target)")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAllowTarget(CCSPlayerController? player, CommandInfo command)
    {
        if (!ulong.TryParse(command.GetArg(1), out ulong sid)) { command.ReplyToCommand("ERR sid"); return; }
        AllowTargetInternal(sid);
        Console.WriteLine($"[CommendBotAuth] Whitelisted: {sid} (count={_allowedTargets.Count})");
        command.ReplyToCommand($"OK allowed {sid} count={_allowedTargets.Count}");
    }

    [ConsoleCommand("css_disallow_target", "Remove SteamID from whitelist")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnDisallowTarget(CCSPlayerController? player, CommandInfo command)
    {
        if (!ulong.TryParse(command.GetArg(1), out ulong sid)) { command.ReplyToCommand("ERR sid"); return; }
        bool removed = _allowedTargets.Remove(sid);
        Console.WriteLine($"[CommendBotAuth] Removed from whitelist: {sid} (was present: {removed})");
        command.ReplyToCommand($"OK removed={removed} count={_allowedTargets.Count}");
    }

    [ConsoleCommand("css_allow_clear", "Clear all whitelisted targets")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAllowClear(CCSPlayerController? player, CommandInfo command)
    {
        int n = _allowedTargets.Count;
        _allowedTargets.Clear();
        Console.WriteLine($"[CommendBotAuth] Cleared whitelist ({n} entries)");
        command.ReplyToCommand($"OK cleared {n}");
    }

    [ConsoleCommand("css_allow_list", "List all whitelisted SteamIDs")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAllowList(CCSPlayerController? player, CommandInfo command)
    {
        var ids = new List<string>();
        foreach (var kvp in _allowedTargets)
        {
            int minutesLeft = (int)(kvp.Value - DateTime.UtcNow).TotalMinutes;
            ids.Add($"{kvp.Key}:{minutesLeft}m");
        }
        command.ReplyToCommand($"LIST count={_allowedTargets.Count} entries=[{string.Join(",", ids)}]");
    }

    [ConsoleCommand("css_show_done", "İşlem tamamlandı chat duyurusu")]
    [CommandHelper(minArgs: 3, usage: "<steamid64> <success> <total>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnShowDone(CCSPlayerController? player, CommandInfo command)
    {
        if (!ulong.TryParse(command.GetArg(1), out ulong sid)) { command.ReplyToCommand("ERR sid"); return; }
        if (!int.TryParse(command.GetArg(2), out int success)) { command.ReplyToCommand("ERR success"); return; }
        if (!int.TryParse(command.GetArg(3), out int total)) { command.ReplyToCommand("ERR total"); return; }

        if (!_progress.ContainsKey(sid))
        {
            _progress[sid] = new ProgressInfo();
        }
        _progress[sid].Current = success;
        _progress[sid].Success = success;
        _progress[sid].Total = total;
        _progress[sid].Status = "done";
        _progress[sid].ExpiresAt = DateTime.UtcNow.AddMinutes(15);

        var p = FindPlayer(sid);
        if (p != null)
        {
            p.PrintToChat($" {ChatColors.Green}═══════════════════════════════════════");
            p.PrintToChat($" {ChatColors.Green}✓ [CS Commends] {ChatColors.White}İşlemin {ChatColors.Green}TAMAMLANDI{ChatColors.White}!");
            p.PrintToChat($" {ChatColors.White}Sonuç: {ChatColors.Green}{success}{ChatColors.White}/{total} commend başarılı.");
            p.PrintToChat($" {ChatColors.Gold}⭐ Dashboard → Sipariş Geçmişi → {ChatColors.Yellow}Yorum Yap{ChatColors.Gold} → bonus bakiye kazan!");
            p.PrintToChat($" {ChatColors.LightBlue}https://cscommends.com");
            p.PrintToChat($" {ChatColors.Green}═══════════════════════════════════════");
        }
        Console.WriteLine($"[CommendBotAuth] Chat done: {sid} {success}/{total}");
        command.ReplyToCommand($"OK done {success}/{total}");
    }

    [ConsoleCommand("css_show_clear", "Player progress state'ini temizle")]
    [CommandHelper(minArgs: 1, usage: "<steamid64>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnShowClear(CCSPlayerController? player, CommandInfo command)
    {
        if (ulong.TryParse(command.GetArg(1), out ulong sid))
        {
            bool removed = _progress.Remove(sid);
            command.ReplyToCommand($"OK cleared={removed}");
        }
    }

    private void CallEndAuthSession(ulong steamId64)
    {
        IntPtr serverPtr = GetSteamGameServerPtr();
        if (serverPtr != IntPtr.Zero)
            SteamGameServer_EndAuthSession(serverPtr, steamId64);
    }

    private int CallBeginAuthSession(byte[] ticket, ulong steamId64)
    {
        IntPtr serverPtr = GetSteamGameServerPtr();
        if (serverPtr == IntPtr.Zero)
            throw new Exception("ISteamGameServer interface not available");

        IntPtr pTicket = Marshal.AllocHGlobal(ticket.Length);
        try
        {
            Marshal.Copy(ticket, 0, pTicket, ticket.Length);
            int result = SteamGameServer_BeginAuthSession(serverPtr, pTicket, ticket.Length, steamId64);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(pTicket);
        }
    }

    // CounterStrikeSharp does not wrap ISteamGameServer, so the flat Steam API is
    // called directly. The interface version differs between server builds.
    // "steam_api64" is the Windows library name.
    private IntPtr GetSteamGameServerPtr()
    {
        try { var ptr = SteamAPI_SteamGameServer_v015(); if (ptr != IntPtr.Zero) return ptr; } catch {}
        try { var ptr = SteamAPI_SteamGameServer_v014(); if (ptr != IntPtr.Zero) return ptr; } catch {}
        try { var ptr = SteamAPI_SteamGameServer_v013(); if (ptr != IntPtr.Zero) return ptr; } catch {}
        return IntPtr.Zero;
    }

    [DllImport("steam_api64", EntryPoint = "SteamAPI_SteamGameServer_v015",
        CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr SteamAPI_SteamGameServer_v015();

    [DllImport("steam_api64", EntryPoint = "SteamAPI_SteamGameServer_v014",
        CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr SteamAPI_SteamGameServer_v014();

    [DllImport("steam_api64", EntryPoint = "SteamAPI_SteamGameServer_v013",
        CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr SteamAPI_SteamGameServer_v013();

    [DllImport("steam_api64", EntryPoint = "SteamAPI_ISteamGameServer_BeginAuthSession",
        CallingConvention = CallingConvention.Cdecl)]
    private static extern int SteamGameServer_BeginAuthSession(
        IntPtr self, IntPtr pAuthTicket, int cbAuthTicket, ulong steamID);

    [DllImport("steam_api64", EntryPoint = "SteamAPI_ISteamGameServer_EndAuthSession",
        CallingConvention = CallingConvention.Cdecl)]
    private static extern void SteamGameServer_EndAuthSession(IntPtr self, ulong steamID);

    private static byte[] HexToBytes(string hex)
    {
        if (hex.Length % 2 != 0)
            throw new ArgumentException("Hex string must have even length");

        byte[] bytes = new byte[hex.Length / 2];
        for (int i = 0; i < bytes.Length; i++)
            bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        return bytes;
    }
}
