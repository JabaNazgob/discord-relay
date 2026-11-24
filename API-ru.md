# Discord Relay — API для модулей и макросов

Версия API: **1.0**. Английская версия: [API.md](API.md).

Discord Relay передаёт в Foundry VTT события голосового канала Discord: кто зашёл и вышел, кто говорит, кто выключил микрофон или звук. Эти события доступны другим модулям и макросам через **крюки** (`Hooks`) и через объект **API**.

> Если вы не пишете код, а хотите просто запускать макрос на событие (например, «когда игрок заговорил»), используйте вкладку **«Макросы»** в окне модуля — там же есть памятка по данным, которые получает макрос.

---

## Подключение

API лежит в стандартном для Foundry месте. Надёжно он доступен начиная с хука `setup` (в `init` других модулей — только если Discord Relay загрузился раньше):

```js
const relay = game.modules.get("discord-relay")
if (relay?.active) {
    const api = relay.api
    console.log(api.version) // "1.0"
}
```

Если ваш модуль должен работать и без Discord Relay, проверяйте `relay?.active` и просто не включайте интеграцию, когда модуля нет. В `module.json` своего модуля можно указать Discord Relay в `relationships.recommends`.

Имена крюков берите из `api.hooks`, а не пишите строками — так опечатка будет видна сразу:

```js
Hooks.on(api.hooks.MEMBER_SPEAKING_CHANGED, (member, speaking, context) => { /* ... */ })
```

---

## Две вещи, которые нужно знать в первую очередь

**1. Крюки срабатывают у каждого игрока.** Событие из Discord приходит на все подключённые компьютеры, и крюк вызывается у каждого. Для того, что каждый видит у себя (подсветка, звук, эффект на экране), это как раз то, что нужно. Но если ваш код меняет мир — пишет в чат, двигает токены, — без проверки он выполнится столько раз, сколько игроков в игре. Чтобы действие выполнилось один раз:

```js
if (!game.users.activeGM?.isSelf) return
```

**2. «Начал говорить» всегда завершается «перестал говорить».** Если Discord сам не прислал «перестал» (человек вышел посреди фразы, пропал ретранслятор), модуль отправит его сам — с причиной в `context.reason`. Подсветку можно смело включать по `true` и выключать по `false`, она не зависнет.

---

## Данные

### Участник (`member`)

Человек в голосовом канале Discord. Во всех крюках и методах — один и тот же формат. Это копия: менять её можно, на модуль это не повлияет.

| Поле | Тип | Что это |
|---|---|---|
| `id` | string | ID пользователя Discord |
| `nick` | string \| null | Ник на сервере; если его нет — глобальное имя |
| `name` | string \| null | Имя аккаунта Discord |
| `avatarUrl` | string \| null | Ссылка на аватар |
| `mute` | boolean | Микрофон выключен (сам **или** модератором) |
| `deaf` | boolean | Звук выключен (сам **или** модератором) |
| `selfMute` / `serverMute` | boolean | Микрофон выключил сам / выключил модератор сервера |
| `selfDeaf` / `serverDeaf` | boolean | Звук выключил сам / выключил модератор сервера |
| `speaking` | boolean | Говорит прямо сейчас |
| `bot` | boolean | Это бот |
| `raw` | object \| null | Исходные данные Discord. Формат не гарантируется — лучше не полагаться |

### Канал (`channel`)

| Поле | Тип | Что это |
|---|---|---|
| `id` | string | ID голосового канала |
| `guildId` | string | ID сервера |
| `name` | string \| null | Название канала |
| `topic` | string \| null | Тема канала |
| `userLimit` | number \| null | Лимит участников |

### Контекст (`context`)

Последний аргумент всех крюков участника (`member…`).

| Поле | Что это |
|---|---|
| `channel` | Канал (см. выше) или `null` |
| `members` | Все участники канала **после** события (массив `member`) |
| `foundryUsers` | Пользователи Foundry, привязанные к этому участнику в окне модуля (массив `User`, может быть пустым) |
| `previous` | Участник **до** изменения — только в `memberUpdated`, `memberMuteChanged`, `memberDeafChanged`; иначе `null` |
| `changed` | Только изменившиеся поля, например `{mute: true, selfMute: true}` — там же; иначе `null` |
| `reason` | Только у событий, которые модуль создал сам (см. `memberSpeakingChanged`); иначе `null` |
| `time` | Время события (миллисекунды) |

Чтобы получить персонажа игрока, который говорит: `context.foundryUsers[0]?.character`.

---

## Крюки

