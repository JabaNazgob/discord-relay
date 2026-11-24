import { Constants as C } from "../data/const.js"
import { createTicker, getOverlayUrl, getSettings, getVoiceChannelIds, isFoundryApp, isObject, modLoc, now } from "../data/functions.js"
const { HELLO_TIMEOUT_MS, DISCORD_TIMEOUT_MS, OVERLAY_TTL_MS, PING_INTERVAL_MS, TICK_MS } = C

// ==================================================
// —————————————————— РЕТРАНСЛЯТОР ——————————————————
// ==================================================
// Локальная часть ретранслятора: окно StreamKit и связь со скриптом TamperMonkey у ЭТОГО игрока.
// Выбор основного ретранслятора - в relayNetwork.js, раздача событий остальным игрокам - в voiceChannel.js.
//
// Статусы (relay.state.status):
// - IDLE: ретранслятор выключен
// - APP: Foundry открыт в приложении, запуск невозможен
// - DISABLED: модуль выключен в настройках
// - NO_CHANNEL: не указан голосовой канал
// - POPUP_BLOCKED: браузер заблокировал окно StreamKit
// - CONNECTING: окно открыто, ждём «привета» от скрипта
// - NO_SCRIPT: «привета» так и нет (ожидание продолжается)
// - OLD_SCRIPT: у игрока старый/несовместимый скрипт
// - WAITING_DISCORD: скрипт на связи, ждём данных канала от Discord
// - DISCORD_SILENT: данных от Discord так и нет (ожидание продолжается)
// - DISCORD_UNREACHABLE: приложение Discord не запущено или связь с ним оборвалась (ожидание продолжается)
// - CHANNEL_ERROR: Discord ответил ошибкой на запрос канала (неверная ссылка, нет доступа)
// - ACTIVE: всё работает
// - OVERLAY_CLOSED: окно StreamKit закрыли
export const RELAY_STATUS = {
    IDLE: "IDLE",
    APP: "APP",
    DISABLED: "DISABLED",
    NO_CHANNEL: "NO_CHANNEL",
    POPUP_BLOCKED: "POPUP_BLOCKED",
    CONNECTING: "CONNECTING",
    NO_SCRIPT: "NO_SCRIPT",
    OLD_SCRIPT: "OLD_SCRIPT",
    WAITING_DISCORD: "WAITING_DISCORD",
    DISCORD_SILENT: "DISCORD_SILENT",
    DISCORD_UNREACHABLE: "DISCORD_UNREACHABLE",
    CHANNEL_ERROR: "CHANNEL_ERROR",
    ACTIVE: "ACTIVE",
    OVERLAY_CLOSED: "OVERLAY_CLOSED",
}
const S = RELAY_STATUS
// Статусы, при которых ретранслятор работает (окно StreamKit открыто и мы его слушаем)
const RUNNING_STATUSES = new Set([S.CONNECTING, S.NO_SCRIPT, S.WAITING_DISCORD, S.DISCORD_SILENT, S.DISCORD_UNREACHABLE, S.CHANNEL_ERROR, S.ACTIVE])
// Статусы-проблемы: о них дополнительно сообщаем всплывающим уведомлением
const PROBLEM_STATUSES = new Set([S.APP, S.DISABLED, S.NO_CHANNEL, S.POPUP_BLOCKED, S.NO_SCRIPT, S.OLD_SCRIPT, S.DISCORD_SILENT, S.DISCORD_UNREACHABLE, S.CHANNEL_ERROR, S.OVERLAY_CLOSED])
// Проблемы, которые могут решиться сами (ожидание продолжается) - о них предупреждаем, а не сообщаем как об ошибке
const WAITING_PROBLEM_STATUSES = new Set([S.NO_SCRIPT, S.DISCORD_SILENT, S.DISCORD_UNREACHABLE])
// Ключ в sessionStorage: был ли ретранслятор включён до перезагрузки страницы
const SESSION_KEY = `${C.ID}.relayRunning`
// Ключ в sessionStorage: время запуска ретранслятора (чтобы после перезагрузки страницы не потерять «старшинство»)
const SESSION_STARTED_KEY = `${C.ID}.relayStartedAt`
// Ключ в localStorage: в этом браузере скрипт TamperMonkey уже хоть раз успешно ответил (значит, TamperMonkey установлен)
const SCRIPT_VERIFIED_KEY = `${C.ID}.scriptVerified`

export const relay = {}

