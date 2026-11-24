import { Constants as C, HOOKS } from "../data/const.js"
import { createTicker, getSettings, getVoiceChannelIds, isObject, now } from "../data/functions.js"
import { emitSocket, onSocket } from "../data/socket.js"
import { relay } from "./relay.js"
import { relayNetwork } from "./relayNetwork.js"
const { SYNC_MS, PROFILES_SAVE_DEBOUNCE_MS, LOAD_REASON_TTL_MS, SPEAKING_FILTER_TICK_MS } = C

// ==================================================
// ————————————————— ГОЛОСОВОЙ КАНАЛ ————————————————
// ==================================================
// Состав голосового канала у ВСЕХ игроков.
//
// Как это работает:
// - Каждый ретранслятор ведёт свой «исходный» состав канала по событиям из своего окна StreamKit
// - Основной ретранслятор рассылает изменения всем (по сокету). Запасные молчат, но свой состав держат наготове
// - Каждый клиент хранит общий состав в памяти (а не в настройках мира, как раньше)
// - Кто зашёл в мир позже, просит у основного ретранслятора снимок
// - Сменился основной ретранслятор - новый сразу рассылает свой снимок
// - ГМ (один, activeGM) сохраняет кэш профилей и название канала в настройки мира - для подсказок и заголовка
export const voiceChannel = {}

// —————————————{ ВНУТРЕННИЕ ПЕРЕМЕННЫЕ }————————————
// Общий состав канала (то, что видят все)
const roster = {
    channel: null,          // {guild_id, channel_id, name, topic, user_limit} (формат настройки discordVoiceChatData)
    members: new Map(),     // ID Discord -> участник (см. normalizeMember)
    speaking: new Set(),    // ID Discord тех, кто сейчас говорит
    relayUserId: null,      // От какого ретранслятора получен состав
}
// Исходный состав из своего окна StreamKit (только у ретрансляторов)
const source = {
    channel: null,
    members: new Map(),
    speaking: new Set(),
    loadReason: null,       // Почему пришли данные канала (если ещё не разосланы)
    loadedAt: 0,
}
// Основной ретранслятор на прошлой проверке
let prevActiveRelayUserId = null
// Фильтр коротких звуков: кто начал говорить, но ещё не набрал минимальную длительность (ID Discord -> когда начал)
const pendingSpeaking = new Map()
// Задержка «перестал говорить»: кто замолчал, но ещё может продолжить (ID Discord -> {at: когда замолчал, ts: время события})
const pendingStops = new Map()
// Отсчёт - на таймере в Web Worker: обычный таймер в фоновой вкладке браузер замедляет до секунды и больше
const speakingFilterTicker = createTicker(() => onSpeakingFilterTick(), SPEAKING_FILTER_TICK_MS)
// Подписчики на изменения (окно модуля)
const listeners = new Set()
const speakingListeners = new Set()


// ==================================================
// ————————————————————— API ————————————————————————
// ==================================================
// Подписка на изменения состава (кто в канале, профили, данные канала)
voiceChannel.subscribe = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}
// Подписка на изменения «кто говорит» (отдельно, т.к. это очень частые события)
voiceChannel.subscribeSpeaking = (fn) => {
    speakingListeners.add(fn)
    return () => speakingListeners.delete(fn)
}
// Данные канала в публичном формате (или null)
voiceChannel.getChannel = () => toPublicChannel(roster.channel)
// Участники канала в публичном формате (копии)
voiceChannel.getMembers = () => [...roster.members.keys()].map(id => toPublicMember(id))
// Участник по ID Discord в публичном формате (копия или null)
voiceChannel.getMember = (discordUserId) => roster.members.has(discordUserId) ? toPublicMember(discordUserId) : null
// Говорит ли участник
voiceChannel.isSpeaking = (discordUserId) => roster.speaking.has(discordUserId)
// Получен ли состав канала
voiceChannel.isLoaded = () => !!roster.channel

function notifyListeners() {
    for (const fn of listeners) {
        try { fn() } catch (err) { console.error(`${C.ID} | voiceChannel listener failed`, err) }
    }
}
function notifySpeaking(discordUserId, isSpeaking) {
    for (const fn of speakingListeners) {
        try { fn(discordUserId, isSpeaking) } catch (err) { console.error(`${C.ID} | voiceChannel speaking listener failed`, err) }
    }
}


