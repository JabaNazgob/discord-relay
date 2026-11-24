import { Constants as C, HOOKS } from "../data/const.js"
import { getSettings, isObject, modFormat, modLoc, now } from "../data/functions.js"
import { emitSocket, onSocket } from "../data/socket.js"
import { getLinkedFoundryUsers, voiceChannel } from "./voiceChannel.js"

// ==================================================
// ————————————— МАКРОСЫ ПО СОБЫТИЯМ ————————————————
// ==================================================
// Правила «когда [событие] → запустить [макрос] у [кого]»
//
// - Правила мира (создаёт ГМ): настройка мира macroRules. Выполняются у выбранных получателей
// - Правила игрока: флаг пользователя. Выполняются только у самого игрока, с его правами
// - События приходят каждому клиенту, поэтому каждый клиент сам решает, выполнять ли правило у себя
//
// Правило: {id, enabled, event, by, macroUuid, target, userIds, allowWithoutPermission, cooldownSec}
// - target (только правила мира): "gm" (один раз, у ГМа) / "everyone" / "linked" (у игрока, привязанного к участнику) / "users"
// - by (только микрофон и звук): "any" (сам или модератор) / "self" (сам участник) / "server" (модератор сервера)
export const macroRules = {}

// События, на которые можно повесить макрос
// - Порядок = порядок в выпадающем списке
export const RULE_EVENTS = [
    "joined", "left", "muted", "unmuted", "deafened", "undeafened", "updated",
    "speakingStart", "speakingStop", "channelLoaded", "relayStarted", "relayStopped",
]
// Получатели правил мира
export const RULE_TARGETS = ["gm", "everyone", "linked", "users"]
// События без участника: у них некого считать «привязанным игроком», и правило «у привязанного» не сработает никогда
// - У событий ретранслятора «привязанный» - сам ретранслятор, поэтому их здесь нет
export const RULE_EVENTS_WITHOUT_MEMBER = ["channelLoaded"]
// Кем выключен микрофон или звук - выбор есть только у этих событий
export const RULE_BY = ["any", "self", "server"]
export const RULE_EVENTS_WITH_BY = ["muted", "unmuted", "deafened", "undeafened"]
// Поле участника для «сам» / «модератор»: событие -> [поле, значение]
// - «any» берёт общее mute / deaf: срабатывает, только когда меняется итог (был слышен -> стал не слышен)
// - «self» / «server» смотрят на своё поле: модератор выключил микрофон тому, кто уже выключил его сам, - для «server» это событие
const BY_FIELDS = {
    self: {selfMute: ["muted", "unmuted"], selfDeaf: ["deafened", "undeafened"]},
    server: {serverMute: ["muted", "unmuted"], serverDeaf: ["deafened", "undeafened"]},
}

// Когда правило последний раз выполнялось у этого клиента (для ограничения частоты)
const lastRunByRuleId = new Map()
// Когда последний раз сообщали о проблеме с правилом (ID правила + текст -> время)
// - Правило на частое событие («начал говорить») с удалённым или сломанным макросом иначе засыпало бы экран уведомлениями
const lastProblemByKey = new Map()


// ==================================================
// ———————————————— ХРАНЕНИЕ ПРАВИЛ —————————————————
// ==================================================
// Новое правило с настройками по умолчанию
export function createRule(isWorldRule) {
    return {
        id: foundry.utils.randomID(),
        enabled: true,
        event: "speakingStart",
        by: "any",
        macroUuid: null,
        target: isWorldRule ? "gm" : "self",
        userIds: [],
        allowWithoutPermission: false,
        cooldownSec: null,
    }
}
// Приведение правила к корректному виду (на случай битых данных)
function sanitizeRule(rule, isWorldRule) {
    if (!isObject(rule) || !rule.id) return null
    const cooldown = Number(rule.cooldownSec)
    return {
        id: String(rule.id),
        enabled: rule.enabled !== false,
        event: RULE_EVENTS.includes(rule.event) ? rule.event : "speakingStart",
        // Правила, созданные до появления поля, - «сам или модератор», как и работали
        by: RULE_BY.includes(rule.by) ? rule.by : "any",
        macroUuid: rule.macroUuid ? String(rule.macroUuid) : null,
        target: isWorldRule ? (RULE_TARGETS.includes(rule.target) ? rule.target : "gm") : "self",
        userIds: isWorldRule && Array.isArray(rule.userIds) ? rule.userIds.map(String) : [],
        allowWithoutPermission: isWorldRule && !!rule.allowWithoutPermission,
        cooldownSec: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : null,
    }
}