// ——————————————————{ СОСТОЯНИЕ }———————————————————
relay.state = {
    status: S.IDLE,
    // Время запуска ретранслятора (по часам этого компьютера). По нему выбирается активный ретранслятор
    startedAt: 0,
    // Версия скрипта TamperMonkey (из «привета»)
    scriptVersion: null,
    // Скрипт старее актуальной версии, но ещё совместим
    scriptOutdated: false,
    // Замечен второй, старый скрипт (0.3.0) рядом с новым
    oldScriptAlongside: false,
    // Текст ошибки от Discord (для CHANNEL_ERROR)
    channelError: null,
    // Данные канала, полученные от Discord
    channel: null,          // {guild_id, channel_id, name, userCount}
    // Последнее событие от Discord (для проверки, что события идут)
    lastEvent: null,        // {evt, ts}
    // Когда последний раз получали хоть что-то от окна StreamKit
    lastSeenTs: 0,
    // Окно StreamKit не отвечает дольше OVERLAY_TTL_MS
    overlayUnresponsive: false,
}

// —————————————{ ВНУТРЕННИЕ ПЕРЕМЕННЫЕ }————————————
// Ссылка на окно StreamKit
let overlayWindow = null
// Какой канал открыт в окне StreamKit ("ID сервера/ID канала")
let overlayChannelKey = null
// Скрипт ответил, и мы отправили ему CONNECT
let connected = false
// Таймеры ожидания
let helloTimeoutId = null
let discordTimeoutId = null
// Время последнего пинга
let lastPingTs = 0
// Тикер (не замедляется в фоновой вкладке)
const ticker = createTicker(() => onTick(), TICK_MS)
// Подписчики на изменение состояния (окно модуля)
const listeners = new Set()
// Подписчики на события Discord (голосовой канал)
const eventListeners = new Set()
// Почему придут следующие данные канала (для крюка voiceChannelLoaded):
// relayStarted / channelChanged / reconnected
let nextLoadReason = "relayStarted"


// ==================================================
// ——————————————————— ПОДПИСКА ——————————————————————
// ==================================================
// Подписка на изменения состояния ретранслятора
// - Возвращает функцию отписки
relay.subscribe = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}
// Подписка на события Discord из своего окна StreamKit
// - {type: "channel", channel, voiceStates, speaking, reason} - получены данные канала (целиком)
// - {type: "event", evt, data, ts} - событие участника (VOICE_STATE_* / SPEAKING_*)
// - Возвращает функцию отписки
relay.onDiscordEvent = (fn) => {
    eventListeners.add(fn)
    return () => eventListeners.delete(fn)
}
function emitDiscordEvent(event) {
    for (const fn of eventListeners) {
        try { fn(event) } catch (err) { console.error(`${C.ID} | relay event listener failed`, err) }
    }
}
function notifyListeners() {
    for (const fn of listeners) {
        try { fn(relay.state) } catch (err) { console.error(`${C.ID} | relay listener failed`, err) }
    }
}
// Изменение состояния
// - Если статус сменился на «проблемный» - дополнительно показываем уведомление
function setState(changes) {
    const prevStatus = relay.state.status
    Object.assign(relay.state, changes)
    const status = relay.state.status
    if (status !== prevStatus && PROBLEM_STATUSES.has(status)) {
        const level = WAITING_PROBLEM_STATUSES.has(status) ? "warn" : "error"
        ui.notifications[level](`${modLoc("discordMenu.windowTitle")}: ${modLoc(`relayState.${status}.title`)}`)
    }
    notifyListeners()
}

// Работает ли ретранслятор у этого игрока
relay.isRunning = () => RUNNING_STATUSES.has(relay.state.status)
// Отвечал ли когда-нибудь скрипт TamperMonkey в этом браузере
relay.isScriptVerified = () => {
    try { return !!localStorage.getItem(SCRIPT_VERIFIED_KEY) } catch (err) { return false }
}


// ==================================================
// ————————————————— ЗАПУСК / ОСТАНОВКА —————————————
// ==================================================
// Проверки перед запуском
// - Возвращает статус-проблему или null, если запускать можно
relay.getStartBlocker = () => {
    if (isFoundryApp()) return S.APP
    if (!getSettings("discordBridgeIsActive", false)) return S.DISABLED
    if (!getVoiceChannelIds()) return S.NO_CHANNEL
    return null
}

