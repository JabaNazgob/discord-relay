import { openDiscordMenu } from "../apps/discordMenu.js"
import { Constants as C, HOOKS } from "../data/const.js"
import { relayNetwork } from "./relayNetwork.js"

// ==================================================
// —————————————— УСТАРЕВШИЙ API (до 2.0.0) —————————
// ==================================================
// Прослойка для модулей и макросов, написанных под старую версию
// - Старые крюки вызываются после новых, с данными в старом формате, - только если на них кто-то подписан
// - При первом использовании - предупреждение в консоли (стандартный механизм Foundry, подчиняется настройке ядра)
// - Когда придёт время удалять: удалить этот файл и строку его подключения в main.js
const SINCE = "1.0.0"
const UNTIL = "2.0.0"
const NEW_API = `game.modules.get("${C.ID}").api`

// Имена крюков старой версии (так, как они были в CONFIG.DiscordBridge.hooks)
const LEGACY_HOOKS = Object.freeze({
    VOICE_STATE_UPDATE: `${C.ID}.userUpdated`,
    VOICE_STATE_CREATE: `${C.ID}.userJoinedVoiceChannel`,
    VOICE_STATE_DELETE: `${C.ID}.userLeftVoiceChannel`,
    SPEAKING_START: `${C.ID}.userStartedSpeaking`,
    SPEAKING_STOP: `${C.ID}.userStoppedSpeaking`,
    USERS_STATUS_CHANGED: `${C.ID}.usersRelayStatusChanged`,
    // Объявлены в старой версии, но никогда не вызывались
    ROSTER_UPDATED: `${C.ID}.rosterUpdated`,
    RELAY_STARTED: `${C.ID}.relayStarted`,
    RELAY_STOPPED: `${C.ID}.relayStopped`,
    RELAY_STATUS_CHANGED: `${C.ID}.relayStatusChanged`,
    RELAY_USER_CHANGED: `${C.ID}.relayUserChanged`,
    LOG_ENTRY_ADDED: `${C.ID}.logEntryAdded`,
})

// Предупреждение об устаревании (один раз на сообщение)
function warn(oldName, newName) {
    foundry.utils.logCompatibilityWarning(`${C.ID} | ${oldName} is deprecated, use ${newName} instead.`, {since: SINCE, until: UNTIL, once: true})
}
// Подписан ли кто-то на крюк
function hasListeners(hookName) {
    const events = Hooks.events
    return events ? !!events[hookName]?.length : true
}
// Вызов устаревшего крюка
// - Данные собираются сразу, а сам вызов - сразу после того, как закончится новый крюк (сначала новый, потом устаревший)
function callLegacy(hookName, newHookName, buildArgs) {
    if (!hasListeners(hookName)) return
    warn(`Hook "${hookName}"`, `hook "${newHookName}"`)
    const args = buildArgs()
    queueMicrotask(() => Hooks.callAll(hookName, ...args))
}

// Участник в формате старой версии: все поля обеих старых форм
function toLegacyUser(member) {
    if (!member) return null
    return {
        raw: member.raw,
        user_id: member.id,
        userId: member.id,
        name: member.name,
        username: member.name,
        nick: member.nick,
        avatarUrl: member.avatarUrl,
        mute: member.mute,
        deaf: member.deaf,
        selfMute: member.selfMute,
        serverMute: member.serverMute,
        selfDeaf: member.selfDeaf,
        serverDeaf: member.serverDeaf,
        bot: member.bot,
    }
}
// Опции старых крюков участника: {parent, modifiedTime}
const legacyOptions = (context) => ({parent: context.members.map(toLegacyUser), modifiedTime: context.time})


// ==================================================
// ————————————————— УСТАРЕВШИЕ КРЮКИ ————————————————
// ==================================================
Hooks.on(HOOKS.MEMBER_JOINED, (member, context) => {
    callLegacy(LEGACY_HOOKS.VOICE_STATE_CREATE, HOOKS.MEMBER_JOINED, () => [toLegacyUser(member), legacyOptions(context)])
})
Hooks.on(HOOKS.MEMBER_LEFT, (member, context) => {
    callLegacy(LEGACY_HOOKS.VOICE_STATE_DELETE, HOOKS.MEMBER_LEFT, () => [toLegacyUser(member), legacyOptions(context)])
})
Hooks.on(HOOKS.MEMBER_UPDATED, (member, changed, context) => {
    callLegacy(LEGACY_HOOKS.VOICE_STATE_UPDATE, HOOKS.MEMBER_UPDATED, () => [toLegacyUser(member), {...legacyOptions(context), previous: toLegacyUser(context.previous), changed}])
})
Hooks.on(HOOKS.MEMBER_SPEAKING_CHANGED, (member, speaking, context) => {
    const hookName = speaking ? LEGACY_HOOKS.SPEAKING_START : LEGACY_HOOKS.SPEAKING_STOP
    callLegacy(hookName, HOOKS.MEMBER_SPEAKING_CHANGED, () => {
        const foundryUserIds = context.foundryUsers.map(user => user.id)
        const data = {discordUser: toLegacyUser(member), foundryUserId: foundryUserIds[0], foundryUserIds}
        if (context.reason) data.reason = context.reason
        return [data]
    })
})
// Статусы ретрансляторов в сводном виде: (usersStatus, changes)
relayNetwork.onStatusChanges((usersStatus, changes) => {
    callLegacy(LEGACY_HOOKS.USERS_STATUS_CHANGED, HOOKS.RELAY_STATUS_CHANGED, () => [foundry.utils.deepClone(usersStatus), foundry.utils.deepClone(changes)])
})


// ==================================================
// ————————————————— УСТАРЕВШИЕ ОБЪЕКТЫ ——————————————
// ==================================================
// globalThis.DiscordBridge: discordMenu.open() и state
const DiscordBridge = {
    get discordMenu() {
        warn("DiscordBridge.discordMenu.open()", `${NEW_API}.openMenu()`)
        return {open: async (appData = {}) => openDiscordMenu(appData)}
    },
    get state() {
        warn("DiscordBridge.state", `${NEW_API}.relays`)
        return {
            relayUserId: relayNetwork.getActiveRelayUserId(),
            usersStatus: relayNetwork.getUsersStatus(),
        }
    },
}

Hooks.once("init", () => {
    globalThis.DiscordBridge = DiscordBridge
    // CONFIG.DiscordBridge.hooks
    CONFIG.DiscordBridge = {
        get hooks() {
            warn("CONFIG.DiscordBridge.hooks", `${NEW_API}.hooks`)
            return LEGACY_HOOKS
        },
    }
})