// ==================================================
// —————————————————— НОРМАЛИЗАЦИЯ ——————————————————
// ==================================================
// Данные участника из события Discord
// - {id, nick, name, avatarUrl, mute, deaf, selfMute, serverMute, selfDeaf, serverDeaf, bot, raw}
// - mute / deaf - общие (сам ИЛИ модератор); selfMute / serverMute и т.д. - раздельно
// - speaking в хранимых данных нет: он добавляется при выдаче наружу (см. toPublicMember)
export function normalizeMember(voiceState) {
    if (!isObject(voiceState)) return null
    const user = isObject(voiceState.user) ? voiceState.user : {}
    const id = String(user.id ?? voiceState.user_id ?? voiceState.userId ?? "")
    if (!id) return null
    const state = isObject(voiceState.voice_state) ? voiceState.voice_state : {}
    // Имя: с дискриминатором (#1234), если он ещё есть у аккаунта
    const name = user.username
        ? (user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username)
        : null
    return {
        id,
        nick: voiceState.nick ?? user.global_name ?? user.username ?? null,
        name,
        avatarUrl: buildAvatarUrl(user, id),
        mute: !!(state.mute || state.self_mute),
        deaf: !!(state.deaf || state.self_deaf),
        selfMute: !!state.self_mute,
        serverMute: !!state.mute,
        selfDeaf: !!state.self_deaf,
        serverDeaf: !!state.deaf,
        bot: !!user.bot,
        raw: voiceState,
    }
}
// Ссылка на аватар
function buildAvatarUrl(user, id) {
    if (user.avatar) {
        const ext = String(user.avatar).startsWith("a_") ? "gif" : "png"
        return `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.${ext}?size=128`
    }
    // Стандартный аватар Discord
    let index = 0
    const discriminator = parseInt(user.discriminator, 10)
    if (Number.isFinite(discriminator) && discriminator > 0) index = discriminator % 5
    else {
        try { index = Number((BigInt(id) >> 22n) % 6n) } catch (err) { index = 0 }
    }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}
// Данные канала (формат настройки discordVoiceChatData)
function normalizeChannel(channel) {
    if (!isObject(channel)) return null
    return {
        guild_id: channel.guild_id ?? null,
        channel_id: channel.channel_id ?? channel.id ?? null,
        name: channel.name ?? null,
        topic: channel.topic ?? null,
        user_limit: channel.user_limit ?? null,
    }
}
// Видимые поля участника: только их изменения считаются изменением участника
// - Остальное, что присылает Discord (громкость и личный мут у ретранслятора, «трибуна»), не рассылается
export const MEMBER_FIELDS = ["nick", "name", "avatarUrl", "mute", "deaf", "selfMute", "serverMute", "selfDeaf", "serverDeaf", "bot"]
// Что изменилось у участника: {поле: новое значение} только для изменившихся полей (как changed в updateActor)
export function getMemberChanges(prev, next) {
    const changed = {}
    for (const field of MEMBER_FIELDS) {
        if ((prev?.[field] ?? null) !== (next?.[field] ?? null)) changed[field] = next?.[field] ?? null
    }
    return changed
}
// Изменились ли видимые данные участника
function memberChanged(prev, next) {
    if (!prev) return true
    return Object.keys(getMemberChanges(prev, next)).length > 0
}


// ==================================================
// ——————————— ИСХОДНЫЙ СОСТАВ (РЕТРАНСЛЯТОР) ———————
// ==================================================
// События из своего окна StreamKit
// - Обновляем свой исходный состав; если мы основной ретранслятор - рассылаем изменения всем
function onRelayEvent(event) {
    const isActive = relayNetwork.isActiveRelay()

    // Данные канала целиком
    if (event.type === "channel") {
        source.channel = normalizeChannel(event.channel)
        source.members.clear()
        for (const voiceState of event.voiceStates) {
            const member = normalizeMember(voiceState)
            if (member) source.members.set(member.id, member)
        }
        source.speaking = new Set(event.speaking.map(String).filter(id => source.members.has(id)))
        clearSpeakingFilter()
        source.loadReason = event.reason
        source.loadedAt = now()
        if (isActive) broadcastSnapshot(source.loadReason)
        return
    }

    // Событие участника
    const {evt, data, ts} = event
    if (evt === "VOICE_STATE_CREATE" || evt === "VOICE_STATE_UPDATE") {
        const member = normalizeMember(data)
        if (!member) return
        const prev = source.members.get(member.id)
        source.members.set(member.id, member)
        // Discord присылает UPDATE и без видимых изменений - такие не рассылаем
        const kind = !prev ? "join" : memberChanged(prev, member) ? "update" : null
        if (kind && isActive) broadcast("VOICE_MEMBER_UPSERT", {member, kind, ts})
        return
    }
    if (evt === "VOICE_STATE_DELETE") {
        const member = normalizeMember(data)
        if (!member || !source.members.has(member.id)) return
        const prev = source.members.get(member.id)
        source.members.delete(member.id)
        source.speaking.delete(member.id)
        pendingSpeaking.delete(member.id)
        pendingStops.delete(member.id)
        if (isActive) broadcast("VOICE_MEMBER_REMOVE", {member: prev, ts})
        return
    }
    if (evt === "SPEAKING_START" || evt === "SPEAKING_STOP") {
        const id = data?.user_id ? String(data.user_id) : null
        if (!id) return
        if (evt === "SPEAKING_START") onSpeakingStart(id, ts)
        else onSpeakingStop(id, ts)
    }
}

