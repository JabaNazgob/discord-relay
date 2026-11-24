// ==================================================
// —————————————{ ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ }————————————
// ==================================================
const ID = "discord-relay"
export const Constants = {
    ID,
    MODULE_PATH: `modules/${ID}`,
    // Версия публичного API (game.modules.get("discord-relay").api.version)
    API_VERSION: "1.0",
    // Иконки вкладок окна модуля
    TAB_ICONS: {
        discordMenu: {relay: "fas fa-tower-broadcast", macros: "fas fa-code", settings: "fas fa-gear", guide: "fas fa-book"},
    },

    // Скрипт TamperMonkey
    // - VERSION: актуальная версия скрипта (лежит в папке модуля)
    // - MIN_VERSION: минимальная версия, с которой модуль ещё может работать. Если у игрока скрипт старее - ретранслятор не запустится
    // - PROTOCOL: версия формата сообщений между скриптом и модулем
    SCRIPT: {
        VERSION: "1.1.0",
        MIN_VERSION: "1.0.0",
        PROTOCOL: 1,
        FILE: "discord-relay.user.js",
        SOURCE: "discord-relay-tm",     // Метка сообщений от скрипта
    },
    // Сайт TamperMonkey
    TAMPERMONKEY_URL: "https://www.tampermonkey.net/",
    // Метка сообщений от модуля (для скрипта)
    MESSAGE_SOURCE: ID,

    // StreamKit
    STREAMKIT_ORIGIN: "https://streamkit.discord.com",
    OVERLAY_WINDOW_NAME: "dvar_streamkit_overlay",
    OVERLAY_POPUP_FEATURES: "popup,width=420,height=900",
    // Ссылка на голосовой канал: ID сервера и ID канала (17-20 цифр каждый)
    VOICE_URL_REGEX: /(\d{17,20})\/(\d{17,20})/,

    // Статусы игроков как ретрансляторов (видят все)
    // - OFFLINE: ретранслятор не запущен (или игрока нет в игре)
    // - STARTING: ретранслятор запущен, но ещё не работает (подключается или есть проблема - подробности в подсказке)
    // - READY: работает, запасной (активен другой ретранслятор)
    // - ONLINE: работает и является активным ретранслятором
    // - STALE: сигнал от ретранслятора потерян
    RELAY_STATUS_ICONS: {
        OFFLINE: "fas fa-power-off",
        STARTING: "fas fa-hourglass-half",
        READY: "fas fa-play-circle",
        ONLINE: "fas fa-tower-broadcast",
        STALE: "fas fa-triangle-exclamation",
    },

    // Журнал действий: сколько записей хранить
    LOG_MAX: 50,
    // Иконки записей журнала без аватара (события ретрансляторов и канала)
    LOG_ICONS: {
        channelLoaded: "fas fa-volume-high",
        channelCleared: "fas fa-volume-xmark",
        relayStarted: "fas fa-play",
        relayStopped: "fas fa-stop",
        relayChanged: "fas fa-tower-broadcast",
    },

    // Тайминги
    TICK_MS: 1000,                  // Как часто ретранслятор проверяет своё состояние
    HB_INTERVAL_MS: 3000,           // Как часто ретранслятор сообщает остальным «я жив»
    READY_TTL_MS: 10000,            // Через сколько миллисекунд без «я жив» считать, что сигнал от ретранслятора потерян
    SYNC_MS: 2000,                  // Сколько после входа в мир собирать статусы молча (без вызова крюков «запустился» и т.п.)
    LOAD_REASON_TTL_MS: 10000,      // Сколько помнить причину загрузки канала, если ретранслятор ещё не стал основным
    SPEAKING_MIN_MS_DEFAULT: 400,   // Минимальная длительность речи по умолчанию (настройка speakingEventDebounceMs)
    SPEAKING_STOP_DELAY_MS_DEFAULT: 0,  // Задержка «перестал говорить» по умолчанию (настройка speakingStopDelayMs)
    SPEAKING_FILTER_TICK_MS: 25,    // Как часто проверять фильтры речи (минимальная длительность, задержка «перестал говорить»)
    RULE_PROBLEM_COOLDOWN_MS: 60000,    // Как часто можно сообщать об одной и той же проблеме правила «макрос по событию»
    PROFILES_SAVE_DEBOUNCE_MS: 2000,    // Задержка сохранения профилей и данных канала в мир (ГМ)
    PING_INTERVAL_MS: 2000,         // Как часто ретранслятор пингует окно StreamKit
    OVERLAY_TTL_MS: 10000,          // Через сколько миллисекунд без ответа считать, что окно StreamKit не отвечает
    HELLO_TIMEOUT_MS: 10000,        // Сколько ждать «привета» от скрипта после открытия окна
    DISCORD_TIMEOUT_MS: 10000,      // Сколько ждать данных канала от Discord после «привета»
}
const C = Constants

// Крюки
// - Принцип как у Foundry: появился/исчез - два крюка (как create/delete), переключилось свойство - один крюк с флагом (как targetToken)
// - Устаревшие крюки старой версии - в scripts/legacy.js
export const HOOKS = {
    // Участники голосового канала
    MEMBER_JOINED: `${C.ID}.memberJoined`,
    MEMBER_LEFT: `${C.ID}.memberLeft`,
    MEMBER_UPDATED: `${C.ID}.memberUpdated`,
    MEMBER_MUTE_CHANGED: `${C.ID}.memberMuteChanged`,
    MEMBER_DEAF_CHANGED: `${C.ID}.memberDeafChanged`,
    MEMBER_SPEAKING_CHANGED: `${C.ID}.memberSpeakingChanged`,

    // Голосовой канал
    CHANNEL_LOADED: `${C.ID}.channelLoaded`,
    CHANNEL_CLEARED: `${C.ID}.channelCleared`,

    // Ретрансляторы
    ACTIVE_RELAY_CHANGED: `${C.ID}.activeRelayChanged`,
    RELAY_STATUS_CHANGED: `${C.ID}.relayStatusChanged`,
}
