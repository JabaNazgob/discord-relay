import { openDiscordMenu } from "../apps/discordMenu.js"
import { Constants as C, HOOKS } from "../data/const.js"
import { relayNetwork } from "./relayNetwork.js"
import { isDiscordId, userLinks } from "./userLinks.js"
import { getLinkedFoundryUsers, voiceChannel } from "./voiceChannel.js"

// ==================================================
// ————————————————— ПУБЛИЧНЫЙ API ——————————————————
// ==================================================
// API модуля для других модулей и макросов
// - Доступ: game.modules.get("discord-relay").api
// - Всё, чего здесь нет, - внутренняя часть модуля и может меняться без предупреждения
// - Данные отдаются копиями: изменить состав канала через них нельзя
export const api = Object.freeze({
    // Версия API: меняется, когда меняется то, что описано здесь
    version: C.API_VERSION,

    // Имена крюков: api.hooks.MEMBER_SPEAKING_CHANGED и т.д.
    hooks: Object.freeze({...HOOKS}),

    // Открыть окно модуля
    // - tab: "relay" / "macros" / "settings" / "guide"
    openMenu: ({tab} = {}) => openDiscordMenu({currentTab: tab}),

    // Голосовой канал
    channel: Object.freeze({
        // Данные канала {id, guildId, name, topic, userLimit} или null (ретранслятор не работает)
        get: () => voiceChannel.getChannel(),
        // Все участники канала
        getMembers: () => voiceChannel.getMembers(),
        // Участник по ID Discord или null
        getMember: (id) => voiceChannel.getMember(id),
        // Говорит ли участник
        isSpeaking: (id) => voiceChannel.isSpeaking(id),
    }),

    // Привязки пользователей Foundry к профилям Discord
    links: Object.freeze({
        // ID Discord, привязанный к пользователю Foundry, или null (не привязан или ник ещё ждёт профиля)
        getDiscordId: (foundryUserId) => {
            const value = userLinks.get(foundryUserId)
            return isDiscordId(value) ? value : null
        },
        // Пользователи Foundry, привязанные к участнику Discord (массив)
        getFoundryUsers: (discordId) => getLinkedFoundryUsers(discordId),
    }),

    // Ретрансляторы
    relays: Object.freeze({
        // Основной ретранслятор (пользователь Foundry) или null
        getActiveUser: () => game.users.get(relayNetwork.getActiveRelayUserId()) ?? null,
        // Статус ретранслятора у пользователя: "OFFLINE" / "STARTING" / "READY" / "ONLINE" / "STALE"
        getStatus: (userId) => relayNetwork.getUserStatus(userId).status,
    }),
})


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
// Открываем API сразу на init, чтобы другие модули могли использовать его уже на setup/ready
Hooks.once("init", () => {
    game.modules.get(C.ID).api = api
})
