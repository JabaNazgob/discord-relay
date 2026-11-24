# Changelog

## 1.0.0

The module has been rewritten from scratch. Saved settings (voice channel, profile links) are kept.

The module is now called **Discord Relay** everywhere (it used to be "Discord Voicechat Sync" in the module list and "DiscordBridge" in the settings).

### Before updating: relay players

- **Every player who runs the relay must update the TamperMonkey script** to version 1.1.0. The old script (0.3.0) does not work with this version. The module tells you if your script is outdated. To update, open the module window → "Guide" tab → "Install script", then press "Update" in TamperMonkey.

### Relay

- The "Foundry is opened in a browser" checkbox is gone: the module detects the FoundryVTT desktop app by itself and offers to copy the world link.
- After you press "Enable relay", the module tells you what exactly went wrong: pop-up blocked, TamperMonkey script not responding or outdated, Discord app not running, Discord silent, wrong channel link, StreamKit window closed.
- Relay status no longer depends on the GM: a minimized GM tab or a GM reload doesn't break the relay. The module works even without a GM in the game (only changing settings needs a GM).
- Several players can run the relay at once: one is primary, the others are backups and take over if the primary disconnects. The GM can assign the primary relay with the star in the users table.
- If you reload the FoundryVTT page, the relay picks up the already open StreamKit window by itself.
- Disabling the relay now closes the StreamKit window.

### Module window

- The users table shows all world users (those not in the game are dimmed). Only the GM can change the voice channel and everyone's links; a player can link (and unlink) only themselves, and a GM must be in the game for that.
- The voice channel list shows muted and deafened members; players who join the world later see the current members right away.
- The "Recent activity" log works now. Speech events are logged only if you tick "Speech".
- Clearing the voice channel link asks for confirmation (it stops all relays).
- New "Macros" tab: run a macro on Discord events (joined, left, muted, started speaking, etc.), for the GM, every player, the linked player or selected players. Players can have their own rules if the GM allows it. A cheat sheet of macro variables is in the tab.
- New setting "Minimum speech duration (ms)", 400 by default: short sounds (coughs, clicks) no longer trigger "started speaking". 0 disables the filter.
- New setting "Stopped speaking delay (ms)", 0 (off) by default: a short pause inside a phrase no longer counts as the end of speech.
- New "Settings" tab: all module settings right in the window. Players can see world settings, but only the GM can change them.
- The log tells who muted or deafened a member: the member themselves or a server moderator.
- Long nicknames no longer stretch the users table: they are truncated, the full nickname is in the tooltip.
- If someone changed their Discord avatar, the window shows the default avatar instead of a broken image until the profile is updated.
- The window follows the FoundryVTT light and dark themes. The bundled fonts that overrode FoundryVTT's own fonts were removed.

### For module and macro authors

- New API: `game.modules.get("discord-relay").api` and new hooks (`discord-relay.memberSpeakingChanged` and others). See `API.md` in the module folder.
- The old hooks (`discord-relay.userStartedSpeaking`, etc.), `globalThis.DiscordBridge` and `CONFIG.DiscordBridge.hooks` still work but are deprecated and will be removed in 2.0.0. Each one shows a deprecation warning in the console once.
- Every "started speaking" is now always followed by "stopped speaking", even if the member left the channel or the relay disconnected.

### Known limitations

- The relay works only in a browser with TamperMonkey, not in the FoundryVTT desktop app.
- Speech that began before the relay started is not visible until the person pauses: Discord only reports "started" and "stopped" speaking.
