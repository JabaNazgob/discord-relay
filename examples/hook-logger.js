// ==================================================
// ——————————— МАКРОС: ЖУРНАЛ КРЮКОВ DISCORD ————————
// ==================================================
// Проверочный макрос для модуля discord-relay.
// Создайте макрос типа «Скрипт», вставьте этот текст и запустите.
// - Первый запуск: включает журнал - события крюков пишутся в чат (видите только вы)
// - Повторный запуск: выключает журнал
// Журнал работает только у того, кто запустил макрос, и до перезагрузки страницы.

const KEY = "discordRelayHookLogger"
const api = game.modules.get("discord-relay")?.api
if (!api) return ui.notifications.error("Модуль discord-relay не включён")
const hooks = api.hooks

// Выключение
if (globalThis[KEY]) {
    for (const [name, id] of globalThis[KEY]) Hooks.off(name, id)
    delete globalThis[KEY]
    return ui.notifications.info("Журнал крюков Discord выключен")
}

// Запись в чат (только себе)
const time = () => new Date().toLocaleTimeString()
const nick = (member) => member?.nick || member?.name || member?.id || "?"
const users = (list) => list.map(user => user.name).join(", ") || "—"
// - Ник в Discord может содержать любые символы, в том числе < и >: вставляем текст как текст, а не как HTML
const escape = (text) => Object.assign(document.createElement("span"), {textContent: String(text)}).innerHTML
const log = (title, text = "") => ChatMessage.create({
    content: `<p><b>${escape(title)}</b> <small>${time()}</small></p>${text ? `<p>${escape(text)}</p>` : ""}`,
    whisper: [game.user.id],
    speaker: {alias: "Discord Relay"},
})

const handlers = {
    [hooks.MEMBER_JOINED]: (member, {members}) => log("Зашёл в канал", `${nick(member)} (в канале: ${members.length})`),
    [hooks.MEMBER_LEFT]: (member, {members}) => log("Вышел из канала", `${nick(member)} (в канале: ${members.length})`),
    [hooks.MEMBER_UPDATED]: (member, changed) => log("Изменился", `${nick(member)}: ${JSON.stringify(changed)}`),
    [hooks.MEMBER_MUTE_CHANGED]: (member, muted, {changed}) => log(muted ? "Микрофон выключен" : "Микрофон включён", `${nick(member)}${"serverMute" in changed ? " (модератором)" : ""}`),
    [hooks.MEMBER_DEAF_CHANGED]: (member, deafened, {changed}) => log(deafened ? "Звук выключен" : "Звук включён", `${nick(member)}${"serverDeaf" in changed ? " (модератором)" : ""}`),
    [hooks.MEMBER_SPEAKING_CHANGED]: (member, speaking, {foundryUsers, reason}) => log(speaking ? "Начал говорить" : "Перестал говорить", `${nick(member)} → Foundry: ${users(foundryUsers)}${reason ? ` [${reason}]` : ""}`),
    [hooks.CHANNEL_LOADED]: (channel, members, {reason}) => log("Канал загружен", `${channel?.name ?? "?"}, причина: ${reason}, участники: ${members.map(nick).join(", ") || "никого"}`),
    [hooks.CHANNEL_CLEARED]: ({reason}) => log("Состав канала сброшен", reason),
    [hooks.ACTIVE_RELAY_CHANGED]: (user, previousUser) => log("Сменился основной ретранслятор", `${previousUser?.name ?? "—"} → ${user?.name ?? "—"}`),
    [hooks.RELAY_STATUS_CHANGED]: (user, status, previousStatus) => log("Статус ретранслятора", `${user.name}: ${previousStatus} → ${status}`),
}

globalThis[KEY] = Object.entries(handlers).map(([name, fn]) => [name, Hooks.on(name, fn)])
ui.notifications.info("Журнал крюков Discord включён. Запустите макрос ещё раз, чтобы выключить")
