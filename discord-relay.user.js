// ==UserScript==
// @name         Streamkit Speaking Relay
// @namespace    vnde
// @version      1.1.0
// @description  Relays Discord voice channel events from the Streamkit overlay to Foundry VTT (module "discord-relay").
// @match        https://streamkit.discord.com/overlay/voice/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Примечание: @name и @namespace совпадают со старым скриптом (0.3.0),
// чтобы TamperMonkey обновил старый скрипт, а не поставил второй рядом

(function() {
    'use strict'

    const SCRIPT_VERSION = "1.1.0"
    const PROTOCOL = 1
    const SOURCE = "discord-relay-tm"          // Метка наших сообщений
    const FOUNDRY_SOURCE = "discord-relay"     // Метка сообщений от модуля
    const HELLO_INTERVAL_MS = 1000             // Как часто повторять «привет», пока Foundry не ответил
    const HELLO_MAX_TRIES = 30
    const ALIVE_INTERVAL_MS = 5000             // Как часто напоминать Foundry о себе (нужно, чтобы переподключиться после перезагрузки Foundry)
    const BUFFER_MAX = 200                     // Сколько событий хранить, пока Foundry не ответил

    const orig = {
        log: window.console.log.bind(window.console),
        info: window.console.info.bind(window.console),
        debug: window.console.debug.bind(window.console),
    }

    // Адрес Foundry. Пока он неизвестен, события копятся в буфере
    // - Узнаём его из первого сообщения от окна Foundry, открывшего этот оверлей
    let foundryOrigin = null
    const buffer = []

    // Текущее состояние канала (для «снимка» по запросу Foundry, например после перезагрузки Foundry)
    const channelState = {
        channel: null,                  // Данные канала из GET_CHANNEL (без списка участников)
        voiceStates: new Map(),         // discordUserId -> данные участника
        speaking: new Set(),            // discordUserId тех, кто сейчас говорит
    }


    // ─────────────────────────────────────────────
    // Отправка сообщений в Foundry
    // ─────────────────────────────────────────────
    function buildMessage(type, payload = {}) {
        return { source: SOURCE, protocol: PROTOCOL, version: SCRIPT_VERSION, type, ts: Date.now(), ...payload }
    }

    function postToFoundry(type, payload = {}) {
        if (!window.opener) return
        const msg = buildMessage(type, payload)
        // Адрес Foundry ещё неизвестен - копим (кроме «привета»: в нём только версия скрипта)
        if (!foundryOrigin) {
            if (type === "HELLO") window.opener.postMessage(msg, "*")
            else {
                buffer.push(msg)
                if (buffer.length > BUFFER_MAX) buffer.shift()
            }
            return
        }
        // Отправляем только по адресу Foundry. Если окно-открыватель ушло на другой сайт, браузер сообщение не доставит
        try { window.opener.postMessage(msg, foundryOrigin) } catch (e) {}
    }

    function flushBuffer() {
        while (buffer.length) {
            const msg = buffer.shift()
            try { window.opener.postMessage(msg, foundryOrigin) } catch (e) {}
        }
    }


    // ─────────────────────────────────────────────
    // Сообщения от Foundry
    // ─────────────────────────────────────────────
    function onMessageFromFoundry(event) {
        if (!window.opener || event.source !== window.opener) return
        const msg = event.data
        if (!msg || typeof msg !== "object" || msg.source !== FOUNDRY_SOURCE) return
        // После подключения принимаем сообщения только с того же адреса
        if (foundryOrigin && event.origin !== foundryOrigin && msg.type !== "CONNECT") return

        switch (msg.type) {
            // Foundry ответил на «привет» - запоминаем его адрес и отдаём накопленное
            case "CONNECT": {
                foundryOrigin = event.origin
                postToFoundry("CONNECTED")
                flushBuffer()
                break
            }
            // Проверка связи
            case "PING": {
                postToFoundry("PONG")
                break
            }
            // Запрос снимка текущего состояния канала
            case "SNAPSHOT_REQUEST": {
                postToFoundry("SNAPSHOT", {
                    data: {
                        channel: channelState.channel,
                        voice_states: Array.from(channelState.voiceStates.values()),
                        speaking: Array.from(channelState.speaking),
                    },
                })
                break
            }
            // Ретранслятор выключен - закрываем окно
            case "DISCONNECT": {
                foundryOrigin = null
                buffer.length = 0
                window.close()
                break
            }
        }
    }
    window.addEventListener("message", onMessageFromFoundry)


    // ─────────────────────────────────────────────
    // Перехват событий StreamKit из консоли
    // ─────────────────────────────────────────────
    function extractEvt(args) {
        for (const a of args) {
            if (!a || typeof a !== 'object') continue

            if (typeof a.evt === 'string' && a.data && typeof a.data === 'object') {
                return { evt: a.evt, data: a.data, cmd: a.cmd }
            }

            if (a.data && typeof a.data === 'object' && typeof a.data.evt === 'string') {
                return { evt: a.data.evt, data: a.data, cmd: a.cmd }
            }

            if (a.data && typeof a.data === 'object' && typeof a.cmd === 'string') {
                return { evt: null, data: a.data, cmd: a.cmd }
            }
        }
        return null
    }

    function getUserIdFromVoiceState(data) {
        return data?.user?.id ?? data?.user_id ?? data?.userId ?? null
    }

    // Обновление состояния канала (для снимка)
    function updateChannelState(cmd, evt, data) {
        if (cmd === "GET_CHANNEL") {
            const { voice_states, voiceStates, ...channel } = data
            channelState.channel = channel
            channelState.voiceStates.clear()
            channelState.speaking.clear()
            for (const voiceState of (voice_states ?? voiceStates ?? [])) {
                const userId = getUserIdFromVoiceState(voiceState)
                if (userId) channelState.voiceStates.set(userId, voiceState)
            }
            return
        }
        if (evt === "VOICE_STATE_CREATE" || evt === "VOICE_STATE_UPDATE") {
            const userId = getUserIdFromVoiceState(data)
            if (userId) channelState.voiceStates.set(userId, data)
            return
        }
        if (evt === "VOICE_STATE_DELETE") {
            const userId = getUserIdFromVoiceState(data)
            if (userId) {
                channelState.voiceStates.delete(userId)
                channelState.speaking.delete(userId)
            }
            return
        }
        if (evt === "SPEAKING_START" && data?.user_id) channelState.speaking.add(data.user_id)
        if (evt === "SPEAKING_STOP" && data?.user_id) channelState.speaking.delete(data.user_id)
    }

    const RELAYED_EVTS = new Set(["VOICE_STATE_CREATE", "VOICE_STATE_DELETE", "VOICE_STATE_UPDATE", "SPEAKING_START", "SPEAKING_STOP"])

    function handleConsole(method, args) {
        orig[method](...args)
        if (!window.opener) return

        const extracted = extractEvt(args)
        if (!extracted) return
        const { cmd, evt, data } = extracted
        // Пересылаем данные канала, события участников и ошибки Discord (например, «канал не найден»)
        if (cmd !== "GET_CHANNEL" && !RELAYED_EVTS.has(evt) && evt !== "ERROR") return

        // Данные пересылаем как есть: разбором занимается модуль (так исправления не требуют обновлять скрипт)
        try { updateChannelState(cmd, evt, data) } catch (e) {}
        postToFoundry("EVENT", { cmd: cmd ?? null, evt: evt ?? null, data })
    }

    window.console.log = (...args) => handleConsole('log', args)
    window.console.info = (...args) => handleConsole('info', args)
    window.console.debug = (...args) => handleConsole('debug', args)


    // ─────────────────────────────────────────────
    // Связь StreamKit с приложением Discord
    // ─────────────────────────────────────────────
    // StreamKit подключается к приложению Discord через WebSocket на 127.0.0.1 (перебирает порты 6463-6472).
    // Следим за этими подключениями, чтобы сообщить Foundry, запущено ли приложение Discord
    // - connected: подключились
    // - disconnected: связь была, но оборвалась (например, Discord закрыли)
    // - unreachable: не удалось подключиться ни к одному порту
    const DISCORD_RPC_REGEX = /^wss?:\/\/127\.0\.0\.1:64\d\d\//
    const UNREACHABLE_AFTER_FAILS = 10
    let discordFails = 0
    let discordState = null

    function setDiscordState(state) {
        if (state === discordState) return
        discordState = state
        postToFoundry("DISCORD_STATE", { state })
    }

    const OrigWebSocket = window.WebSocket
    window.WebSocket = new Proxy(OrigWebSocket, {
        construct(target, args) {
            const ws = Reflect.construct(target, args)
            try {
                if (DISCORD_RPC_REGEX.test(String(args[0]))) {
                    let opened = false
                    ws.addEventListener("open", () => {
                        opened = true
                        discordFails = 0
                        setDiscordState("connected")
                    })
                    ws.addEventListener("close", () => {
                        if (opened) return setDiscordState("disconnected")
                        if (++discordFails >= UNREACHABLE_AFTER_FAILS) setDiscordState("unreachable")
                    })
                }
            } catch (e) {}
            return ws
        }
    })


    // ─────────────────────────────────────────────
    // «Привет» и напоминания
    // ─────────────────────────────────────────────
    // Повторяем «привет», пока Foundry не ответит
    let helloTries = 0
    const helloIntervalId = setInterval(() => {
        if (foundryOrigin || ++helloTries > HELLO_MAX_TRIES) return clearInterval(helloIntervalId)
        postToFoundry("HELLO")
    }, HELLO_INTERVAL_MS)
    postToFoundry("HELLO")

    // Напоминаем о себе. Если Foundry перезагрузили, новая страница узнает по этому сообщению, что окно StreamKit уже открыто
    setInterval(() => {
        if (foundryOrigin) postToFoundry("ALIVE")
    }, ALIVE_INTERVAL_MS)

    orig.log("[discord-relay] StreamKit script loaded, version", SCRIPT_VERSION)
})()