// ——————————————{ ФИЛЬТРЫ РЕЧИ }——————————————
// Оба фильтра работают у ретранслятора до рассылки: все игроки получают уже отфильтрованные события
// Минимальная длительность речи (настройка speakingEventDebounceMs, ГМ)
// - «Начал говорить» отправляется, только когда человек говорит дольше этого времени (поэтому подсветка начинается с этой задержкой)
// - Замолчал раньше - это был шум: не отправляется ни «начал», ни «перестал»
// - 0 - фильтр выключен
const getSpeakingMinMs = () => Math.max(0, Number(getSettings("speakingEventDebounceMs", false)) || 0)
// Задержка «перестал говорить» (настройка speakingStopDelayMs, ГМ)
// - «Перестал говорить» отправляется, только если за это время человек не заговорил снова
// - Заговорил раньше - это была пауза внутри фразы: не отправляется ни «перестал», ни новое «начал»
// - Цена: конец речи определяется с этой задержкой. 0 - задержка выключена
const getSpeakingStopDelayMs = () => Math.max(0, Number(getSettings("speakingStopDelayMs", false)) || 0)

function onSpeakingStart(id, ts) {
    // Пауза внутри фразы - человек продолжает говорить
    if (pendingStops.delete(id)) return stopFilterIfIdle()
    if (source.speaking.has(id) || pendingSpeaking.has(id)) return
    if (getSpeakingMinMs() <= 0) return setSourceSpeaking(id, true, ts)
    pendingSpeaking.set(id, now())
    speakingFilterTicker.start()
}
function onSpeakingStop(id, ts) {
    // Не набрал минимальную длительность - шум, ничего не отправляем
    if (pendingSpeaking.delete(id)) return stopFilterIfIdle()
    if (!source.speaking.has(id) || pendingStops.has(id)) return
    if (getSpeakingStopDelayMs() <= 0) return setSourceSpeaking(id, false, ts)
    pendingStops.set(id, {at: now(), ts})
    speakingFilterTicker.start()
}
// Проверка обоих фильтров
// - Кто набрал минимальную длительность - тот действительно говорит
// - Кто молчит дольше задержки - тот действительно перестал говорить (время события - когда он замолчал)
function onSpeakingFilterTick() {
    const minMs = getSpeakingMinMs()
    const stopDelayMs = getSpeakingStopDelayMs()
    const ts = now()
    for (const [id, startedAt] of pendingSpeaking) {
        if (ts - startedAt < minMs) continue
        pendingSpeaking.delete(id)
        // За время ожидания участник мог выйти из канала
        if (source.members.has(id)) setSourceSpeaking(id, true, ts)
    }
    for (const [id, stop] of pendingStops) {
        if (ts - stop.at < stopDelayMs) continue
        pendingStops.delete(id)
        if (source.speaking.has(id)) setSourceSpeaking(id, false, stop.ts)
    }
    stopFilterIfIdle()
}
function stopFilterIfIdle() {
    if (!pendingSpeaking.size && !pendingStops.size) speakingFilterTicker.stop()
}
function clearSpeakingFilter() {
    pendingSpeaking.clear()
    pendingStops.clear()
    speakingFilterTicker.stop()
}
// Изменение «говорит» в исходном составе и рассылка (если мы основной ретранслятор)
function setSourceSpeaking(id, isSpeaking, ts) {
    if (isSpeaking) source.speaking.add(id)
    else source.speaking.delete(id)
    if (relayNetwork.isActiveRelay()) broadcast("VOICE_SPEAKING", {id, speaking: isSpeaking, ts})
}