// Правила мира
macroRules.getWorldRules = () => (getSettings("macroRules") ?? []).map(rule => sanitizeRule(rule, true)).filter(Boolean)
// Правила игрока (по умолчанию - текущего)
macroRules.getUserRules = (user = game.user) => (foundry.utils.deepClone(user?.getFlag(C.ID, "macroRules")) ?? []).map(rule => sanitizeRule(rule, false)).filter(Boolean)
// Разрешено ли игрокам создавать свои правила
macroRules.playerRulesAllowed = () => !!getSettings("allowPlayerRules", false)
// Может ли текущий пользователь редактировать правила мира
macroRules.canEditWorld = () => game.user.isGM
// Может ли текущий пользователь создавать свои правила
macroRules.canEditOwn = () => !game.user.isGM && macroRules.playerRulesAllowed()

// Сохранение правил
// - isWorld: правила мира (только ГМ) или свои правила игрока
async function saveRules(isWorld, rules) {
    if (isWorld) {
        if (!macroRules.canEditWorld()) return
        await game.settings.set(C.ID, "macroRules", rules)
    } else {
        if (!macroRules.canEditOwn()) return
        await game.user.setFlag(C.ID, "macroRules", rules)
    }
}
const getRules = (isWorld) => isWorld ? macroRules.getWorldRules() : macroRules.getUserRules()

// Добавить правило
macroRules.add = async (isWorld) => {
    const rules = getRules(isWorld)
    rules.push(createRule(isWorld))
    await saveRules(isWorld, rules)
}
// Изменить правило
macroRules.update = async (isWorld, ruleId, changes) => {
    const rules = getRules(isWorld)
    const rule = rules.find(r => r.id === ruleId)
    if (!rule) return
    Object.assign(rule, changes)
    await saveRules(isWorld, rules.map(r => sanitizeRule(r, isWorld)).filter(Boolean))
}
// Удалить правило
macroRules.remove = async (isWorld, ruleId) => {
    await saveRules(isWorld, getRules(isWorld).filter(r => r.id !== ruleId))
}


// ==================================================
// ————————————————— ПРАВА НА МАКРОС ————————————————
// ==================================================
// Макрос по UUID (только макросы мира, не из компендиумов)
macroRules.getMacro = (uuid) => {
    if (!uuid) return null
    const macro = fromUuidSync(uuid)
    return macro instanceof Macro ? macro : null
}
// Может ли пользователь выполнить макрос сам (доступ к макросу и право на скрипт-макросы)
macroRules.canUserExecute = (macro, user) => {
    if (!macro || !user) return false
    if (typeof macro.canUserExecute === "function") return macro.canUserExecute(user)
    return macro.testUserPermission(user, "LIMITED") && (macro.type !== "script" || user.can("MACRO_SCRIPT"))
}
// Пользователи-получатели правила мира, которые НЕ могут выполнить макрос сами (для значка-предупреждения)
// - Для «у ГМа» проверка не нужна; для «у привязанного игрока» заранее неизвестно, кто это, - проверяем всех игроков
macroRules.getUsersWithoutAccess = (rule, macro) => {
    if (!macro || rule.target === "gm") return []
    const users = rule.target === "users" ? rule.userIds.map(id => game.users.get(id)).filter(Boolean) : game.users.filter(u => !u.isGM)
    return users.filter(user => !macroRules.canUserExecute(macro, user))
}


