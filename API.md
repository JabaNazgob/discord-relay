# Discord Relay — API for modules and macros

API version: **1.0**. Russian version: [API-ru.md](API-ru.md).

Discord Relay brings Discord voice channel events into Foundry VTT: who joined and left, who is speaking, who muted their microphone or deafened. These events are available to other modules and macros through **hooks** and the **API** object.

> If you don't write code and just want to run a macro on an event (e.g. "when a player starts speaking"), use the **"Macros"** tab of the module window — it includes a cheat sheet of the data your macro receives.

---

## Getting started

The API lives in the standard Foundry place. It is reliably available from the `setup` hook on (in other modules' `init` — only if Discord Relay was loaded earlier):

```js
const relay = game.modules.get("discord-relay")
if (relay?.active) {
    const api = relay.api
    console.log(api.version) // "1.0"
}
```

If your module should also work without Discord Relay, check `relay?.active` and simply skip the integration when the module is missing. You can list Discord Relay in `relationships.recommends` of your `module.json`.

Take hook names from `api.hooks` instead of typing strings — a typo will show up immediately:

```js
Hooks.on(api.hooks.MEMBER_SPEAKING_CHANGED, (member, speaking, context) => { /* ... */ })
```

---

## Two things to know first

**1. Hooks fire for every player.** A Discord event reaches every connected client, and the hook is called on each of them. That's exactly what you want for things each player sees locally (highlights, sounds, screen effects). But if your code changes the world — posts to chat, moves tokens — it will run as many times as there are players online. To run something once:

```js
if (!game.users.activeGM?.isSelf) return
```

**2. "Started speaking" is always followed by "stopped speaking".** If Discord doesn't send "stopped" itself (the person left mid-sentence, the relay was lost), the module sends it, with the cause in `context.reason`. You can safely turn a highlight on with `true` and off with `false` — it won't get stuck.

---

## Data

### Member (`member`)

A person in the Discord voice channel. Same format in every hook and method. It's a copy: changing it doesn't affect the module.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Discord user ID |
| `nick` | string \| null | Server nickname; global display name if there is none |
| `name` | string \| null | Discord account name |
| `avatarUrl` | string \| null | Avatar URL |
| `mute` | boolean | Microphone muted (by self **or** by a moderator) |
| `deaf` | boolean | Sound deafened (by self **or** by a moderator) |
| `selfMute` / `serverMute` | boolean | Muted by self / by a server moderator |
| `selfDeaf` / `serverDeaf` | boolean | Deafened by self / by a server moderator |
| `speaking` | boolean | Speaking right now |
| `bot` | boolean | Is a bot |
| `raw` | object \| null | Original Discord data. Format not guaranteed — better not rely on it |

### Channel (`channel`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Voice channel ID |
| `guildId` | string | Server ID |
| `name` | string \| null | Channel name |
| `topic` | string \| null | Channel topic |
| `userLimit` | number \| null | Member limit |

### Context (`context`)

The last argument of every member hook (`member…`).

| Field | Meaning |
|---|---|
| `channel` | The channel (see above) or `null` |
| `members` | All channel members **after** the event (array of `member`) |
| `foundryUsers` | Foundry users linked to this member in the module window (array of `User`, may be empty) |
| `previous` | The member **before** the change — only in `memberUpdated`, `memberMuteChanged`, `memberDeafChanged`; otherwise `null` |
| `changed` | Only the changed fields, e.g. `{mute: true, selfMute: true}` — same hooks; otherwise `null` |
| `reason` | Only for events sent by the module itself (see `memberSpeakingChanged`); otherwise `null` |
| `time` | Event time (milliseconds) |

To get the speaking player's character: `context.foundryUsers[0]?.character`.

---

## Hooks

All names start with `discord-relay.`. The tables show the short name and the key in `api.hooks`.

Same principle as Foundry itself: "appeared / disappeared" — two separate hooks (like `createToken` / `deleteToken`); "a property toggled" — one hook with a `true` / `false` flag (like `targetToken`).

### Channel members

| Hook (`api.hooks.…`) | Arguments | When |
|---|---|---|
| `memberJoined` (`MEMBER_JOINED`) | `(member, context)` | Someone joined the voice channel |
| `memberLeft` (`MEMBER_LEFT`) | `(member, context)` | Someone left the channel. Discord doesn't distinguish: left, moved to another channel, kicked or lost connection |
| `memberSpeakingChanged` (`MEMBER_SPEAKING_CHANGED`) | `(member, speaking, context)` | Started (`true`) or stopped (`false`) speaking |
| `memberMuteChanged` (`MEMBER_MUTE_CHANGED`) | `(member, muted, context)` | Microphone muted (`true`) or unmuted (`false`) |
| `memberDeafChanged` (`MEMBER_DEAF_CHANGED`) | `(member, deafened, context)` | Deafened (`true`) or undeafened (`false`) |
| `memberUpdated` (`MEMBER_UPDATED`) | `(member, changed, context)` | Any visible change: nickname, name, avatar, microphone, sound. `changed` holds only the changed fields |

**Call order on a member change:** `memberUpdated` → `memberMuteChanged` → `memberDeafChanged`. For example, when someone deafens, Discord mutes them too — all three hooks fire.

**`context.reason` in `memberSpeakingChanged`.** `null` for events from Discord. The module sends the event itself so that "speaking" never gets stuck, and then `reason` is:

| `reason` | When |
|---|---|
| `"left"` | The person left the channel mid-sentence ("stopped" arrives before `memberLeft`) |
| `"relayLost"` | The relay was lost ("stopped" arrives before `channelCleared`) |
| `"snapshot"` | Full channel members arrived: those no longer speaking get "stopped", those speaking get "started" |

### Voice channel

| Hook (`api.hooks.…`) | Arguments | When |
|---|---|---|
| `channelLoaded` (`CHANNEL_LOADED`) | `(channel, members, {reason, time})` | Full channel members received |
| `channelCleared` (`CHANNEL_CLEARED`) | `({reason, time})` | Channel members cleared: the relay is gone, no data anymore. `reason` = `"relayLost"` |

`reason` in `channelLoaded`:

| `reason` | When |
|---|---|
| `"relayStarted"` | The relay was started |
| `"channelChanged"` | The GM changed the voice channel |
| `"reconnected"` | StreamKit reconnected to Discord (e.g. after restarting the Discord app) |
| `"relayChanged"` | The primary relay changed |
| `"clientJoined"` | This player joined the world while the relay was already running. **Fires only for them** |

For people already sitting in the channel, `memberJoined` is **not** called when the channel loads: they didn't join anything. Use `channelLoaded` if you need the whole member list.

### Relays

A relay is a player who has the Discord StreamKit window open and forwards events to Foundry. There can be several relays: one works (primary), the others are backups.

| Hook (`api.hooks.…`) | Arguments | When |
|---|---|---|
| `relayStatusChanged` (`RELAY_STATUS_CHANGED`) | `(user, status, previousStatus)` | A player's relay status changed. Start — transition from `"OFFLINE"`, stop — transition to `"OFFLINE"` |
| `activeRelayChanged` (`ACTIVE_RELAY_CHANGED`) | `(user, previousUser)` | The primary relay changed. `user` / `previousUser` — `User` or `null` |

Statuses:

| Status | Meaning |
|---|---|
| `"OFFLINE"` | Relay not running (or the player isn't in the game) |
| `"STARTING"` | Running, but not working yet (connecting or there is a problem) |
| `"READY"` | Working, backup |
| `"ONLINE"` | Working, primary |
| `"STALE"` | Relay signal lost |

During the first 2 seconds after joining the world, relay hooks are not called: the player is learning about relays that are already running, not about new starts.

---

## API methods

| Method | Returns |
|---|---|
| `api.version` | API version, currently `"1.0"` |
| `api.hooks` | All hook names |
| `api.openMenu({tab})` | Opens the module window. `tab`: `"relay"`, `"macros"`, `"settings"` or `"guide"` |
| `api.channel.get()` | The channel, or `null` if no relay is working |
| `api.channel.getMembers()` | All channel members (array of `member`) |
| `api.channel.getMember(id)` | Member by Discord ID, or `null` |
| `api.channel.isSpeaking(id)` | Whether the member is speaking |
| `api.links.getDiscordId(foundryUserId)` | Discord ID linked to the Foundry user, or `null` |
| `api.links.getFoundryUsers(discordId)` | Foundry users linked to the Discord member (array of `User`) |
| `api.relays.getActiveUser()` | Primary relay (`User`) or `null` |
| `api.relays.getStatus(userId)` | The user's relay status (see the status table) |

Anything not listed here is internal and may change without notice.

---

## Examples

### Highlight the character who is speaking

Runs for every player locally, so no GM check is needed.

```js
Hooks.once("ready", () => {
    const relay = game.modules.get("discord-relay")
    if (!relay?.active) return
    const api = relay.api

    Hooks.on(api.hooks.MEMBER_SPEAKING_CHANGED, (member, speaking, {foundryUsers}) => {
        for (const user of foundryUsers) {
            const actor = user.character
            if (actor) myHighlight(actor, speaking) // your highlight function
        }
    })
})
```

You don't need to ask on world load who is already speaking: when a player receives the channel members, the module itself fires "started speaking" (`reason: "snapshot"`) for whoever is speaking at that moment.

### Post to chat who joined the channel (once)

```js
Hooks.on("discord-relay.memberJoined", (member) => {
    if (!game.users.activeGM?.isSelf) return
    // textContent: a Discord nickname may contain < and >, so insert it as text, not HTML
    const p = document.createElement("p")
    p.textContent = `${member.nick} joined the voice channel`
    ChatMessage.create({content: p.outerHTML})
})
```

### React only to moderator mutes

```js
Hooks.on("discord-relay.memberMuteChanged", (member, muted, {changed}) => {
    if (!("serverMute" in changed)) return
    console.log(`${member.nick}: a moderator ${muted ? "muted" : "unmuted"} the microphone`)
})
```

### Who is in the channel now

```js
const api = game.modules.get("discord-relay").api
for (const member of api.channel.getMembers()) {
    console.log(member.nick, member.speaking ? "speaking" : "silent")
}
```

---

## Limitations

- **Short sounds are filtered out.** "Started speaking" only arrives if the person speaks longer than the minimum speech duration (module setting, 400 ms by default) — and therefore with that delay. If the person stops earlier, neither "started" nor "stopped" arrives.
- **Short pauses can be merged.** If the "stopped speaking" delay is set (module setting, off by default), "stopped speaking" arrives only after that delay, and only if the person hasn't started speaking again; a pause shorter than the delay produces neither "stopped" nor a new "started". The event time (`context.time`) is when the person actually stopped.
- **Speech that started before the relay was enabled isn't visible until the person stops talking.** Discord only reports "started" and "stopped" speaking; there's no way to ask whether someone is speaking right now.
- **To receive speaking events, the relay player must be in this voice channel themselves.** Everything else (who is in the channel, microphone, sound) arrives without it.
- **While no relay is working, there are no events**, and `api.channel.get()` returns `null`.
- **Camera, streaming and "stage" status are not visible** — StreamKit doesn't provide them.

---

## Deprecated API

The API of versions before 1.0.0 still works, but logs a warning to the console on first use. **It will be removed in version 2.0.0.**

| Deprecated | Replacement |
|---|---|
| `userJoinedVoiceChannel(user, {parent, modifiedTime})` | `memberJoined(member, context)` |
| `userLeftVoiceChannel(user, {parent, modifiedTime})` | `memberLeft(member, context)` |
| `userUpdated(user, {parent, modifiedTime, previous, changed})` | `memberUpdated(member, changed, context)` |
| `userStartedSpeaking({discordUser, foundryUserId, foundryUserIds})` | `memberSpeakingChanged(member, true, context)` |
| `userStoppedSpeaking({discordUser, foundryUserId, foundryUserIds})` | `memberSpeakingChanged(member, false, context)` |
| `usersRelayStatusChanged(usersStatus, changes)` | `relayStatusChanged(user, status, previousStatus)` |
| `globalThis.DiscordBridge.discordMenu.open()` | `api.openMenu()` |
| `DiscordBridge.state.relayUserId` / `usersStatus` | `api.relays.getActiveUser()` / `api.relays.getStatus(userId)` |
| `CONFIG.DiscordBridge.hooks` | `api.hooks` |

Member field mapping: `user_id` / `userId` → `id`, `username` → `name`, `discordUser` → `member`.