// Снимок исходного состава
function getSourceSnapshot() {
    return {
        channel: source.channel,
        members: [...source.members.values()],
        speaking: [...source.speaking],
    }
}

// Рассылка всем (и применение у себя - сокет отправителю сообщение не возвращает)
function broadcast(type, data) {
    emitSocket(type, data)
    socketHandlers[type](data, game.user.id)
}
// Рассылка снимка
// - target: только для одного игрока (ответ на запрос), остальные его пропустят
function broadcastSnapshot(reason, target = null) {
    if (!source.channel) return
    source.loadReason = null
    const data = {...getSourceSnapshot(), reason, target}
    emitSocket("VOICE_CHANNEL_SNAPSHOT", data)
    if (!target || target === game.user.id) socketHandlers.VOICE_CHANNEL_SNAPSHOT(data, game.user.id)
}


// ==================================================
// ———————————————— ОБЩИЙ СОСТАВ (ВСЕ) ——————————————
// ==================================================
// Принимаем изменения только от основного ретранслятора
// - Снимок принимаем и от того, кто только что стал основным (у получателя выбор мог ещё не обновиться)
function isFromActiveRelay(senderId) {
    return senderId === relayNetwork.getActiveRelayUserId()
}

// Очистка общего состава (основного ретранслятора больше нет)
// - Тем, кто говорил, отправляем «перестал говорить»: иначе подсветка у потребителей крюков зависнет
function clearRoster() {
    if (!roster.channel && !roster.members.size) return
    const wasSpeaking = [...roster.speaking]
    roster.speaking.clear()
    for (const id of wasSpeaking) {
        notifySpeaking(id, false)
        callSpeakingHook(id, false, "relayLost")
    }
    roster.channel = null
    roster.members.clear()
    roster.relayUserId = null
    notifyListeners()
    Hooks.callAll(HOOKS.CHANNEL_CLEARED, {reason: "relayLost", time: now()})
}

const socketHandlers = {
    // Снимок канала целиком
    VOICE_CHANNEL_SNAPSHOT: (data, senderId) => {
        if (data.target && data.target !== game.user.id) return
        const channel = normalizeChannel(data.channel)
        if (!channel) return
        const prevSpeaking = roster.speaking
        roster.channel = channel
        roster.members = new Map((data.members ?? []).filter(m => m?.id).map(m => [m.id, m]))
        roster.speaking = new Set((data.speaking ?? []).filter(id => roster.members.has(id)))
        roster.relayUserId = senderId
        notifyListeners()
        saveToWorld()
        // Крюки:
        // - Кто говорил, а по снимку уже нет - «перестал говорить»
        // - Состав канала загружен (для всех, кто уже в канале, «зашёл» НЕ вызывается: они не заходили, а уже были в канале)
        // - Кто по снимку говорит, а раньше нет - «начал говорить»
        for (const id of prevSpeaking) {
            if (!roster.speaking.has(id)) callSpeakingHook(id, false, "snapshot")
        }
        Hooks.callAll(HOOKS.CHANNEL_LOADED, voiceChannel.getChannel(), voiceChannel.getMembers(), {reason: data.reason ?? null, time: now()})
        for (const id of roster.speaking) {
            if (!prevSpeaking.has(id)) callSpeakingHook(id, true, "snapshot")
        }
    },
    // Участник зашёл или изменился
    VOICE_MEMBER_UPSERT: (data, senderId) => {
        const member = data.member
        if (!isFromActiveRelay(senderId) || !member?.id) return
        const previous = roster.members.get(member.id) ?? null
        roster.members.set(member.id, member)
        notifyListeners()
        saveToWorld()
        // Крюки
        const time = data.ts || now()
        if (!previous) return Hooks.callAll(HOOKS.MEMBER_JOINED, toPublicMember(member.id), buildContext(member.id, {time}))
        const changed = getMemberChanges(previous, member)
        const context = buildContext(member.id, {time, previous: toPublicMember(member.id, previous), changed})
        Hooks.callAll(HOOKS.MEMBER_UPDATED, toPublicMember(member.id), {...changed}, context)
        // Микрофон / звук: отдельный крюк с флагом
        if ("mute" in changed) Hooks.callAll(HOOKS.MEMBER_MUTE_CHANGED, toPublicMember(member.id), member.mute, buildContext(member.id, {time, previous: toPublicMember(member.id, previous), changed}))
        if ("deaf" in changed) Hooks.callAll(HOOKS.MEMBER_DEAF_CHANGED, toPublicMember(member.id), member.deaf, buildContext(member.id, {time, previous: toPublicMember(member.id, previous), changed}))
    },
    // Участник вышел
    VOICE_MEMBER_REMOVE: (data, senderId) => {
        const id = data.member?.id
        if (!isFromActiveRelay(senderId) || !id || !roster.members.has(id)) return
        // Вышел, не договорив - сначала «перестал говорить» (Discord сам его может не прислать)
        if (roster.speaking.has(id)) {
            roster.speaking.delete(id)
            notifySpeaking(id, false)
            callSpeakingHook(id, false, "left")
        }
        const member = toPublicMember(id)
        roster.members.delete(id)
        notifyListeners()
        Hooks.callAll(HOOKS.MEMBER_LEFT, member, buildContext(id, {time: data.ts || now()}))
    },
    // Начал/перестал говорить
    VOICE_SPEAKING: (data, senderId) => {
        if (!isFromActiveRelay(senderId) || !data.id) return
        if (data.speaking === roster.speaking.has(data.id)) return
        if (data.speaking) roster.speaking.add(data.id)
        else roster.speaking.delete(data.id)
        notifySpeaking(data.id, data.speaking)
        callSpeakingHook(data.id, data.speaking, null, data.ts)
    },
    // Кто-то зашёл в мир позже и просит снимок
    VOICE_CHANNEL_REQUEST: (data, senderId) => {
        if (!relayNetwork.isActiveRelay() || !source.channel) return
        broadcastSnapshot("clientJoined", senderId)
    },
}
for (const [type, handler] of Object.entries(socketHandlers)) onSocket(type, handler)