// ==================================================
// ——————————————————— ВЫПОЛНЕНИЕ ———————————————————
// ==================================================
// Должно ли правило мира выполниться у этого клиента
function isWorldRuleForMe(rule, context) {
    switch (rule.target) {
        case "gm": return !!game.users.activeGM?.isSelf
        case "everyone": return true
        case "linked": return context.linkedUserIds.includes(game.user.id)
        case "users": return rule.userIds.includes(game.user.id)
    }
    return false
}

// Подходит ли правило под событие
// - by: кем выключен микрофон или звук (только для RULE_EVENTS_WITH_BY); у остальных событий не проверяется
function matchesEvent(rule, eventKey, by) {
    if (!rule.enabled || rule.event !== eventKey) return false
    return !RULE_EVENTS_WITH_BY.includes(eventKey) || rule.by === by
}

// Запуск правил для события
// - context: данные события для макроса (см. buildScope) + linkedUserIds
function runRules(eventKey, context, by = "any") {
    const worldRules = macroRules.getWorldRules().filter(rule => matchesEvent(rule, eventKey, by) && isWorldRuleForMe(rule, context))
    const ownRules = (!game.user.isGM && macroRules.playerRulesAllowed())
        ? macroRules.getUserRules().filter(rule => matchesEvent(rule, eventKey, by))
        : []
    for (const rule of worldRules) executeRule(rule, context, true)
    for (const rule of ownRules) executeRule(rule, context, false)
}

// Выполнение одного правила
// - test: проверочный запуск из вкладки «Макросы» (без ограничения частоты)
async function executeRule(rule, context, isWorldRule, {test = false} = {}) {
    // Ограничение частоты
    if (rule.cooldownSec && !test) {
        const last = lastRunByRuleId.get(rule.id) ?? 0
        if (now() - last < rule.cooldownSec * 1000) return
    }
    const macro = macroRules.getMacro(rule.macroUuid)
    if (!macro) {
        if (rule.macroUuid) reportProblem(rule, isWorldRule, null, modLoc("macros.errors.macroMissing"), {test})
        else if (test) ui.notifications.warn(modLoc("macros.errors.noMacro"))
        return
    }
    if (!test) lastRunByRuleId.set(rule.id, now())
    const scope = buildScope(context, rule)
    try {
        if (macroRules.canUserExecute(macro, game.user)) return await macro.execute(scope)
        // Нет доступа: выполняем, только если ГМ в правиле мира разрешил запуск без доступа
        if (isWorldRule && rule.allowWithoutPermission) return await executeWithoutPermission(macro, scope)
        reportProblem(rule, isWorldRule, macro, modLoc("macros.errors.noAccess"), {test})
    } catch (err) {
        reportProblem(rule, isWorldRule, macro, err?.message ?? String(err), {test, err})
    }
}

// Сообщение о проблеме с правилом (ошибка в макросе, нет доступа, макрос удалён)
// - Своё правило или мы ГМ - показываем уведомление здесь
// - Правило мира выполнялось у игрока - сообщаем ГМу: он автор правила, игрок сам исправить его не может
// - Об одной и той же проблеме одного правила - не чаще раза в RULE_PROBLEM_COOLDOWN_MS (проверочный запуск - всегда)
// Примечание: ошибки внутри макроса Foundry может перехватывать сам и показывать своё уведомление - тогда сюда они не дойдут
function reportProblem(rule, isWorldRule, macro, message, {test = false, err = null} = {}) {
    const key = `${rule.id}|${message}`
    if (!test && now() - (lastProblemByKey.get(key) ?? 0) < C.RULE_PROBLEM_COOLDOWN_MS) return
    if (!test) lastProblemByKey.set(key, now())
    const data = {event: modLoc(`macros.events.${rule.event}`), macro: macro?.name ?? "?", message}
    if (err) console.error(`${C.ID} | macro rule ${rule.id}: macro "${macro?.name}" failed`, err)
    else console.warn(`${C.ID} | macro rule ${rule.id}: ${message}`)
    if (!isWorldRule || game.user.isGM) return ui.notifications.error(modFormat("macros.errors.local", data))
    emitSocket("MACRO_RULE_PROBLEM", data)
}
onSocket("MACRO_RULE_PROBLEM", (data, senderId) => {
    if (!game.users.activeGM?.isSelf) return
    ui.notifications.error(modFormat("macros.errors.remote", {...data, user: game.users.get(senderId)?.name ?? "?"}))
})