Все имена начинаются с `discord-relay.`. В таблицах — короткое имя и ключ в `api.hooks`.

Принцип как у самого Foundry: «появился / исчез» — два разных крюка (как `createToken` / `deleteToken`), «переключилось свойство» — один крюк с флагом `true` / `false` (как `targetToken`).

### Участники канала

| Крюк (`api.hooks.…`) | Аргументы | Когда |
|---|---|---|
| `memberJoined` (`MEMBER_JOINED`) | `(member, context)` | Человек зашёл в голосовой канал |
| `memberLeft` (`MEMBER_LEFT`) | `(member, context)` | Человек вышел из канала. Discord не различает: вышел сам, перешёл в другой канал, выкинули или пропал интернет |
| `memberSpeakingChanged` (`MEMBER_SPEAKING_CHANGED`) | `(member, speaking, context)` | Начал (`true`) или перестал (`false`) говорить |
| `memberMuteChanged` (`MEMBER_MUTE_CHANGED`) | `(member, muted, context)` | Микрофон выключен (`true`) или включён (`false`) |
| `memberDeafChanged` (`MEMBER_DEAF_CHANGED`) | `(member, deafened, context)` | Звук выключен (`true`) или включён (`false`) |
| `memberUpdated` (`MEMBER_UPDATED`) | `(member, changed, context)` | Любое видимое изменение: ник, имя, аватар, микрофон, звук. `changed` — только изменившиеся поля |

**Порядок вызова при изменении участника:** `memberUpdated` → `memberMuteChanged` → `memberDeafChanged`. Например, когда человек выключает звук, Discord выключает ему и микрофон, — придут все три крюка.

**`context.reason` у `memberSpeakingChanged`.** У событий от Discord — `null`. Модуль сам отправляет событие, чтобы состояние «говорит» никогда не зависало, и тогда `reason`:

| `reason` | Когда |
|---|---|
| `"left"` | Человек вышел из канала, не договорив («перестал» приходит перед `memberLeft`) |
| `"relayLost"` | Пропал ретранслятор («перестал» приходит перед `channelCleared`) |
| `"snapshot"` | Пришёл полный состав канала: кто по нему уже не говорит — «перестал», кто говорит — «начал» |

### Голосовой канал

| Крюк (`api.hooks.…`) | Аргументы | Когда |
|---|---|---|
| `channelLoaded` (`CHANNEL_LOADED`) | `(channel, members, {reason, time})` | Получен полный состав канала |
| `channelCleared` (`CHANNEL_CLEARED`) | `({reason, time})` | Состав канала сброшен: ретранслятор пропал, данных больше нет. `reason` = `"relayLost"` |

`reason` у `channelLoaded`:

| `reason` | Когда |
|---|---|
| `"relayStarted"` | Включили ретранслятор |
| `"channelChanged"` | ГМ сменил голосовой канал |
| `"reconnected"` | StreamKit переподключился к Discord (например, после перезапуска приложения Discord) |
| `"relayChanged"` | Сменился основной ретранслятор |
| `"clientJoined"` | Этот игрок зашёл в мир, когда ретранслятор уже работал. **Срабатывает только у него** |

Для людей, которые уже сидят в канале, `memberJoined` при загрузке канала **не** вызывается: они никуда не заходили. Тем, кому нужен весь состав, — `channelLoaded`.

### Ретрансляторы

Ретранслятор — игрок, у которого открыто окно Discord StreamKit и который передаёт события в Foundry. Ретрансляторов может быть несколько: работает один (основной), остальные — запасные.

| Крюк (`api.hooks.…`) | Аргументы | Когда |
|---|---|---|
| `relayStatusChanged` (`RELAY_STATUS_CHANGED`) | `(user, status, previousStatus)` | У игрока сменился статус ретранслятора. Запуск — переход из `"OFFLINE"`, остановка — переход в `"OFFLINE"` |
| `activeRelayChanged` (`ACTIVE_RELAY_CHANGED`) | `(user, previousUser)` | Сменился основной ретранслятор. `user` / `previousUser` — `User` или `null` |

Статусы:

| Статус | Что значит |
|---|---|
| `"OFFLINE"` | Ретранслятор не запущен (или игрока нет в игре) |
| `"STARTING"` | Запущен, но ещё не работает (подключается или есть проблема) |
| `"READY"` | Работает, запасной |
| `"ONLINE"` | Работает, основной |
| `"STALE"` | Сигнал от ретранслятора потерян |

В первые 2 секунды после входа в мир крюки ретрансляторов не вызываются: игрок в это время узнаёт об уже запущенных ретрансляторах, а не о новых запусках.

