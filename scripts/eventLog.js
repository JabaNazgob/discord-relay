import { Constants as C, HOOKS } from "../data/const.js"
import { getSettings, now } from "../data/functions.js"
import { USER_STATUS as U } from "./relayNetwork.js"

// ==================================================
// ————————————————— ЖУРНАЛ ДЕЙСТВИЙ ————————————————
// ==================================================
// Последние события голосового канала и ретрансляторов
// - Хранится только в памяти этого клиента: после перезагрузки страницы журнал пустой
// - Собирается из крюков самого модуля, поэтому показывает ровно то, что получили модули и макросы
// - События речи записываются, только если игрок включил это в журнале (иначе они вытеснят всё остальное)
// - Журнал - внутренняя часть окна модуля, своего крюка у него нет
export const eventLog = {}

// Записи, новые - в начале
// - {id, ts, type, member: {id, nick, avatarUrl} | null, foundryUserId, data}
const entries = []
let nextId = 1
// Подписчики (окно модуля)
const listeners = new Set()


// ==================================================
// ————————————————————— API ————————————————————————
// ==================================================
// Все записи (копия, новые - в начале)
eventLog.getEntries = () => entries.map(entry => ({...entry}))
// Очистка журнала
eventLog.clear = () => {
    entries.length = 0
    notifyListeners(null)
}
// Подписка на новые записи
// - fn(entry) - добавлена запись; fn(null) - журнал очищен
eventLog.subscribe = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

function notifyListeners(entry) {
    for (const fn of listeners) {
        try { fn(entry) } catch (err) { console.error(`${C.ID} | eventLog listener failed`, err) }
    }
}

// Добавление записи
function addEntry(type, {member = null, foundryUserId = null, data = {}} = {}) {
    const entry = {
        id: nextId++,
        ts: now(),
        type,
        member: member ? {id: member.id, nick: member.nick || member.name || member.id, avatarUrl: member.avatarUrl ?? null} : null,
        foundryUserId,
        data,
    }
    entries.unshift(entry)
    if (entries.length > C.LOG_MAX) entries.length = C.LOG_MAX
    notifyListeners(entry)
}


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
// Голосовой канал
Hooks.on(HOOKS.CHANNEL_LOADED, (channel, members, {reason}) => {
    addEntry("channelLoaded", {data: {channelName: channel?.name ?? null, reason, userCount: members.length}})
})
Hooks.on(HOOKS.CHANNEL_CLEARED, () => addEntry("channelCleared"))
Hooks.on(HOOKS.MEMBER_JOINED, (member) => addEntry("joined", {member}))
Hooks.on(HOOKS.MEMBER_LEFT, (member) => addEntry("left", {member}))
// Изменения участника
// - Микрофон и звук записываются раздельно: выключил сам или модератор сервера (selfMute / serverMute и т.д.)
// - Discord, выключая звук, сам выключает и микрофон (а включая - возвращает). Такой микрофон не записываем:
//   «выключил звук» уже это означает
const MUTE_LOG_TYPES = [
    {field: "selfDeaf", on: "deafened", off: "undeafened"},
    {field: "selfMute", on: "muted", off: "unmuted", pairedWith: "selfDeaf"},
    {field: "serverDeaf", on: "serverDeafened", off: "serverUndeafened"},
    {field: "serverMute", on: "serverMuted", off: "serverUnmuted", pairedWith: "serverDeaf"},
]
Hooks.on(HOOKS.MEMBER_UPDATED, (member, changed, {previous}) => {
    if ("nick" in changed) addEntry("renamed", {member, data: {prevNick: previous?.nick ?? null}})
    if ("avatarUrl" in changed) addEntry("avatarChanged", {member})
    for (const {field, on, off, pairedWith} of MUTE_LOG_TYPES) {
        if (!(field in changed)) continue
        if (pairedWith && pairedWith in changed && changed[pairedWith] === changed[field]) continue
        addEntry(changed[field] ? on : off, {member})
    }
})
// Речь (только если включено)
Hooks.on(HOOKS.MEMBER_SPEAKING_CHANGED, (member, speaking, {foundryUsers, reason}) => {
    if (!getSettings("logSpeaking", false)) return
    addEntry(speaking ? "speakingStart" : "speakingStop", {member, foundryUserId: foundryUsers[0]?.id ?? null, data: {reason: reason ?? null}})
})

// Ретрансляторы: запуск и остановка - это переход из статуса OFFLINE и в него
Hooks.on(HOOKS.RELAY_STATUS_CHANGED, (user, status, previousStatus) => {
    if (previousStatus === U.OFFLINE) addEntry("relayStarted", {foundryUserId: user.id})
    else if (status === U.OFFLINE) addEntry("relayStopped", {foundryUserId: user.id})
})
Hooks.on(HOOKS.ACTIVE_RELAY_CHANGED, (user) => addEntry("relayChanged", {foundryUserId: user?.id ?? null}))
