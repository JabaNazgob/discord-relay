import { Constants as C, HOOKS } from "../data/const.js"
import { createTicker, getSettings, now } from "../data/functions.js"
import { emitSocket, onSocket } from "../data/socket.js"
import { relay, RELAY_STATUS as LOCAL } from "./relay.js"
const { HB_INTERVAL_MS, READY_TTL_MS, SYNC_MS, TICK_MS } = C

// ==================================================
// —————————————— СЕТЬ РЕТРАНСЛЯТОРОВ ———————————————
// ==================================================
// Статусы ретрансляторов у ВСЕХ игроков и выбор активного ретранслятора.
//
// Как это работает:
// - Каждый игрок с запущенным ретранслятором раз в HB_INTERVAL_MS рассылает всем «я жив» (RELAY_HEARTBEAT)
//   со своим состоянием. Таймер работает в Web Worker, поэтому не замедляется в фоновой вкладке
// - Каждый клиент сам считает статусы по времени ПОЛУЧЕНИЯ «я жив» (часы разных компьютеров не сравниваются)
// - Активный ретранслятор выбирается одинаково у всех: назначенный ГМом (если он работает),
//   иначе - запущенный раньше всех. Время запуска присылает сам ретранслятор, поэтому у всех оно одинаковое
// - ГМ для всего этого не нужен
export const USER_STATUS = {
    OFFLINE: "OFFLINE",
    STARTING: "STARTING",
    READY: "READY",
    ONLINE: "ONLINE",
    STALE: "STALE",
}
const U = USER_STATUS

export const relayNetwork = {}

// —————————————{ ВНУТРЕННИЕ ПЕРЕМЕННЫЕ }————————————
// Записи о запущенных ретрансляторах: userId -> {startedAt, localStatus, overlayUnresponsive, scriptVersion, receivedAt}
const records = new Map()
// Статусы игроков на прошлой проверке (для поиска изменений)
let prevUsersStatus = {}
// Активный ретранслятор
let activeRelayUserId = null
// Общий статус (для крюка relayStatusChanged)
let overallStatus = "OFFLINE"
// Идёт первичный сбор статусов после входа в мир (крюки не вызываем)
let syncing = true
// Когда последний раз рассылали «я жив», и что в нём было
let lastHeartbeatTs = 0
let lastHeartbeatKey = ""
// Подписчики на изменения (окно модуля)
const listeners = new Set()
// Тикер (не замедляется в фоновой вкладке)
const ticker = createTicker(() => onTick(), TICK_MS)


// ==================================================
// ————————————————————— API ————————————————————————
// ==================================================
// Подписка на изменения статусов
// - Возвращает функцию отписки
relayNetwork.subscribe = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}
// ID активного ретранслятора (или null)
relayNetwork.getActiveRelayUserId = () => activeRelayUserId
// Является ли пользователь активным ретранслятором (по умолчанию - текущий)
relayNetwork.isActiveRelay = (userId = game.user?.id) => !!userId && userId === activeRelayUserId
// Статус пользователя как ретранслятора
// - {status, active, fresh, ageMs, localStatus, isRelay}
relayNetwork.getUserStatus = (userId) => computeUserStatus(userId)
// Статусы всех игроков в игре (формат крюка usersRelayStatusChanged)
relayNetwork.getUsersStatus = () => computeUsersStatus()
// Общий статус: OFFLINE / STARTING / STALE / ACTIVE
relayNetwork.getOverallStatus = () => overallStatus
// Пересчитать статусы (например, после того как ГМ назначил ретранслятор)
relayNetwork.refresh = () => {
    evaluate()
    notifyListeners()
}


// ==================================================
// ————————————————— РАСЧЁТ СТАТУСОВ ————————————————
// ==================================================
// Может ли ретранслятор быть активным: сигнал свежий, всё работает
function isCandidate(record) {
    if (!record) return false
    return (now() - record.receivedAt) <= READY_TTL_MS && record.localStatus === LOCAL.ACTIVE && !record.overlayUnresponsive
}