// ==================================================
// —————————————————————— КРЮКИ ———————————————————————
// ==================================================
// Публичные крюки . Все имена - с приставкой "discord-relay."
// - memberJoined(member, context) / memberLeft(member, context)
// - memberUpdated(member, changed, context)
// - memberMuteChanged(member, muted, context) / memberDeafChanged(member, deafened, context) - после memberUpdated
// - memberSpeakingChanged(member, speaking, context)
// - channelLoaded(channel, members, {reason, time}) / channelCleared({reason, time})
// Контекст участника: {channel, members, foundryUsers, previous, changed, reason, time}
// Потребителям отдаём копии, чтобы они случайно не испортили состав канала

// Публичные данные канала: {id, guildId, name, topic, userLimit}
function toPublicChannel(channel) {
    if (!channel) return null
    return {id: channel.channel_id, guildId: channel.guild_id, name: channel.name, topic: channel.topic, userLimit: channel.user_limit}
}
// Публичные данные участника: копия + speaking
// - data: другие данные участника (например, прежние), иначе - текущие из состава
// - Участника нет в составе (говорит, но вход мы пропустили) - берём из кэша профилей
export function toPublicMember(id, data = roster.members.get(id)) {
    if (!data) {
        const profile = getSettings("discordUserProfiles", false)?.[id] ?? {}
        data = {id, nick: profile.nick ?? null, name: profile.username ?? null, avatarUrl: profile.avatarUrl ?? null,
            mute: !!profile.mute, deaf: false, selfMute: false, serverMute: false, selfDeaf: false, serverDeaf: false, bot: !!profile.bot, raw: null}
    }
    return {...foundry.utils.deepClone(data), speaking: roster.speaking.has(id)}
}
// Пользователи Foundry, привязанные к участнику Discord
export function getLinkedFoundryUsers(discordUserId) {
    const idsMap = getSettings("foundryDiscordIdsMap", false) ?? {}
    return Object.keys(idsMap).filter(foundryUserId => idsMap[foundryUserId] === discordUserId).map(foundryUserId => game.users.get(foundryUserId)).filter(Boolean)
}
// Контекст крюка участника
function buildContext(id, {time = now(), previous = null, changed = null, reason = null} = {}) {
    return {
        channel: voiceChannel.getChannel(),
        members: voiceChannel.getMembers(),
        foundryUsers: getLinkedFoundryUsers(id),
        previous,
        changed: changed ? {...changed} : null,
        reason,
        time,
    }
}
// Начал / перестал говорить
// - reason: только у событий, которые модуль создал сам, чтобы подсветка не зависла:
//   "left" (вышел из канала), "relayLost" (пропал ретранслятор), "snapshot" (по снимку состава)
function callSpeakingHook(id, isSpeaking, reason = null, time = now()) {
    Hooks.callAll(HOOKS.MEMBER_SPEAKING_CHANGED, toPublicMember(id), isSpeaking, buildContext(id, {reason, time}))
}