// Запуск ретранслятора
relay.start = () => {
    const blocker = relay.getStartBlocker()
    if (blocker) return setState({status: blocker})

    // Открываем окно StreamKit
    // - Если окно с таким именем уже открыто, браузер откроет страницу в нём, а не создаст новое
    const ids = getVoiceChannelIds()
    const url = getOverlayUrl(ids)
    const features = getSettings("overlayPopup", false) ? C.OVERLAY_POPUP_FEATURES : ""
    const win = window.open(url, C.OVERLAY_WINDOW_NAME, features)
    if (!win) return setState({status: S.POPUP_BLOCKED})

    attachOverlay(win)
    overlayChannelKey = `${ids.guild_id}/${ids.channel_id}`
    setState({status: S.CONNECTING})
    startHelloTimeout()
}

// Остановка ретранслятора
// - Просим скрипт закрыть окно StreamKit и закрываем его сами (на случай, если скрипт не ответит)
relay.stop = () => {
    if (overlayWindow && !overlayWindow.closed) {
        sendToOverlay("DISCONNECT")
        try { overlayWindow.close() } catch (err) {}
    }
    detachOverlay()
    setState({status: S.IDLE, channel: null, lastEvent: null})
}

// Переключение
relay.toggle = () => relay.isRunning() ? relay.stop() : relay.start()

// Смена канала при работающем ретрансляторе
// - Открываем в том же окне StreamKit новый канал. Скрипт на новой странице снова пришлёт «привет»
// - Настройка канала меняется и когда ГМ сохраняет его название - тогда (канал тот же) ничего не делаем
relay.onChannelChanged = () => {
    if (!relay.isRunning() || !overlayWindow || overlayWindow.closed) return
    const ids = getVoiceChannelIds()
    if (!ids) return relay.stop()
    const channelKey = `${ids.guild_id}/${ids.channel_id}`
    if (channelKey === overlayChannelKey) return
    overlayChannelKey = channelKey
    try {
        overlayWindow.location.replace(getOverlayUrl(ids))
    } catch (err) {
        return relay.start()
    }
    connected = false
    nextLoadReason = "channelChanged"
    setState({status: S.CONNECTING, channel: null, channelError: null})
    startHelloTimeout()
}


// ==================================================
// ——————————————————— ОКНО STREAMKIT ———————————————
// ==================================================
// Привязка к окну StreamKit
// - restoreStartedAt: окно подхвачено после перезагрузки Foundry - берём прежнее время запуска
function attachOverlay(win, {restoreStartedAt = false} = {}) {
    overlayWindow = win
    connected = false
    lastPingTs = 0
    nextLoadReason = restoreStartedAt ? "reconnected" : "relayStarted"
    let startedAt = 0
    try {
        if (restoreStartedAt) startedAt = Number(sessionStorage.getItem(SESSION_STARTED_KEY)) || 0
        if (!startedAt) startedAt = now()
        sessionStorage.setItem(SESSION_KEY, "1")
        sessionStorage.setItem(SESSION_STARTED_KEY, String(startedAt))
    } catch (err) {
        startedAt = startedAt || now()
    }
    setState({startedAt, scriptVersion: null, scriptOutdated: false, oldScriptAlongside: false, channel: null, channelError: null, lastEvent: null, lastSeenTs: 0, overlayUnresponsive: false})
    ticker.start()
}
// Отвязка от окна StreamKit
function detachOverlay() {
    overlayWindow = null
    overlayChannelKey = null
    connected = false
    clearTimeout(helloTimeoutId)
    clearTimeout(discordTimeoutId)
    helloTimeoutId = discordTimeoutId = null
    forgetRunningBeforeReload()
    ticker.stop()
}

// Отправка сообщения скрипту
function sendToOverlay(type, payload = {}) {
    if (!overlayWindow || overlayWindow.closed) return
    try {
        overlayWindow.postMessage({source: C.MESSAGE_SOURCE, type, ...payload}, C.STREAMKIT_ORIGIN)
    } catch (err) {}
}

// Ожидание «привета» от скрипта
function startHelloTimeout() {
    clearTimeout(helloTimeoutId)
    helloTimeoutId = setTimeout(() => {
        if (relay.state.status !== S.CONNECTING) return
        // Отвечает только старый скрипт - перестаём слушать окно и просим обновить скрипт
        if (relay.state.oldScriptAlongside) {
            detachOverlay()
            setState({status: S.OLD_SCRIPT, scriptVersion: "0.3.0", oldScriptAlongside: false})
        } else {
            setState({status: S.NO_SCRIPT})
        }
    }, HELLO_TIMEOUT_MS)
}
// Ожидание данных канала от Discord
function startDiscordTimeout() {
    clearTimeout(discordTimeoutId)
    discordTimeoutId = setTimeout(() => {
        if (relay.state.status === S.WAITING_DISCORD) setState({status: S.DISCORD_SILENT})
    }, DISCORD_TIMEOUT_MS)
}