// Статус одного пользователя
function computeUserStatus(userId) {
    const user = game.users.get(userId)
    const record = records.get(userId)
    if (!user?.active || !record) return {status: U.OFFLINE, active: false, fresh: false, ageMs: Infinity, localStatus: null, isRelay: false}

    const ageMs = now() - record.receivedAt
    const fresh = isCandidate(record)
    const isRelay = userId === activeRelayUserId
    const status = (ageMs > READY_TTL_MS || record.overlayUnresponsive) ? U.STALE
        : record.localStatus !== LOCAL.ACTIVE ? U.STARTING
        : isRelay ? U.ONLINE
        : U.READY
    return {status, active: true, fresh, ageMs, localStatus: record.localStatus, isRelay}
}

// Статусы всех игроков в игре
// - Формат совместим со старой версией: {userId: {active, fresh, ageMs}} + новые поля status, isRelay
function computeUsersStatus() {
    const result = {}
    for (const user of game.users) {
        if (user.active) result[user.id] = computeUserStatus(user.id)
    }
    return result
}

// Выбор активного ретранслятора
// - Назначенный ГМом, если он может работать; иначе - запущенный раньше всех (при равенстве - по ID)
function electRelay() {
    const candidates = [...records.entries()].filter(([userId, record]) => game.users.get(userId)?.active && isCandidate(record))
    if (!candidates.length) return null
    const preferred = getSettings("preferredRelayUserId", false)
    if (preferred && candidates.some(([userId]) => userId === preferred)) return preferred
    candidates.sort(([idA, a], [idB, b]) => (a.startedAt - b.startedAt) || idA.localeCompare(idB))
    return candidates[0][0]
}

// Общий статус
function computeOverallStatus(usersStatus) {
    const statuses = Object.values(usersStatus)
    if (activeRelayUserId) return "ACTIVE"
    if (!statuses.some(s => s.active)) return "OFFLINE"
    if (statuses.some(s => s.status === U.STALE)) return "STALE"
    return "STARTING"
}


// ==================================================
// ————————————————— ПЕРЕСЧЁТ И КРЮКИ ———————————————
// ==================================================
// Пересчёт статусов, выбор активного ретранслятора, вызов крюков при изменениях
function evaluate() {
    const prevRelayUserId = activeRelayUserId
    activeRelayUserId = electRelay()
    const usersStatus = computeUsersStatus()
    const prevOverall = overallStatus
    overallStatus = computeOverallStatus(usersStatus)

    // Ищем изменения по игрокам
    const changes = {}
    const userIds = new Set([...Object.keys(prevUsersStatus), ...Object.keys(usersStatus)])
    for (const userId of userIds) {
        const prev = prevUsersStatus[userId] ?? {status: U.OFFLINE, active: false, fresh: false}
        const next = usersStatus[userId] ?? {status: U.OFFLINE, active: false, fresh: false}
        if (prev.status === next.status && prev.active === next.active && prev.fresh === next.fresh) continue
        changes[userId] = {
            prev: {active: prev.active, fresh: prev.fresh, status: prev.status},
            next: {active: next.active, fresh: next.fresh, status: next.status},
        }
    }
    prevUsersStatus = usersStatus

    const hasChanges = Object.keys(changes).length > 0
    const relayChanged = prevRelayUserId !== activeRelayUserId
    const overallChanged = prevOverall !== overallStatus

    // Во время первичного сбора крюки не вызываем: ретрансляторы не «запустились», мы просто узнали о них
    // - relayStatusChanged(user, status, previousStatus) - по каждому игроку
    // - activeRelayChanged(user, previousUser) - сменился основной ретранслятор
    if (!syncing) {
        for (const [userId, change] of Object.entries(changes)) {
            const user = game.users.get(userId)
            if (user && change.prev.status !== change.next.status) Hooks.callAll(HOOKS.RELAY_STATUS_CHANGED, user, change.next.status, change.prev.status)
        }
        if (relayChanged) Hooks.callAll(HOOKS.ACTIVE_RELAY_CHANGED, game.users.get(activeRelayUserId) ?? null, game.users.get(prevRelayUserId) ?? null)
        if (hasChanges) notifyChangesListeners(usersStatus, changes)
    }

    if (hasChanges || relayChanged || overallChanged) notifyListeners()
}