// ==================================================
// ——————————————— ПРОВЕРОЧНЫЙ ЗАПУСК ———————————————
// ==================================================
// Запуск макроса правила с тестовыми данными - без Discord, только у того, кто нажал «Проверить»
// - Участник: привязанный к вам (если он в канале), иначе - первый в канале, иначе - выдуманный «Тестовый участник»
// - discordEvent.test = true: макрос может отличить проверку от настоящего события
macroRules.test = async (isWorld, ruleId) => {
    const rule = (isWorld ? macroRules.getWorldRules() : macroRules.getUserRules()).find(r => r.id === ruleId)
    if (!rule) return
    await executeRule(rule, buildTestContext(rule.event, rule.by), isWorld, {test: true})
}
function buildTestContext(type, by = "any") {
    const members = voiceChannel.getMembers()
    const ownId = getSettings("foundryDiscordIdsMap", false)?.[game.user.id]
    const member = members.find(m => m.id === ownId) ?? members[0] ?? {
        id: "0", nick: modLoc("macros.testMember"), name: "test", avatarUrl: null,
        mute: false, deaf: false, selfMute: false, serverMute: false, selfDeaf: false, serverDeaf: false, speaking: false, bot: false, raw: null,
    }
    const linked = getLinkedFoundryUsers(member.id)
    const foundryUsers = linked.length ? linked : [game.user]
    const context = {type, test: true, member, foundryUsers, linkedUserIds: foundryUsers.map(u => u.id)}
    // Изменение участника: «было» - противоположное состояние
    const toggles = {muted: ["mute", true], unmuted: ["mute", false], deafened: ["deaf", true], undeafened: ["deaf", false]}
    if (toggles[type]) {
        const [field, value] = toggles[type]
        // «Модератор» - меняем serverMute / serverDeaf, иначе - selfMute / selfDeaf
        const prefix = by === "server" ? "server" : "self"
        const ownField = prefix + (field === "mute" ? "Mute" : "Deaf")
        context.member = {...member, [field]: value, [ownField]: value}
        context.previous = {...member, [field]: !value, [ownField]: !value}
        context.changed = {[field]: value, [ownField]: value}
    }
    if (type === "updated") {
        context.previous = {...member, nick: `${member.nick} (old)`}
        context.changed = {nick: member.nick}
    }
    if (type === "speakingStart" || type === "speakingStop") context.member = {...context.member, speaking: type === "speakingStart"}
    if (type === "channelLoaded") context.reason = "relayStarted"
    if (type === "relayStarted" || type === "relayStopped") {
        context.member = null
        context.relayUser = game.user
    }
    return context
}
// Запуск макроса без проверки доступа (разрешено ГМом в правиле мира)
// - Скрипт выполняется так же, как это делает Foundry: с переменными speaker, actor, token, character, scope и переменными события
// - Макрос выполняется с правами текущего игрока: сделать то, что ему запрещено, он не сможет
async function executeWithoutPermission(macro, scope) {
    if (macro.type !== "script") return ui.chat.processMessage(macro.command)
    const speaker = ChatMessage.implementation.getSpeaker()
    const character = game.user.character ?? null
    const actor = game.actors.get(speaker.actor) ?? character
    const token = canvas.ready ? canvas.tokens.get(speaker.token) ?? null : null
    const keys = Object.keys(scope)
    const AsyncFunction = (async function() {}).constructor
    const fn = new AsyncFunction("speaker", "actor", "token", "character", "scope", ...keys, `{${macro.command}\n}`)
    return fn.call(macro, speaker, actor, token, character, scope, ...keys.map(key => scope[key]))
}