// Периодическая проверка
// - Окно закрыли → сообщаем
// - Пингуем окно, чтобы понимать, что оно живо
// - Давно нет ответа → помечаем окно как не отвечающее
function onTick() {
    if (!overlayWindow) return
    if (overlayWindow.closed) {
        detachOverlay()
        setState({status: S.OVERLAY_CLOSED, channel: null})
        return
    }
    const ts = now()
    if (connected && ts - lastPingTs >= PING_INTERVAL_MS) {
        lastPingTs = ts
        sendToOverlay("PING")
    }
    const unresponsive = connected && ts - relay.state.lastSeenTs > OVERLAY_TTL_MS
    if (unresponsive !== relay.state.overlayUnresponsive) setState({overlayUnresponsive: unresponsive})
}


// ==================================================
// ————————————— СООБЩЕНИЯ ОТ STREAMKIT —————————————
// ==================================================
function onOverlayMessage(event) {
    // Принимаем сообщения только со StreamKit
    if (event.origin !== C.STREAMKIT_ORIGIN) return
    const msg = event.data
    if (!isObject(msg)) return
    if (CONFIG.debug?.discordBridge?.overlayMessage) console.log(`${C.ID} | overlay message:`, msg)

    // Сообщение от старого скрипта (0.3.0) - у него нет нашей метки
    if (msg.source !== C.SCRIPT.SOURCE) {
        if (overlayWindow && event.source === overlayWindow && isOldScriptMessage(msg)) onOldScriptMessage()
        return
    }

    // Окно StreamKit осталось открытым после перезагрузки Foundry - подхватываем его
    if (!overlayWindow && wasRunningBeforeReload() && (msg.type === "ALIVE" || msg.type === "HELLO")) {
        // Пока страница перезагружалась, ГМ мог выключить модуль или убрать канал - тогда окно не подхватываем, а закрываем
        if (relay.getStartBlocker()) {
            try { event.source.postMessage({source: C.MESSAGE_SOURCE, type: "DISCONNECT"}, C.STREAMKIT_ORIGIN) } catch (err) {}
            forgetRunningBeforeReload()
            return
        }
        attachOverlay(event.source, {restoreStartedAt: true})
        const ids = getVoiceChannelIds()
        overlayChannelKey = ids ? `${ids.guild_id}/${ids.channel_id}` : null
        setState({status: S.CONNECTING})
        startHelloTimeout()
    }
    if (!overlayWindow || event.source !== overlayWindow) return

    // Время последнего сообщения обновляем без перерисовки окна (сообщения идут часто)
    relay.state.lastSeenTs = now()
    if (relay.state.overlayUnresponsive) setState({overlayUnresponsive: false})

    switch (msg.type) {
        case "HELLO":
        case "ALIVE": {
            if (!connected || msg.type === "HELLO") onHello(msg)
            break
        }
        case "EVENT": {
            onDiscordEvent(msg)
            break
        }
        case "DISCORD_STATE": {
            onDiscordState(msg.state)
            break
        }
        case "SNAPSHOT": {
            onChannelData(msg.data?.channel, msg.data?.voice_states, msg.data?.speaking)
            break
        }
    }
}

// «Привет» от скрипта (или напоминание о себе после перезагрузки Foundry)
function onHello(msg) {
    const version = String(msg.version ?? "0")
    // Скрипт несовместим - запускаться нельзя
    if (msg.protocol !== C.SCRIPT.PROTOCOL || foundry.utils.isNewerVersion(C.SCRIPT.MIN_VERSION, version)) {
        // Окно StreamKit не закрываем, но перестаём его слушать
        detachOverlay()
        setState({status: S.OLD_SCRIPT, scriptVersion: version})
        return
    }
    const isReconnect = msg.type === "ALIVE"
    connected = true
    try { localStorage.setItem(SCRIPT_VERIFIED_KEY, version) } catch (err) {}
    clearTimeout(helloTimeoutId)
    sendToOverlay("CONNECT")
    setState({
        scriptVersion: version,
        scriptOutdated: foundry.utils.isNewerVersion(C.SCRIPT.VERSION, version),
    })
    // После перезагрузки Foundry канал уже загружен в StreamKit - просим снимок
    if (isReconnect) sendToOverlay("SNAPSHOT_REQUEST")
    // «Привет» приходит и при перезагрузке самого окна StreamKit - тогда данные канала придут заново
    if (!isReconnect || relay.state.status !== S.ACTIVE) {
        setState({status: S.WAITING_DISCORD, channel: null})
        startDiscordTimeout()
    }
}