// Подписчики на изменения статусов в сводном виде (для устаревшего крюка usersRelayStatusChanged, см. legacy.js)
const changesListeners = new Set()
relayNetwork.onStatusChanges = (fn) => {
    changesListeners.add(fn)
    return () => changesListeners.delete(fn)
}
function notifyChangesListeners(usersStatus, changes) {
    for (const fn of changesListeners) {
        try { fn(usersStatus, changes) } catch (err) { console.error(`${C.ID} | relayNetwork changes listener failed`, err) }
    }
}

function notifyListeners() {
    for (const fn of listeners) {
        try { fn() } catch (err) { console.error(`${C.ID} | relayNetwork listener failed`, err) }
    }
}


// ==================================================
// ——————————————————— «Я ЖИВ» ——————————————————————
// ==================================================
// Состояние своего ретранслятора для рассылки
function getOwnRecord() {
    const state = relay.state
    return {
        startedAt: state.startedAt,
        localStatus: state.status,
        overlayUnresponsive: state.overlayUnresponsive,
        scriptVersion: state.scriptVersion,
    }
}

// Обновление своей записи и рассылка «я жив»
// - force: разослать сразу (при изменении состояния или по запросу)
function updateOwnRecord({force = false} = {}) {
    const userId = game.user.id
    if (!relay.isRunning()) {
        // Ретранслятор выключили - сообщаем один раз
        if (records.has(userId)) {
            records.delete(userId)
            lastHeartbeatKey = ""
            emitSocket("RELAY_STOPPED")
            evaluate()
        }
        return
    }
    const record = getOwnRecord()
    records.set(userId, {...record, receivedAt: now()})
    // Рассылаем, если пора или если состояние изменилось
    const key = JSON.stringify(record)
    if (force || key !== lastHeartbeatKey || now() - lastHeartbeatTs >= HB_INTERVAL_MS) {
        lastHeartbeatKey = key
        lastHeartbeatTs = now()
        emitSocket("RELAY_HEARTBEAT", record)
    }
    evaluate()
}

// Периодическая проверка
// - Рассылаем «я жив» и пересчитываем статусы (чтобы заметить, что чей-то сигнал пропал)
function onTick() {
    updateOwnRecord()
    evaluate()
}


// ==================================================
// ———————————————————— СОКЕТЫ ——————————————————————
// ==================================================
// «Я жив» от другого ретранслятора
onSocket("RELAY_HEARTBEAT", (data, senderId) => {
    if (!senderId || senderId === game.user.id) return
    records.set(senderId, {
        startedAt: Number(data.startedAt) || 0,
        localStatus: data.localStatus ?? null,
        overlayUnresponsive: !!data.overlayUnresponsive,
        scriptVersion: data.scriptVersion ?? null,
        receivedAt: now(),
    })
    evaluate()
})
// Ретранслятор выключен
onSocket("RELAY_STOPPED", (data, senderId) => {
    if (!senderId || !records.delete(senderId)) return
    evaluate()
})
// Новый игрок просит всех прислать статус (чтобы не ждать следующего «я жив»)
onSocket("RELAY_STATUS_REQUEST", () => {
    if (relay.isRunning()) updateOwnRecord({force: true})
})


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
Hooks.once("ready", () => {
    // Запускаем проверку и просим всех прислать статусы
    ticker.start()
    emitSocket("RELAY_STATUS_REQUEST")
    // Первичный сбор статусов: крюки начнём вызывать чуть позже
    setTimeout(() => {
        evaluate()
        syncing = false
    }, SYNC_MS)
    // Изменения своего ретранслятора рассылаем сразу
    relay.subscribe(() => updateOwnRecord())
})
// Игрок вышел из мира - забываем его ретранслятор. Игрок зашёл - обновляем таблицу
Hooks.on("userConnected", (user, connected) => {
    if (!connected) records.delete(user.id)
    evaluate()
    notifyListeners()
})
