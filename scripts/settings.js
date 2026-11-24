import { DiscordMenuLauncher, refreshDiscordLinks, refreshDiscordMenu, refreshMacroRules, refreshSettingsTab } from "../apps/discordMenu.js"
import { Constants as C } from "../data/const.js"
import { modLoc } from "../data/functions.js"
import { relay } from "./relay.js"
import { relayNetwork } from "./relayNetwork.js"
import { userLinks } from "./userLinks.js"


Hooks.once("init", () => {
    // Быстрая регистрация настройки
    // - Видимые настройки продублированы во вкладке «Настройки» окна модуля, поэтому при их изменении она перерисовывается
    const registerSetting = (config = false, settingKey, _scope = "client", _type = Boolean, _default = true, add = {}) => {
        const {requiresReload = false, range} = add
        const onChange = config ? (value) => {
            add.onChange?.(value)
            refreshSettingsTab()
        } : add.onChange
        game.settings.register(C.ID, settingKey, {
            // Название и подсказка нужны только видимым настройкам
            ...(config ? {name: modLoc(`settings.${settingKey}`), hint: modLoc(`settings.${settingKey}Hint`)} : {}),
            ...{
                scope: _scope,
                config,
                type: _type,
                default: _default,
                requiresReload,
            },
            ...(onChange ? {onChange: onChange} : {}),
            ...(range ? {range: range} : {}),
        })
    }
    // Быстрая регистрация меню
    const registerMenu = (menuKey, icon, type) => {
        game.settings.registerMenu(C.ID, menuKey, {
            name: modLoc(`settings.${menuKey}`),
            label: modLoc(`settings.${menuKey}Label`),
            icon: icon,
            type: type,
            restricted: false, // Меню есть только одно - открытие окна модуля, и его должны видеть все пользователи
        })
    }



    // ==================================================
    // —————————————————————— МЕНЮ ——————————————————————
    // ==================================================
    // Окно DiscordMenu
    registerMenu("discordMenuOpen", "fa-brands fa-discord", DiscordMenuLauncher)


    // ==================================================
    // ———————————————— ВИДИМЫЕ НАСТРОЙКИ ———————————————
    // ==================================================

    // ——————————————————{ ГЛОБАЛЬНЫЕ }——————————————————
    // Включить/выключить модуль (ключ из старой версии, где модуль в настройках назывался DiscordBridge)
    registerSetting(true, "discordBridgeIsActive", "world", Boolean, true, {requiresReload: true})
    // Минимальная длительность речи (мс): более короткие «начал/перестал говорить» считаются шумом и не передаются
    // - Ключ из старой версии (там настройка была скрытой и не использовалась), поэтому миграция не нужна
    registerSetting(true, "speakingEventDebounceMs", "world", Number, C.SPEAKING_MIN_MS_DEFAULT, {range: {min: 0, max: 2000, step: 50}})
    // Задержка «перестал говорить» (мс): если за это время человек снова заговорил, это одна фраза, а не две
    registerSetting(true, "speakingStopDelayMs", "world", Number, C.SPEAKING_STOP_DELAY_MS_DEFAULT, {range: {min: 0, max: 2000, step: 50}})
    // Разрешить игрокам создавать свои правила «макрос по событию» (выполняются только у самого игрока)
    registerSetting(true, "allowPlayerRules", "world", Boolean, true, {onChange: () => refreshMacroRules()})


    // ——————————————————{ КЛИЕНТСКИЕ }——————————————————
    // Открытие окна overlay (StreamKit) в отдельном окне
    registerSetting(true, "overlayPopup", "client", Boolean, true)
    // Записывать в журнал события речи (галочка в журнале окна модуля)
    registerSetting(false, "logSpeaking", "client", Boolean, false)


    // ==================================================
    // ———————————————— СКРЫТЫЕ НАСТРОЙКИ ———————————————
    // ==================================================
    // Примечание: ключи совпадают со старой версией, поэтому сохранённые значения подхватываются без миграции
    // - discordVoiceChatUserIds и browserConfirmation из старой версии больше не используются и не регистрируются

    // ——————————————————{ ГЛОБАЛЬНЫЕ }——————————————————
    // Кэш профилей пользователей Discord (discordUserId -> профиль)
    // - Появились новые профили - возможно, есть кого привязать вместо ника в ожидании
    registerSetting(false, "discordUserProfiles", "world", Object, {}, {onChange: () => {
        refreshDiscordLinks()
        userLinks.resolvePending()
    }})
    // Карта ID пользователей Foundry <=> ID пользователей Discord
    registerSetting(false, "foundryDiscordIdsMap", "world", Object, {}, {onChange: () => refreshDiscordLinks()})
    // Правила мира «макрос по событию»
    registerSetting(false, "macroRules", "world", Array, [], {onChange: () => refreshMacroRules()})
    // Ретранслятор, назначенный ГМом активным (ID пользователя или пустая строка - выбирать автоматически)
    registerSetting(false, "preferredRelayUserId", "world", String, "", {onChange: () => relayNetwork.refresh()})
    // Данные голосового канала
    // - При смене канала ретранслятор (если включён) переоткрывает StreamKit на новом канале
    registerSetting(false, "discordVoiceChatData", "world", Object, {}, {onChange: () => {
        relay.onChannelChanged()
        refreshDiscordMenu()
    }})
})

// Правила игрока хранятся в его данных пользователя, права на макросы - в самих макросах
Hooks.on("updateUser", (user, changes) => {
    if (user.isSelf && foundry.utils.hasProperty(changes, `flags.${C.ID}`)) refreshMacroRules()
})
Hooks.on("updateMacro", () => refreshMacroRules())
Hooks.on("deleteMacro", () => refreshMacroRules())