// Событие от Discord
function onDiscordEvent(msg) {
    // Ошибка на запрос канала (неверная ссылка, нет доступа к серверу и т.д.)
    if (msg.evt === "ERROR") {
        if (msg.cmd !== "GET_CHANNEL") return console.warn(`${C.ID} | Discord error:`, msg.cmd, msg.data?.message ?? msg.data)
        clearTimeout(discordTimeoutId)
        return setState({status: S.CHANNEL_ERROR, channelError: String(msg.data?.message ?? msg.data?.code ?? "?")})
    }
    if (msg.cmd === "GET_CHANNEL") return onChannelData(msg.data, msg.data?.voice_states)
    if (typeof msg.evt !== "string") return
    emitDiscordEvent({type: "event", evt: msg.evt, data: msg.data, ts: msg.ts || now()})
    // События идут - значит, связь с Discord есть, даже если данные канала мы пропустили (например, Discord переподключился)
    if (relay.state.status === S.WAITING_DISCORD || relay.state.status === S.DISCORD_SILENT || relay.state.status === S.DISCORD_UNREACHABLE) {
        clearTimeout(discordTimeoutId)
        setState({status: S.ACTIVE})
    }
    setState({lastEvent: {evt: msg.evt, ts: msg.ts || now()}})
}

// Состояние связи StreamKit с приложением Discord (скрипт 1.1.0+)
function onDiscordState(state) {
    if (!connected) return
    if (state === "unreachable" || state === "disconnected") {
        clearTimeout(discordTimeoutId)
        return setState({status: S.DISCORD_UNREACHABLE})
    }
    // Discord снова доступен - ждём от него данные канала
    if (state === "connected" && relay.state.status === S.DISCORD_UNREACHABLE) {
        setState({status: S.WAITING_DISCORD})
        startDiscordTimeout()
    }
}

// Данные канала (при подключении StreamKit к Discord или из снимка)
function onChannelData(channel, voiceStates, speaking = []) {
    if (!isObject(channel)) return
    clearTimeout(discordTimeoutId)
    emitDiscordEvent({type: "channel", channel, voiceStates: Array.isArray(voiceStates) ? voiceStates : [], speaking: Array.isArray(speaking) ? speaking : [], reason: nextLoadReason})
    // Все следующие данные канала без перезапуска и смены канала - это переподключение StreamKit к Discord
    nextLoadReason = "reconnected"
    setState({
        status: S.ACTIVE,
        channelError: null,
        channel: {
            guild_id: channel.guild_id ?? null,
            channel_id: channel.channel_id ?? channel.id ?? null,
            name: channel.name ?? null,
            userCount: Array.isArray(voiceStates) ? voiceStates.length : 0,
        },
    })
}

// Старый скрипт
// - Сразу не решаем: если установлены оба скрипта, «привет» от нового может прийти чуть позже.
//   Запоминаем, что старый замечен, а вывод делаем по «привету» или по истечении ожидания
function isOldScriptMessage(msg) {
    return msg.type === "DV_OVERLAY_HB" || typeof msg.evt === "string"
}
function onOldScriptMessage() {
    if (relay.state.oldScriptAlongside) return
    // Предупреждение показываем, только если новый скрипт уже на связи
    if (connected) setState({oldScriptAlongside: true})
    else relay.state.oldScriptAlongside = true
}

// Был ли ретранслятор включён до перезагрузки страницы
function wasRunningBeforeReload() {
    try { return sessionStorage.getItem(SESSION_KEY) === "1" } catch (err) { return false }
}
// Забыть, что ретранслятор был включён до перезагрузки
function forgetRunningBeforeReload() {
    try {
        sessionStorage.removeItem(SESSION_KEY)
        sessionStorage.removeItem(SESSION_STARTED_KEY)
    } catch (err) {}
}


// ==================================================
// ———————————————————— HOOKS ———————————————————————
// ==================================================
Hooks.once("ready", () => {
    // Слушаем окно StreamKit всегда: так после перезагрузки Foundry уже открытое окно подхватится само
    window.addEventListener("message", onOverlayMessage)
    // Если после перезагрузки окно так и не отозвалось - забываем о нём
    if (wasRunningBeforeReload()) {
        setTimeout(() => {
            if (!overlayWindow) try { sessionStorage.removeItem(SESSION_KEY) } catch (err) {}
        }, HELLO_TIMEOUT_MS)
    }
})