// Переменные для макроса
// - Все данные события - в ОДНОЙ переменной discordEvent (и scope.discordEvent), чтобы не занимать имена в коде макроса:
//   Foundry превращает каждую переменную в параметр функции, и объявление с тем же именем в макросе сломало бы его
// - Поля совпадают с аргументами крюков: type, member, foundryUser, foundryUsers, channel, members,
//   previous, changed, reason, relayUser, rule; test - проверочный запуск из вкладки «Макросы»
function buildScope(context, rule) {
    return {
        discordEvent: {
            type: context.type,
            member: context.member ?? null,
            foundryUser: context.foundryUsers?.[0] ?? null,
            foundryUsers: context.foundryUsers ?? [],
            channel: voiceChannel.getChannel(),
            members: voiceChannel.getMembers(),
            previous: context.previous ?? null,
            changed: context.changed ?? null,
            reason: context.reason ?? null,
            relayUser: context.relayUser ?? null,
            rule: foundry.utils.deepClone(rule),
            test: !!context.test,
        },
    }
}


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
// Данные события участника (из контекста крюка)
function memberContext(type, member, {foundryUsers = [], previous = null, changed = null, reason = null} = {}) {
    return {type, member, foundryUsers, linkedUserIds: foundryUsers.map(u => u.id), previous, changed, reason}
}

Hooks.on(HOOKS.MEMBER_JOINED, (member, context) => runRules("joined", memberContext("joined", member, context)))
Hooks.on(HOOKS.MEMBER_LEFT, (member, context) => runRules("left", memberContext("left", member, context)))
Hooks.on(HOOKS.MEMBER_UPDATED, (member, changed, context) => {
    runRules("updated", memberContext("updated", member, context))
    // Микрофон / звук: «сам» и «модератор» - по своим полям (см. BY_FIELDS)
    for (const [by, fields] of Object.entries(BY_FIELDS)) {
        for (const [field, [onType, offType]] of Object.entries(fields)) {
            if (!(field in changed)) continue
            const type = changed[field] ? onType : offType
            runRules(type, memberContext(type, member, context), by)
        }
    }
})
Hooks.on(HOOKS.MEMBER_MUTE_CHANGED, (member, muted, context) => {
    const type = muted ? "muted" : "unmuted"
    runRules(type, memberContext(type, member, context))
})
Hooks.on(HOOKS.MEMBER_DEAF_CHANGED, (member, deafened, context) => {
    const type = deafened ? "deafened" : "undeafened"
    runRules(type, memberContext(type, member, context))
})
Hooks.on(HOOKS.MEMBER_SPEAKING_CHANGED, (member, speaking, context) => {
    const type = speaking ? "speakingStart" : "speakingStop"
    runRules(type, memberContext(type, member, context))
})
Hooks.on(HOOKS.CHANNEL_LOADED, (channel, members, {reason}) => runRules("channelLoaded", {type: "channelLoaded", linkedUserIds: [], reason}))
// События ретранслятора: запуск/остановка - переход из статуса OFFLINE и в него. «Привязанный игрок» - сам ретранслятор
Hooks.on(HOOKS.RELAY_STATUS_CHANGED, (user, status, previousStatus) => {
    const type = previousStatus === "OFFLINE" ? "relayStarted" : status === "OFFLINE" ? "relayStopped" : null
    if (type) runRules(type, {type, relayUser: user, linkedUserIds: [user.id]})
})
