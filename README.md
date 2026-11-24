# Discord Relay: Voicechat Hooks & Macros

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FJabaNazgob%2Fdiscord-relay%2Fmain%2Fmodule.json&query=%24.version&label=version&color=blue)
![Foundry minimum](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FJabaNazgob%2Fdiscord-relay%2Fmain%2Fmodule.json&query=%24.compatibility.minimum&label=Foundry%20minimum&color=orange)
![Foundry verified](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FJabaNazgob%2Fdiscord-relay%2Fmain%2Fmodule.json&query=%24.compatibility.verified&label=Foundry%20verified&color=orange)
![Downloads](https://img.shields.io/github/downloads/JabaNazgob/discord-relay/total)
![License](https://img.shields.io/github/license/JabaNazgob/discord-relay)

[Русская версия](README-ru.md)

A FoundryVTT module that passes voice channel events to other modules or to your macros through an open API. **No Discord bot required.**

Supports FoundryVTT v13 and v14

## Installation

1. In the Foundry main menu, on the "Add-on Modules" tab, press "Install Module" and paste this manifest URL into the field at the bottom:
   ```
   https://github.com/JabaNazgob/discord-relay/releases/latest/download/module.json
   ```
2. Then, in your Foundry world, enable **Discord Relay: Voicechat Hooks & Macros** in the "Manage Modules" window

## Features

### Voice channel events passed on by the module:

- Joining/leaving the voice channel
- A user started/stopped speaking
- A user muting/unmuting their microphone or deafening/undeafening themselves
- A moderator muted/deafened a user
- A user's profile changed (nickname, avatar, etc.)
- Once when the relay starts / the channel changes: the voice channel's name and members

All of these events are available through the module's API. You can also use simple macros with these events. More on that below

### The module can also:

- Link Discord profiles to FoundryVTT users
- Show an event log and the voice channel itself in the module window

## Usage

### Setup (short version)

To start the relay, you need to do a few simple things in the module window after installing the module. **Any of your players can do these steps:**

1. **Once, as the GM:** Enter the link to the Discord voice channel in the module window
2. Install [TamperMonkey](https://www.tampermonkey.net/) in your browser
3. In your browser's extension settings, allow user scripts (in some browsers the option may be named differently)
4. Add the [script](https://github.com/JabaNazgob/discord-relay/raw/main/discord-relay.user.js) to TamperMonkey (if TamperMonkey is already installed, the link will offer to install it)
5. **In the same browser**, launch your Foundry world, open the module menu and press "Enable relay"

**Note:** the relay user must be in the voice channel themselves to receive the "Started/stopped speaking" events

Several players can be relays at once. If one of them suddenly drops out, another takes over automatically.

A detailed guide is at the bottom of this file. It is also available inside the module window

### Event macros

The module window has a "Macros" tab. There you can pick a Discord voice channel event as a trigger, the macro to run on that trigger, where it runs (e.g. "At every player" or "Once, at the GM") and how often it may fire at most (e.g. to keep the "Started speaking" event from firing too often)

<details>
<summary><b>Cheat sheet: what's available in the macro</b></summary>

Write the macro as a regular script macro, without `Hooks.on`. All event data is in a single variable `discordEvent` (also `scope.discordEvent`): `discordEvent.type`, `discordEvent.member`, etc. Fields match the module's hook arguments. Missing data is `null`. The ▶ button of a rule runs the macro right now on your side with test data — handy for checking a macro without Discord.

**For all events**

| Variable | Contents |
|---|---|
| `discordEvent.type` | Which event fired: `"joined"`, `"left"`, `"muted"`, `"unmuted"`, `"deafened"`, `"undeafened"`, `"updated"`, `"speakingStart"`, `"speakingStop"`, `"channelLoaded"`, `"relayStarted"`, `"relayStopped"` |
| `discordEvent.member` | Discord member: `id`, `nick`, `name`, `avatarUrl`, `mute`, `deaf` (combined: self or moderator), `selfMute`, `serverMute`, `selfDeaf`, `serverDeaf`, `speaking`, `bot` (for member events) |
| `discordEvent.foundryUser` | Foundry user linked to the member (first one), or `null` |
| `discordEvent.foundryUsers` | All Foundry users linked to the member (array) |
| `discordEvent.channel` | Voice channel: `id`, `guildId`, `name`, `topic`, `userLimit` |
| `discordEvent.members` | All voice channel members (array, like `member`) |
| `discordEvent.rule` | The rule that ran the macro |
| `speaker, actor, token, character` | Regular Foundry variables |

**For specific events**

| Variable | Contents |
|---|---|
| `discordEvent.previous` | muted / unmuted / deafened / undeafened / updated: member data before the change |
| `discordEvent.changed` | muted / unmuted / deafened / undeafened / updated: only the changed fields, e.g. `{mute: true, selfMute: true}` or `{nick: "Bob"}` |
| `discordEvent.reason` | speakingStart / speakingStop: `null` if the event came from Discord; `"left"`, `"relayLost"` or `"snapshot"` if the module sent it. channelLoaded: `"relayStarted"`, `"channelChanged"`, `"reconnected"`, `"relayChanged"` or `"clientJoined"` |
| `discordEvent.relayUser` | relayStarted / relayStopped: the Foundry user who started or stopped the relay |
| `discordEvent.test` | Test run (▶ button of a rule): `true`, otherwise `false` |

**Example (rule "started speaking", at the GM)**

```js
// Post to chat who started speaking
const name = discordEvent.foundryUser?.name ?? discordEvent.member.nick
const p = document.createElement("p")
p.textContent = `${name} is speaking` // as text: a nickname may contain < and >
ChatMessage.create({content: p.outerHTML})
```

</details>

### API

The module passes events on through Foundry hooks and the `game.modules.get("discord-relay").api` object. The object gives you the current channel members, the links between Discord profiles and Foundry users, and a way to open the module window.

```js
const api = game.modules.get("discord-relay").api
Hooks.on(api.hooks.MEMBER_SPEAKING_CHANGED, (member, speaking, context) => {
    console.log(member.nick, speaking ? "started speaking" : "stopped speaking", context.foundryUser?.name)
})
```

**Full description and details:** [API.md](API.md) (in English), [API-ru.md](API-ru.md) (по-русски)

### Integration example: Visual Novel Dialogues

As an example of using this module's API, here is another module of mine: [Visual Novel Dialogues](https://www.patreon.com/Nazgob/posts/release-v4-1-1-175190666). Thanks to its flexible UI settings and speech/line event builder, you can easily connect a Discord user's speech to a character Portrait in Visual Novel Dialogues

### / I'd like to add a couple of video examples here later. For now, imagine they're here or something like that /

## Full guide: preparing and activating the relay

### Before you start:

- The relay can only be launched in a browser. It doesn't work in the FoundryVTT desktop app — the module detects this and tells you
- At least 1 user must have the relay active. Note: even if you host FoundryVTT via the desktop app, you can become the relay yourself by joining the world as another user via a browser

### Terms

- Relay: a script that runs in the browser and forwards events from a Discord voice channel to FoundryVTT
- Relay player: the player who launched the relay

All the following steps must be performed by the relay player.

### 1) Installing and configuring TamperMonkey

- Install the [TamperMonkey](https://www.tampermonkey.net/) extension in your browser and enable it
- After installing, go to your browser's extension settings and configure TamperMonkey depending on your browser:
  - Mozilla Firefox: enabled by default
  - Opera GX: "More details" → "Allow user scripts"
  - Chrome: "Details" → "Allow user scripts"
  - Microsoft Edge: "Allow user scripts"
  - If you use another browser, or there are no settings with such names, try to find similar settings if the TamperMonkey dashboard still says "Please allow user scripts"

### 2) Installing the script

- Open [the script via this link](https://github.com/JabaNazgob/discord-relay/raw/main/discord-relay.user.js) or press the "Install script" button on the "Guide" tab of the module window. A new tab will open, and TamperMonkey will offer to install the script
- Press "Install" (or "Update" if the script is already installed). The old version of the script will be replaced automatically
- Make sure the "Streamkit Speaking Relay" script is enabled in the TamperMonkey dashboard

**If that didn't work: manual installation**

- Open the TamperMonkey dashboard and press [+] (create a new script). If the "Streamkit Speaking Relay" script already exists, open it instead of creating a new one
- Copy the [script](discord-relay.user.js), replace ALL text in the editor with it and save: <kbd>Ctrl</kbd> + <kbd>S</kbd>

### 3) Launching the relay

- Join the FoundryVTT world in the browser where the script is installed and open the module window. You can open it from the module settings, a button in the VisualNovelDialogues Theater, or with the `game.modules.get("discord-relay").api.openMenu()` command
- The GM enters the voice channel link in the "Relay" tab (right-click the channel in Discord → "Copy Link")
- Press "Enable relay". The StreamKit window will open. If Discord asks to authorize StreamKit, allow it
- The "Working" status means everything is fine. If something goes wrong, the "Relay" tab will say what exactly and how to fix it

### Notes:

- You must be in this voice channel to receive the "Started speaking" and "Stopped speaking" events
- Don't close the StreamKit window during the game: closing it stops the relay. Minimizing is fine
- If you reload the FoundryVTT page, the relay will pick up the already open StreamKit window by itself

### VisualNovelDialogues integration

The VisualNovelDialogues module automatically receives relay events. You can configure how VisualNovelDialogues reacts to these events in its settings. By default, on "Started speaking" and "Stopped speaking" events VisualNovelDialogues highlights the character Portraits of the corresponding players. To make it work, follow the instructions below

**Preparation**

- In the "Relay" tab of the module window, assign the corresponding Discord profiles to FoundryVTT users
- In the FoundryVTT player list (usually bottom left), click a player's name and choose "User Configuration". In the window that opens, select the corresponding actor as the player's Character
- Next, open the editor of the Portrait you need, and in the "General" tab link the corresponding actor to this portrait
- Now, when this Portrait is in the Theater, it will be highlighted while the corresponding player is speaking. You can configure the brightness and size of the "highlighted" Portrait in the VisualNovelDialogues settings

## License

[MIT](LICENSE)
