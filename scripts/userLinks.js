import { Constants as C } from "../data/const.js"
import { getSettings, modLoc } from "../data/functions.js"
import { emitSocket, onSocket } from "../data/socket.js"
import { voiceChannel } from "./voiceChannel.js"

// ==================================================
// —————————— СВЯЗЬ ПОЛЬЗОВАТЕЛЕЙ FOUNDRY / DISCORD —————
// ==================================================
// Связи хранятся в настройке мира foundryDiscordIdsMap: {foundryUserId: discordUserId или ник}
// - Ник (вместо ID) - «ожидание»: как только появится профиль с таким ником/именем, ГМ заменит его на ID
// - Менять связи: ГМ - любые, игрок - только свою
// - Настройку мира пишет только ГМ. Игрок отправляет запрос по сокету, его выполняет один ГМ (activeGM).
//   Поэтому игрок может привязать себя, только когда ГМ в игре
export const userLinks = {}

// ID Discord: 17-20 цифр
const DISCORD_ID_REGEX = /^\d{17,20}$/
export const isDiscordId = (value) => DISCORD_ID_REGEX.test(String(value ?? ""))


// ==================================================
// ————————————————————— API ————————————————————————
// ==================================================
// Связь пользователя Foundry (ID Discord, ник в ожидании или null)
userLinks.get = (foundryUserId) => getSettings("foundryDiscordIdsMap", false)?.[foundryUserId] || null
// Может ли текущий пользователь менять связь этого пользователя Foundry
userLinks.canEdit = (foundryUserId) => game.user.isGM || foundryUserId === game.user.id
// Профиль Discord по ID: из текущего состава канала или из кэша профилей
userLinks.getProfile = (discordUserId) => {
    if (!discordUserId) return null
    const member = voiceChannel.getMember(discordUserId)
    if (member) return {userId: member.id, username: member.name, nick: member.nick, avatarUrl: member.avatarUrl}
    const profile = getSettings("discordUserProfiles", false)?.[discordUserId]
    return profile ? {userId: discordUserId, username: profile.username ?? null, nick: profile.nick ?? null, avatarUrl: profile.avatarUrl ?? null} : null
}
// Все известные профили (для подсказок): текущий состав канала + кэш профилей
userLinks.getKnownProfiles = () => {
    const result = new Map()
    const cached = getSettings("discordUserProfiles", false) ?? {}
    for (const [id, profile] of Object.entries(cached)) {
        if (isDiscordId(id)) result.set(id, {userId: id, username: profile.username ?? null, nick: profile.nick ?? null, avatarUrl: profile.avatarUrl ?? null})
    }
    for (const member of voiceChannel.getMembers()) {
        result.set(member.id, {userId: member.id, username: member.name, nick: member.nick, avatarUrl: member.avatarUrl})
    }
    return [...result.values()]
}

// Установка связи
// - value: ID Discord, ник (будет ждать появления профиля) или пусто (отвязать)
userLinks.set = async (foundryUserId, value) => {
    if (!userLinks.canEdit(foundryUserId)) return
    const next = String(value ?? "").trim() || null
    if (game.user.isGM) return applyLink(foundryUserId, next)
    // Игрок: просим ГМа
    if (!game.users.activeGM) return ui.notifications.warn(modLoc("notifications.linkNeedsGm"))
    emitSocket("USER_LINK_REQUEST", {foundryUserId, value: next})
}

// Запись связи (только ГМ)
async function applyLink(foundryUserId, value) {
    const idsMap = getSettings("foundryDiscordIdsMap") ?? {}
    if ((idsMap[foundryUserId] || null) === value) return
    // Отвязка - удаляем ключ целиком (в старой версии оставался null)
    if (value) idsMap[foundryUserId] = resolveValue(value)
    else delete idsMap[foundryUserId]
    // Настройка-объект: удалённые ключи сохраняются только при полной замене значения
    await game.settings.set(C.ID, "foundryDiscordIdsMap", idsMap)
}

// Ник, для которого профиль уже известен, сразу превращаем в ID
function resolveValue(value) {
    if (isDiscordId(value)) return value
    return findProfileByName(value)?.userId ?? value
}
// Поиск профиля по нику или имени (без учёта регистра)
function findProfileByName(name) {
    const query = String(name).trim().toLowerCase()
    if (!query) return null
    return userLinks.getKnownProfiles().find(p => [p.nick, p.username].some(field => field && String(field).toLowerCase() === query)) ?? null
}

// Замена ников в ожидании на ID, когда профили появились (только один ГМ)
async function resolvePending() {
    if (!game.users.activeGM?.isSelf) return
    const idsMap = getSettings("foundryDiscordIdsMap") ?? {}
    let changed = false
    for (const [foundryUserId, value] of Object.entries(idsMap)) {
        if (!value || isDiscordId(value)) continue
        const profile = findProfileByName(value)
        if (!profile) continue
        idsMap[foundryUserId] = profile.userId
        changed = true
    }
    if (changed) await game.settings.set(C.ID, "foundryDiscordIdsMap", idsMap)
}
userLinks.resolvePending = foundry.utils.debounce(() => resolvePending().catch(err => console.error(`${C.ID} | resolvePending failed`, err)), 500)


// ==================================================
// ———————————————————— СОКЕТЫ ——————————————————————
// ==================================================
// Запрос игрока на изменение своей связи
// - Выполняет один ГМ; игрок может менять только свою связь
onSocket("USER_LINK_REQUEST", async (data, senderId) => {
    if (!game.users.activeGM?.isSelf) return
    const sender = game.users.get(senderId)
    if (!sender || (data.foundryUserId !== senderId && !sender.isGM)) return
    await applyLink(data.foundryUserId, data.value ? String(data.value).trim() : null)
})


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
Hooks.once("ready", () => {
    // Состав канала изменился - возможно, появился профиль для ника в ожидании
    voiceChannel.subscribe(() => userLinks.resolvePending())
    userLinks.resolvePending()
})