// Смена основного ретранслятора
// - Стали основным мы - рассылаем свой состав
// - Основного больше нет - очищаем состав (данные могли устареть)
function onNetworkChanged() {
    const activeRelayUserId = relayNetwork.getActiveRelayUserId()
    if (activeRelayUserId === prevActiveRelayUserId) return
    prevActiveRelayUserId = activeRelayUserId
    if (!activeRelayUserId) return clearRoster()
    if (activeRelayUserId === game.user.id) {
        // Если данные канала пришли только что и ещё не разосланы - сообщаем настоящую причину (например, «ретранслятор запущен»)
        const freshReason = source.loadReason && (now() - source.loadedAt) <= LOAD_REASON_TTL_MS ? source.loadReason : null
        broadcastSnapshot(freshReason ?? "relayChanged")
        return
    }
    // Основной - другой игрок. Он сам разошлёт снимок, но если его снимок до нас не дошёл
    // (например, мы ещё не считали его основным) - через секунду попросим снимок сами
    setTimeout(() => {
        if (relayNetwork.getActiveRelayUserId() === activeRelayUserId && roster.relayUserId !== activeRelayUserId) emitSocket("VOICE_CHANNEL_REQUEST")
    }, 1000)
}


// ==================================================
// ——————————————— СОХРАНЕНИЕ В МИР (ГМ) ————————————
// ==================================================
// Кэш профилей (для подсказок при привязке) и название канала сохраняет один ГМ
// - С задержкой, чтобы не писать в базу на каждое событие
const saveToWorld = foundry.utils.debounce(async () => {
    if (!game.users.activeGM?.isSelf) return
    try {
        await saveProfiles()
        await saveChannelData()
    } catch (err) {
        console.error(`${C.ID} | failed to save voice channel data`, err)
    }
}, PROFILES_SAVE_DEBOUNCE_MS)

// Кэш профилей: {ID Discord: {userId, username, nick, avatarUrl, mute, bot}} (формат настройки из старой версии)
async function saveProfiles() {
    const profiles = getSettings("discordUserProfiles") ?? {}
    let changed = false
    for (const member of roster.members.values()) {
        const next = {userId: member.id, username: member.name, nick: member.nick, avatarUrl: member.avatarUrl, mute: member.mute, bot: member.bot}
        if (!foundry.utils.objectsEqual(profiles[member.id] ?? {}, next)) {
            profiles[member.id] = next
            changed = true
        }
    }
    if (changed) await game.settings.set(C.ID, "discordUserProfiles", profiles)
}

// Название, тема и лимит канала (только если это тот же канал, что в настройках)
async function saveChannelData() {
    const ids = getVoiceChannelIds()
    const channel = roster.channel
    if (!ids || !channel || ids.guild_id !== channel.guild_id || ids.channel_id !== channel.channel_id) return
    const prev = getSettings("discordVoiceChatData") ?? {}
    if (prev.name === channel.name && prev.topic === channel.topic && prev.user_limit === channel.user_limit) return
    await game.settings.set(C.ID, "discordVoiceChatData", {...prev, name: channel.name, topic: channel.topic, user_limit: channel.user_limit})
}


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
Hooks.once("ready", () => {
    relay.onDiscordEvent(onRelayEvent)
    // Свой ретранслятор выключен - исходный состав больше не актуален
    relay.subscribe(() => {
        if (relay.isRunning() || !source.channel) return
        source.channel = null
        source.members.clear()
        source.speaking.clear()
        clearSpeakingFilter()
        source.loadReason = null
    })
    relayNetwork.subscribe(onNetworkChanged)
    // Зашли в мир - после сбора статусов просим снимок у основного ретранслятора
    setTimeout(() => {
        onNetworkChanged()
        if (relayNetwork.getActiveRelayUserId() && !roster.channel) emitSocket("VOICE_CHANNEL_REQUEST")
    }, SYNC_MS + 100)
})