---

## Методы API

| Метод | Возвращает |
|---|---|
| `api.version` | Версия API, сейчас `"1.0"` |
| `api.hooks` | Имена всех крюков |
| `api.openMenu({tab})` | Открывает окно модуля. `tab`: `"relay"`, `"macros"`, `"settings"` или `"guide"` |
| `api.channel.get()` | Канал или `null`, если ретранслятор не работает |
| `api.channel.getMembers()` | Все участники канала (массив `member`) |
| `api.channel.getMember(id)` | Участник по ID Discord или `null` |
| `api.channel.isSpeaking(id)` | Говорит ли участник |
| `api.links.getDiscordId(foundryUserId)` | ID Discord, привязанный к пользователю Foundry, или `null` |
| `api.links.getFoundryUsers(discordId)` | Пользователи Foundry, привязанные к участнику Discord (массив `User`) |
| `api.relays.getActiveUser()` | Основной ретранслятор (`User`) или `null` |
| `api.relays.getStatus(userId)` | Статус ретранслятора у пользователя (см. таблицу статусов) |

Всё, чего нет в этом списке, — внутренняя часть модуля и может измениться без предупреждения.

---

## Примеры

### Подсветить персонажа, который говорит

У каждого игрока — у себя, поэтому проверка на ГМа не нужна.

```js
Hooks.once("ready", () => {
    const relay = game.modules.get("discord-relay")
    if (!relay?.active) return
    const api = relay.api

    Hooks.on(api.hooks.MEMBER_SPEAKING_CHANGED, (member, speaking, {foundryUsers}) => {
        for (const user of foundryUsers) {
            const actor = user.character
            if (actor) myHighlight(actor, speaking) // ваша функция подсветки
        }
    })
})
```

Отдельно запрашивать при загрузке мира, кто уже говорит, не нужно: когда игрок получает состав канала, модуль сам вызывает «начал говорить» (`reason: "snapshot"`) для тех, кто говорит в этот момент.

### Написать в чат, кто зашёл в канал (один раз)

```js
Hooks.on("discord-relay.memberJoined", (member) => {
    if (!game.users.activeGM?.isSelf) return
    // textContent: в нике Discord могут быть символы < и >, поэтому вставляем его как текст, а не как HTML
    const p = document.createElement("p")
    p.textContent = `${member.nick} зашёл в голосовой канал`
    ChatMessage.create({content: p.outerHTML})
})
```

### Реагировать только на мут модератором

```js
Hooks.on("discord-relay.memberMuteChanged", (member, muted, {changed}) => {
    if (!("serverMute" in changed)) return
    console.log(`${member.nick}: модератор ${muted ? "выключил" : "включил"} микрофон`)
})
```

### Кто сейчас в канале

```js
const api = game.modules.get("discord-relay").api
for (const member of api.channel.getMembers()) {
    console.log(member.nick, member.speaking ? "говорит" : "молчит")
}
```

---

## Ограничения

- **Короткие звуки отфильтрованы.** «Начал говорить» приходит, только если человек говорит дольше минимальной длительности (настройка модуля, по умолчанию 400 мс), — поэтому и с этой задержкой. Если человек замолчал раньше, не приходит ни «начал», ни «перестал».
- **Короткие паузы могут склеиваться.** Если задана задержка «перестал говорить» (настройка модуля, по умолчанию выключена), «перестал говорить» приходит только через эту задержку и только если человек не заговорил снова; при паузе короче задержки не приходит ни «перестал», ни новое «начал». Время события (`context.time`) — когда человек действительно замолчал.
- **Речь, начатая до запуска ретранслятора, не видна, пока человек не замолчит.** Discord сообщает о речи только событиями «начал» и «перестал», а узнать, говорит ли человек прямо сейчас, нельзя.
- **Чтобы получать события речи, игрок-ретранслятор должен сам сидеть в этом голосовом канале.** Остальное (кто в канале, микрофон, звук) приходит и без этого.
- **Пока ни у кого не работает ретранслятор, событий нет**, а `api.channel.get()` возвращает `null`.
- **Камеру, стрим и «трибуну» модуль не видит** — StreamKit этого не передаёт.

---

## Устаревший API

API версий до 1.0.0 продолжает работать, но при первом использовании пишет предупреждение в консоль. **Будет удалён в версии 2.0.0.**

| Устаревшее | Чем заменить |
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

Соответствие полей участника: `user_id` / `userId` → `id`, `username` → `name`, `discordUser` → `member`.
