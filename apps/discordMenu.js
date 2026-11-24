import { Constants as C } from "../data/const.js"
import { copyTextToClipboard, getSettings, getWorldJoinUrl, modFormat, modLoc, parseVoiceUrl } from "../data/functions.js"
import { relay, RELAY_STATUS as S } from "../scripts/relay.js"
import { relayNetwork, USER_STATUS as U } from "../scripts/relayNetwork.js"
import { voiceChannel } from "../scripts/voiceChannel.js"
import { isDiscordId, userLinks } from "../scripts/userLinks.js"
import { eventLog } from "../scripts/eventLog.js"
import { macroRules, RULE_EVENTS, RULE_EVENTS_WITHOUT_MEMBER, RULE_TARGETS } from "../scripts/macroRules.js"
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api

// Открытое окно модуля (окно может быть только одно)
let menuInstance = null
// Текст скрипта TamperMonkey (загружается один раз)
let guideScriptCache
let guideScriptPromise = null

// Сколько подсказок показывать в выпадающем списке
const SUGGEST_MAX = 10
// Тип данных при перетаскивании участника голосового канала (браузер хранит типы в нижнем регистре)
const DRAG_TYPE = "application/x-discord-relay-member"

// К какой вкладке относится каждая часть окна
const PART_TABS = {relayStatus: "relay", relay: "relay", relayUsers: "relay", voiceChannel: "relay", eventLog: "relay", macros: "macros", settings: "settings", guide: "guide"}
// Сколько миллисекунд запись журнала считается новой (подсвечивается)
const LOG_NEW_MS = 1500

export class DiscordMenu extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        classes: ["discord-relay-app"],
        id: "discord-relay-menu",
        position: {
            width: 1000,
            height: "auto",
        },
        window: {
            icon: "fa-brands fa-discord",
            resizable: true,
        },
        actions: {
            // ДЕЙСТВИЯ ВКЛАДКИ РЕТРАНСЛЯТОРА
            toggleRelay: DiscordMenu._toggleRelay,
            copyWorldLink: DiscordMenu._copyWorldLink,
            openGuide: DiscordMenu._openGuide,
            setPreferredRelay: DiscordMenu._setPreferredRelay,
            unlinkDiscord: DiscordMenu._unlinkDiscord,
            clearLog: DiscordMenu._clearLog,
            // ДЕЙСТВИЯ ВКЛАДКИ МАКРОСОВ
            addRule: DiscordMenu._addRule,
            removeRule: DiscordMenu._removeRule,
            testRule: DiscordMenu._testRule,
            clearRuleMacro: DiscordMenu._clearRuleMacro,
            openRuleMacro: DiscordMenu._openRuleMacro,
            // ДЕЙСТВИЯ ВКЛАДКИ РУКОВОДСТВА
            copyScript: DiscordMenu._copyScript,
            installScript: DiscordMenu._installScript,
            openTamperMonkeySite: DiscordMenu._openTamperMonkeySite,
        },
    }

    static PARTS = {
        tabs: {template: `${C.MODULE_PATH}/templates/partials/tab-navigation.hbs`},
        relayStatus: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/relay-status.hbs`},
        relay: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/relay.hbs`},
        relayUsers: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/relay-users.hbs`},
        voiceChannel: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/voice-channel.hbs`},
        eventLog: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/event-log.hbs`},
        macros: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/macros.hbs`, scrollable: [""]},
        settings: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/settings.hbs`, scrollable: [""]},
        guide: {template: `${C.MODULE_PATH}/templates/apps/discordMenu/guide.hbs`, scrollable: [""]},
    }

    // Вкладки
    // - Используем встроенную систему вкладок ApplicationV2 (Foundry v13+)
    static TABS = {
        primary: {
            tabs: [
                {id: "relay", icon: C.TAB_ICONS.discordMenu.relay, label: `${C.ID}.discordMenu.tabs.relay`},
                {id: "macros", icon: C.TAB_ICONS.discordMenu.macros, label: `${C.ID}.discordMenu.tabs.macros`},
                {id: "settings", icon: C.TAB_ICONS.discordMenu.settings, label: `${C.ID}.discordMenu.tabs.settings`},
                {id: "guide", icon: C.TAB_ICONS.discordMenu.guide, label: `${C.ID}.discordMenu.tabs.guide`},
            ],
            initial: "relay",
        },
    }

    constructor(options = {}) {
        super(options)
        const {currentTab} = options
        // Если при открытии указана вкладка - открываем сразу её
        if (currentTab && DiscordMenu.TABS.primary.tabs.some(tab => tab.id === currentTab)) this.tabGroups.primary = currentTab
        // Отписка от изменений ретранслятора
        this._unsubscribeRelay = null
        // Перерисовка статуса не чаще раза в 200 мс (события от Discord могут идти очень часто)
        this._renderStatusDebounced = foundry.utils.debounce(() => this.render({parts: ["relayStatus"]}), 200)
        // Отписка от изменений статусов ретрансляторов всех игроков
        this._unsubscribeNetwork = null
        this._renderUsersDebounced = foundry.utils.debounce(() => this.renderUsersPart(["relayStatus", "voiceChannel"]), 200)
        // Таблицу пользователей нужно перерисовать, как только из неё уйдёт фокус (см. renderUsersPart)
        this._usersRenderPending = false
        // Отписка от журнала
        this._unsubscribeLog = null
        this._renderLogDebounced = foundry.utils.debounce(() => this.render({parts: ["eventLog"]}), 100)
        // Отписка от изменений голосового канала
        this._unsubscribeVoice = []
        // Подписки оформляются при первой отрисовке и снимаются при закрытии (см. _onFirstRender / _onClose)
    }

    // Заголовок окна
    // - Локализуем при каждом обращении, т.к. на момент загрузки файла переводы ещё не готовы
    get title() {
        return modLoc("discordMenu.windowTitle")
    }


    // ==================================================
    // ———————————— ОБЩИЙ КОНТЕКСТ ПРИЛОЖЕНИЯ ———————————
    // ==================================================
    async _prepareContext(options) {
        const context = await super._prepareContext(options)
        context.tabs = this._prepareTabs("primary")
        return context
    }


    // ==================================================
    // ——————————— КОНТЕКСТ ЧАСТЕЙ ПРИЛОЖЕНИЯ ———————————
    // ==================================================
    async _preparePartContext(partId, context, options) {
        const partContext = await super._preparePartContext(partId, context, options)
        // Каждой части передаём данные её вкладки (активна ли она и т.д.)
        if (PART_TABS[partId]) partContext.tab = partContext.tabs[PART_TABS[partId]]

        switch (partId) {
            // —————————————— СОСТОЯНИЕ РЕТРАНСЛЯТОРА ———————————————
            case "relayStatus": {
                partContext.relayStatus = getRelayStatusContext()
                break
            }
            // ——————————————— РЕТРАНСЛЯТОРЫ ИГРОКОВ ————————————————
            case "relayUsers": {
                partContext.relayUsers = getRelayUsersContext()
                break
            }
            // ——————————————————— МАКРОСЫ ————————————————————
            case "macros": {
                partContext.macros = getMacrosContext()
                break
            }
            // ——————————————————— НАСТРОЙКИ ———————————————————
            case "settings": {
                partContext.settings = getSettingsContext()
                break
            }
            // ———————————————————— ЖУРНАЛ ————————————————————
            case "eventLog": {
                partContext.eventLog = getEventLogContext()
                break
            }
            // ——————————————— ГОЛОСОВОЙ КАНАЛ ————————————————
            case "voiceChannel": {
                partContext.voiceChannel = getVoiceChannelContext()
                break
            }
            // —————————————————— РЕТРАНСЛЯТОР —————————————————
            case "relay": {
                const voiceChatData = getSettings("discordVoiceChatData") ?? {}
                partContext.voiceChat = {
                    fullId: voiceChatData._fullId ?? "",
                    isValid: !!parseVoiceUrl(voiceChatData._fullId),
                    canEdit: game.user.isGM,
                    readOnly: !game.user.isGM,
                }
                break
            }
            // —————————————————— РУКОВОДСТВО ——————————————————
            case "guide": {
                partContext.guide = {
                    script: await getGuideScript(),
                    scriptVersion: C.SCRIPT.VERSION,
                }
                break
            }
        }
        return partContext
    }


    // Перерисовка таблицы пользователей
    // - Если в поле привязки набран и ещё не сохранён текст - таблицу не перерисовываем (иначе текст пропадёт),
    //   а перерисовываем, когда фокус из неё уйдёт
    // - Если поле просто выбрано (ничего не набрано) - перерисовываем сразу и возвращаем фокус в то же поле
    // - extraParts: другие части, которые нужно перерисовать вместе с ней
    renderUsersPart(extraParts = []) {
        if (!this.rendered) return
        const part = this.element.querySelector(".dsr-relay-users-part")
        const active = document.activeElement
        const focusedInput = part?.contains(active) && active.matches("input.dsr-discord-input") ? active : null
        if (focusedInput && focusedInput.value !== focusedInput.defaultValue) {
            this._usersRenderPending = true
            if (extraParts.length) this.render({parts: extraParts})
            return
        }
        this._usersRenderPending = false
        const focusedUserId = focusedInput?.dataset.foundryUserId
        this.render({parts: ["relayUsers", ...extraParts]}).then(() => {
            if (!focusedUserId) return
            this.element?.querySelector(`input.dsr-discord-input[data-foundry-user-id="${focusedUserId}"]`)?.focus()
        })
    }


    // ==================================================
    // —————————————————————— ВКЛАДКИ ———————————————————
    // ==================================================
    // Переключение вкладки
    // - Вкладка «Ретранслятор» состоит из нескольких частей окна, поэтому переключаем видимость всех её частей
    changeTab(tab, group, options = {}) {
        super.changeTab(tab, group, options)
        this.element?.querySelectorAll(`.tab[data-group="${group}"]`).forEach(section => {
            section.classList.toggle("active", section.dataset.tab === tab)
        })
    }


    // ==================================================
    // ——————————————— ОТКРЫТИЕ / ЗАКРЫТИЕ ——————————————
    // ==================================================
    async _onFirstRender(context, options) {
        await super._onFirstRender(context, options)
        menuInstance = this
        // Аватар не загрузился (человек сменил аватар, а в кэше профилей старая ссылка) - показываем стандартный
        // - Событие error не всплывает, поэтому ловим его на погружении - так оно сработает для всех картинок окна
        this.element.addEventListener("error", onAvatarError, true)
        // Перерисовываем статус при изменениях ретранслятора
        this._unsubscribeRelay = relay.subscribe(() => this._renderStatusDebounced())
        this._unsubscribeNetwork = relayNetwork.subscribe(() => this._renderUsersDebounced())
        this._unsubscribeLog = eventLog.subscribe(() => this._renderLogDebounced())
        this._unsubscribeVoice = [
            // Состав канала влияет и на таблицу пользователей (профили для привязки)
            voiceChannel.subscribe(() => this._renderUsersDebounced()),
            // «Кто говорит» меняется очень часто - не перерисовываем список, а только переключаем подсветку
            voiceChannel.subscribeSpeaking((discordUserId, isSpeaking) => {
                this.element?.querySelector(`.dsr-voice-channel__member[data-discord-user-id="${discordUserId}"]`)?.classList.toggle("dsr-speaking", isSpeaking)
            }),
        ]
    }

    _onClose(options) {
        super._onClose(options)
        this._unsubscribeRelay?.()
        this._unsubscribeRelay = null
        this._unsubscribeNetwork?.()
        this._unsubscribeNetwork = null
        this._unsubscribeLog?.()
        this._unsubscribeLog = null
        this._unsubscribeVoice.forEach(fn => fn())
        this._unsubscribeVoice = []
        if (menuInstance === this) menuInstance = null
    }


    // ==================================================
    // ———————————————————— ON-RENDER ———————————————————
    // ==================================================
    async _onRender(context, options) {
        await super._onRender(context, options)
        if (options.parts?.includes("relay")) activateVoiceUrlInput(this.element)
        if (options.parts?.includes("relayUsers")) activateDiscordLinks(this)
        if (options.parts?.includes("voiceChannel")) activateMemberDrag(this.element)
        if (options.parts?.includes("macros")) activateMacroRules(this.element)
        if (options.parts?.includes("settings")) activateSettings(this.element)
        if (options.parts?.includes("eventLog")) {
            // Галочка «Речь» в журнале
            this.element.querySelector("input[name='logSpeaking']")?.addEventListener("change", (event) => {
                game.settings.set(C.ID, "logSpeaking", event.target.checked)
            })
        }
    }


    // ==================================================
    // ———————————————————— ДЕЙСТВИЯ ————————————————————
    // ==================================================
    // —————————————————— РЕТРАНСЛЯТОР —————————————————
    // Включение/выключение ретранслятора
    static _toggleRelay(event, target) {
        relay.toggle()
    }
    // Копирование ссылки на мир (для открытия в браузере)
    static async _copyWorldLink(event, target) {
        const ok = await copyTextToClipboard(getWorldJoinUrl())
        if (ok) ui.notifications.info(modLoc("notifications.worldLinkCopied"))
        else ui.notifications.warn(modFormat("notifications.worldLinkCopyError", {url: getWorldJoinUrl()}))
    }
    // Переход на вкладку руководства
    static _openGuide(event, target) {
        this.changeTab("guide", "primary", {force: true})
    }
    // Назначение активного ретранслятора (только ГМ)
    // - Повторный клик по уже назначенному снимает назначение (снова выбирается автоматически)
    static async _setPreferredRelay(event, target) {
        if (!game.user.isGM) return
        const userId = target.dataset.userId
        const current = getSettings("preferredRelayUserId", false)
        await game.settings.set(C.ID, "preferredRelayUserId", current === userId ? "" : userId)
    }
    // ——————————————————— МАКРОСЫ ————————————————————
    // Добавить правило
    static async _addRule(event, target) {
        await macroRules.add(target.dataset.scope === "world")
    }
    // Удалить правило
    static async _removeRule(event, target) {
        const ruleEl = target.closest(".dsr-rule")
        await macroRules.remove(ruleEl.dataset.scope === "world", ruleEl.dataset.ruleId)
    }
    // Проверочный запуск макроса правила (тестовые данные, только у себя)
    static async _testRule(event, target) {
        const ruleEl = target.closest(".dsr-rule")
        await macroRules.test(ruleEl.dataset.scope === "world", ruleEl.dataset.ruleId)
    }
    // Убрать макрос из правила
    static async _clearRuleMacro(event, target) {
        const ruleEl = target.closest(".dsr-rule")
        await macroRules.update(ruleEl.dataset.scope === "world", ruleEl.dataset.ruleId, {macroUuid: null})
    }
    // Открыть макрос
    static _openRuleMacro(event, target) {
        macroRules.getMacro(target.dataset.uuid)?.sheet?.render(true)
    }
    // Очистка журнала
    static _clearLog(event, target) {
        eventLog.clear()
    }
    // Отвязка профиля Discord
    static async _unlinkDiscord(event, target) {
        await userLinks.set(target.dataset.foundryUserId, null)
    }
    // —————————————————— РУКОВОДСТВО ——————————————————
    // Сайт TamperMonkey (сам определяет браузер и ведёт в нужный магазин расширений)
    static _openTamperMonkeySite(event, target) {
        window.open(C.TAMPERMONKEY_URL, "_blank", "noopener")
    }
    // Установка скрипта
    // - Сайт не может узнать, установлен ли TamperMonkey. Без него по кнопке откроется просто текст скрипта,
    //   поэтому, пока скрипт ни разу не отвечал в этом браузере, сначала спрашиваем
    static async _installScript(event, target) {
        const scriptUrl = foundry.utils.getRoute(`${C.MODULE_PATH}/${C.SCRIPT.FILE}`)
        if (relay.isScriptVerified()) return window.open(scriptUrl, "_blank", "noopener")
        const choice = await foundry.applications.api.DialogV2.wait({
            window: {title: modLoc("discordMenu.guide.installDialog.title"), icon: "fas fa-download"},
            content: `<p>${modLoc("discordMenu.guide.installDialog.text")}</p>`,
            buttons: [
                {action: "install", label: modLoc("discordMenu.guide.installDialog.install"), icon: "fas fa-check", default: true},
                {action: "getTamperMonkey", label: modLoc("discordMenu.guide.installDialog.getTamperMonkey"), icon: "fas fa-puzzle-piece"},
            ],
            rejectClose: false,
        })
        if (choice === "install") window.open(scriptUrl, "_blank", "noopener")
        else if (choice === "getTamperMonkey") window.open(C.TAMPERMONKEY_URL, "_blank", "noopener")
    }
    // Копирование скрипта
    static async _copyScript(event, target) {
        const text = await getGuideScript()
        const ok = await copyTextToClipboard(text)
        if (!ok) return ui.notifications.warn(modLoc("discordMenu.guide.script.copyError"))
        // Ненадолго меняем надпись на кнопке
        const label = target.querySelector("span")
        if (!label) return
        label.textContent = modLoc("discordMenu.guide.script.copied")
        target.classList.add("dsr-copy--success")
        setTimeout(() => {
            label.textContent = modLoc("discordMenu.guide.script.copy")
            target.classList.remove("dsr-copy--success")
        }, 2000)
    }
}

/*
█████████████████████████████████████████████████████
█████████████████████████████████████████████████████
█████████████████████████████████████████████████████
*/

// ==================================================
// —————————————— СОСТОЯНИЕ РЕТРАНСЛЯТОРА ———————————
// ==================================================
// Уровень важности статуса (для цвета плашки)
const STATUS_LEVELS = {
    [S.IDLE]: "neutral",
    [S.ACTIVE]: "success",
    [S.CONNECTING]: "info",
    [S.WAITING_DISCORD]: "info",
    [S.NO_SCRIPT]: "warning",
    [S.DISCORD_SILENT]: "warning",
    [S.DISCORD_UNREACHABLE]: "warning",
}
// Подготовка данных для карточки состояния ретранслятора
function getRelayStatusContext() {
    const state = relay.state
    const isRunning = relay.isRunning()
    const status = state.status
    // Что мешает этому игроку включить ретранслятор (приложение, не указан канал и т.д.)
    const blocker = !isRunning ? relay.getStartBlocker() : null

    // Дополнительные предупреждения
    const warnings = []
    if (isRunning && state.overlayUnresponsive) warnings.push(modLoc("relayState.warnings.overlayUnresponsive"))
    if (isRunning && state.scriptOutdated) warnings.push(modFormat("relayState.warnings.scriptOutdated", {version: state.scriptVersion, latest: C.SCRIPT.VERSION}))
    if (isRunning && state.oldScriptAlongside) warnings.push(modLoc("relayState.warnings.oldScriptAlongside"))

    // Текст кнопки
    const buttonLabel = isRunning ? "headerRelayButtonDeactivate"
        : status === S.OVERLAY_CLOSED ? "headerRelayButtonReopen"
        : "headerRelayButtonActivate"

    // Заголовок и текст
    // - Игрок сам ничего не запускал: показываем общее состояние (работает ли ретранслятор у кого-то),
    //   а то, что мешает стать ретранслятором ему самому, - спокойной подсказкой, а не ошибкой
    let level = STATUS_LEVELS[status] ?? "error"
    let title = modLoc(`relayState.${status}.title`)
    let text = modFormat(`relayState.${status}.text`, {version: state.scriptVersion ?? "?", latest: C.SCRIPT.VERSION, minimum: C.SCRIPT.MIN_VERSION, error: state.channelError ?? "?"})
    if (status === S.IDLE) {
        const activeRelayName = game.users.get(relayNetwork.getActiveRelayUserId())?.name
        level = activeRelayName ? "success" : "neutral"
        title = activeRelayName ? modFormat("relayState.IDLE.titleActive", {name: activeRelayName}) : modLoc("relayState.IDLE.title")
        text = blocker ? modLoc(`relayState.hints.${blocker}`) : modLoc(activeRelayName ? "relayState.IDLE.textActive" : "relayState.IDLE.text")
    }

    return {
        status,
        level,
        title,
        text,
        warnings,
        isRunning,
        buttonLabel: modLoc(`discordMenu.${buttonLabel}`),
        buttonDisabled: !!blocker,
        // Кнопки-подсказки
        showCopyWorldLink: blocker === S.APP,
        showOpenGuide: status === S.NO_SCRIPT || status === S.OLD_SCRIPT,
        // Детали работы
        role: state.status === S.ACTIVE ? modLoc(`discordMenu.details.${relayNetwork.isActiveRelay() ? "rolePrimary" : "roleBackup"}`) : null,
        scriptVersion: isRunning ? state.scriptVersion : null,
        channel: isRunning && state.channel ? {
            name: state.channel.name || modLoc("general.unknownVoiceChat"),
            userCount: state.channel.userCount,
        } : null,
        lastEvent: isRunning && state.lastEvent ? {
            evt: state.lastEvent.evt,
            time: new Date(state.lastEvent.ts).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}),
        } : null,
    }
}


// ==================================================
// —————————————— РЕТРАНСЛЯТОРЫ ИГРОКОВ —————————————
// ==================================================
// Подготовка данных для таблицы ретрансляторов
// - Показываем всех пользователей мира: сначала те, кто в игре
function getRelayUsersContext() {
    const activeRelayUserId = relayNetwork.getActiveRelayUserId()
    const preferred = getSettings("preferredRelayUserId", false)
    const isGM = game.user.isGM
    const rows = game.users.contents
        .map(user => {
            const userStatus = relayNetwork.getUserStatus(user.id)
            const status = userStatus.status
            // Подсказка: статус + что происходит у ретранслятора (если он ещё не работает или есть проблема)
            let tooltip = modLoc(`relayStatusHint.${status}`)
            if (userStatus.localStatus && status !== U.READY && status !== U.ONLINE) {
                tooltip += ` (${modLoc(`relayState.${userStatus.localStatus}.title`)})`
            }
            return {
                id: user.id,
                name: user.name,
                color: user.color?.css ?? "transparent",
                online: user.active,
                status,
                statusIcon: C.RELAY_STATUS_ICONS[status],
                tooltip: `${modLoc(`relayStatus.${status}`)}: ${tooltip}`,
                isPreferred: user.id === preferred,
                // Назначить можно того, у кого ретранслятор запущен; снять назначение - всегда
                canAssign: isGM && (userStatus.active || user.id === preferred),
                link: getLinkContext(user.id),
            }
        })
        .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name))
    return {
        activeRelayName: game.users.get(activeRelayUserId)?.name ?? null,
        rows,
        canEditAny: rows.some(row => row.link.canEdit),
    }
}
// Связь пользователя Foundry с Discord
// - profile: привязан ID и профиль известен
// - value: ник или ID, для которого профиль ещё не известен (ожидание)
function getLinkContext(foundryUserId) {
    const value = userLinks.get(foundryUserId)
    const profile = isDiscordId(value) ? userLinks.getProfile(value) : null
    return {
        canEdit: userLinks.canEdit(foundryUserId),
        value: profile ? null : value,
        profile: profile ? {...profile, label: profile.nick || profile.username || profile.userId} : null,
    }
}


// ==================================================
// —————————————— ПРИВЯЗКА ПРОФИЛЕЙ DISCORD —————————
// ==================================================
// Поля ввода с подсказками и приём перетаскиваемых участников
function activateDiscordLinks(app) {
    const element = app.element
    const part = element.querySelector(".dsr-relay-users-part")
    if (!part) return
    // Фокус ушёл из таблицы - выполняем отложенную перерисовку
    part.addEventListener("focusout", () => setTimeout(() => {
        if (app._usersRenderPending && !part.contains(document.activeElement)) app.renderUsersPart()
    }, 0))

    for (const input of part.querySelectorAll("input.dsr-discord-input")) activateLinkInput(app, input)

    // Перетаскивание участника голосового канала на ячейку «Discord»
    for (const cell of part.querySelectorAll(".dsr-drop-target")) {
        cell.addEventListener("dragover", (event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
            event.preventDefault()
            cell.classList.add("dsr-drag-over")
        })
        cell.addEventListener("dragleave", () => cell.classList.remove("dsr-drag-over"))
        cell.addEventListener("drop", async (event) => {
            cell.classList.remove("dsr-drag-over")
            const discordUserId = event.dataTransfer.getData(DRAG_TYPE)
            if (!isDiscordId(discordUserId)) return
            event.preventDefault()
            await userLinks.set(cell.dataset.foundryUserId, discordUserId)
        })
    }
}

// Поле ввода: ID или ник, подсказки по известным профилям
// - Enter или уход из поля - сохраняем введённое (ник будет ждать появления профиля)
// - Клик по подсказке - сразу привязываем профиль
function activateLinkInput(app, input) {
    const foundryUserId = input.dataset.foundryUserId
    const list = input.parentElement.querySelector(".dsr-discord-suggest")
    const initial = input.value
    let saved = false

    const save = async (value) => {
        hide()
        if (saved || String(value ?? "").trim() === initial) return
        saved = true
        // Ввод закончен - отпускаем фокус, чтобы таблица сразу показала результат
        input.blur()
        await userLinks.set(foundryUserId, value)
    }
    const hide = () => {
        list.classList.remove("dsr-open", "dsr-up")
        list.replaceChildren()
    }
    const show = () => {
        const query = input.value.trim().toLowerCase()
        const profiles = userLinks.getKnownProfiles()
            .filter(p => !query || [p.userId, p.nick, p.username].some(field => field && String(field).toLowerCase().includes(query)))
            .sort((a, b) => String(a.nick ?? a.username ?? "").localeCompare(String(b.nick ?? b.username ?? "")))
            .slice(0, SUGGEST_MAX)
        list.replaceChildren(...profiles.map(profile => buildSuggestItem(profile, () => save(profile.userId))))
        if (!profiles.length) return hide()
        list.style.backgroundColor = getOpaqueBackground(input)
        list.classList.add("dsr-open")
        // Если снизу в окне не хватает места - открываем список вверх
        const content = app.element.querySelector(".window-content")?.getBoundingClientRect()
        const inputRect = input.getBoundingClientRect()
        list.classList.toggle("dsr-up", !!content && inputRect.bottom + list.offsetHeight > content.bottom && inputRect.top - list.offsetHeight > content.top)
    }

    input.addEventListener("focus", show)
    input.addEventListener("input", show)
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault()
            save(input.value)
        } else if (event.key === "Escape") {
            event.stopPropagation()
            input.value = initial
            hide()
            input.blur()
        }
    })
    input.addEventListener("blur", () => {
        // Клик по подсказке не должен считаться уходом из поля (см. mousedown в buildSuggestItem)
        hide()
        if (input.value !== initial) save(input.value)
    })
}

// Непрозрачный цвет фона: первый предок с непрозрачным фоном (окно модуля в текущей теме)
function getOpaqueBackground(element) {
    for (let el = element; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor
        const alpha = color.match(/rgba?\(([^)]+)\)/)?.[1].split(",")[3]
        if (color && color !== "transparent" && (alpha === undefined || Number(alpha) >= 0.9)) return color
    }
    return document.body.classList.contains("theme-light") ? "#f0f0e0" : "#1f1f24"
}

// Замена несуществующего аватара Discord на стандартный (такой же, какой Discord показывает аккаунту без аватара)
// - Номер стандартного аватара - по ID пользователя из ссылки; заменяем один раз, чтобы не зациклиться
function onAvatarError(event) {
    const img = event.target
    if (!(img instanceof HTMLImageElement) || img.dataset.dsrFallback) return
    const userId = img.getAttribute("src")?.match(/\/avatars\/(\d+)\//)?.[1]
    if (!userId) return
    img.dataset.dsrFallback = "1"
    let index = 0
    try { index = Number((BigInt(userId) >> 22n) % 6n) } catch (err) {}
    img.src = `https://cdn.discordapp.com/embed/avatars/${index}.png`
}

// Элемент подсказки: аватар, ник, ID
function buildSuggestItem(profile, onPick) {
    const item = document.createElement("button")
    item.type = "button"
    item.className = "dsr-discord-suggest__item"
    const avatar = document.createElement("img")
    avatar.src = profile.avatarUrl ?? ""
    avatar.alt = ""
    const nick = document.createElement("span")
    nick.className = "dsr-discord-suggest__nick"
    nick.textContent = profile.nick || profile.username || profile.userId
    const meta = document.createElement("span")
    meta.className = "dsr-discord-suggest__meta"
    meta.textContent = profile.username && profile.username !== profile.nick ? `${profile.username} · ${profile.userId}` : profile.userId
    item.append(avatar, nick, meta)
    // Не даём полю ввода потерять фокус раньше, чем сработает клик
    item.addEventListener("mousedown", (event) => event.preventDefault())
    item.addEventListener("click", onPick)
    return item
}

// Участников голосового канала можно перетащить в таблицу пользователей
function activateMemberDrag(element) {
    for (const item of element.querySelectorAll(".dsr-voice-channel__member[data-discord-user-id]")) {
        item.draggable = true
        item.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData(DRAG_TYPE, item.dataset.discordUserId)
            event.dataTransfer.effectAllowed = "link"
        })
    }
}


// ==================================================
// ————————————————————— МАКРОСЫ ————————————————————
// ==================================================
// Подготовка данных для вкладки «Макросы»
function getMacrosContext() {
    const isGM = game.user.isGM
    const sections = []
    if (isGM) sections.push({
        scope: "world",
        isWorld: true,
        icon: "fas fa-globe",
        title: modLoc("macros.worldRules"),
        hint: modLoc("macros.worldRulesHint"),
        showAllowPlayers: true,
        rules: macroRules.getWorldRules().map(rule => getRuleContext(rule, true)),
    })
    if (macroRules.canEditOwn()) sections.push({
        scope: "own",
        isWorld: false,
        icon: "fas fa-user",
        title: modLoc("macros.ownRules"),
        hint: modLoc("macros.ownRulesHint"),
        showAllowPlayers: false,
        rules: macroRules.getUserRules().map(rule => getRuleContext(rule, false)),
    })
    return {
        sections,
        allowPlayerRules: macroRules.playerRulesAllowed(),
        playerRulesDisabled: !isGM && !macroRules.playerRulesAllowed(),
        eventOptions: Object.fromEntries(RULE_EVENTS.map(key => [key, modLoc(`macros.events.${key}`)])),
        help: getMacrosHelp(),
    }
}
// Данные одного правила
// - У событий без участника выбор «у привязанного игрока» не предлагаем. Если он уже выбран (сменили событие) -
//   оставляем в списке, но предупреждаем: молча менять, у кого выполняется макрос, нельзя
function getRuleContext(rule, isWorld) {
    const macro = macroRules.getMacro(rule.macroUuid)
    const noAccess = isWorld ? macroRules.getUsersWithoutAccess(rule, macro) : []
    const noMember = RULE_EVENTS_WITHOUT_MEMBER.includes(rule.event)
    const targets = RULE_TARGETS.filter(key => key !== "linked" || !noMember || rule.target === "linked")
    return {
        ...rule,
        targetOptions: Object.fromEntries(targets.map(key => [key, modLoc(`macros.targets.${key}`)])),
        linkedNeverRuns: isWorld && noMember && rule.target === "linked",
        cooldownSec: rule.cooldownSec ?? "",
        macro: macro ? {uuid: macro.uuid, name: macro.name, img: macro.img} : null,
        macroMissing: !!rule.macroUuid && !macro,
        showUsers: isWorld && rule.target === "users",
        users: game.users.contents.map(user => ({id: user.id, name: user.name, checked: rule.userIds.includes(user.id)})),
        noAccessNames: noAccess.map(user => user.name).join(", "),
    }
}
// Памятка по переменным макроса
function getMacrosHelp() {
    // Имена показываем так, как их пишут в макросе: discordEvent.user и т.д. (кроме обычных переменных Foundry)
    const rows = (group, names) => names.map(name => ({name: name === "speaker" ? "speaker, actor, token, character" : `discordEvent.${name}`, text: modLoc(`macros.help.${group}.${name}`)}))
    return {
        common: rows("common", ["type", "member", "foundryUser", "foundryUsers", "channel", "members", "rule", "speaker"]),
        specific: rows("specific", ["previous", "changed", "reason", "relayUser", "test"]),
        example: modLoc("macros.help.example"),
    }
}

// Изменения в правилах: каждое поле сохраняется сразу
// - Макрос в правило добавляется перетаскиванием из панели макросов или папки макросов
function activateMacroRules(element) {
    const part = element.querySelector(".dsr-macros")
    if (!part) return

    part.addEventListener("change", async (event) => {
        const input = event.target
        // Разрешить игрокам создавать правила (настройка мира)
        if (input.name === "allowPlayerRules") return game.settings.set(C.ID, "allowPlayerRules", input.checked)
        const ruleEl = input.closest(".dsr-rule")
        if (!ruleEl) return
        const isWorld = ruleEl.dataset.scope === "world"
        const ruleId = ruleEl.dataset.ruleId
        let changes
        switch (input.name) {
            case "enabled":
            case "allowWithoutPermission":
                changes = {[input.name]: input.checked}
                break
            case "event":
            case "target":
                changes = {[input.name]: input.value}
                break
            case "cooldownSec":
                changes = {cooldownSec: input.value === "" ? null : Number(input.value)}
                break
            case "userIds":
                changes = {userIds: [...ruleEl.querySelectorAll("input[name='userIds']:checked")].map(el => el.value)}
                break
            default:
                return
        }
        await macroRules.update(isWorld, ruleId, changes)
    })

    for (const dropEl of part.querySelectorAll(".dsr-macro-drop")) {
        dropEl.addEventListener("dragover", (event) => {
            event.preventDefault()
            dropEl.classList.add("dsr-drag-over")
        })
        dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dsr-drag-over"))
        dropEl.addEventListener("drop", async (event) => {
            event.preventDefault()
            dropEl.classList.remove("dsr-drag-over")
            let data
            try { data = JSON.parse(event.dataTransfer.getData("text/plain")) } catch (err) { return }
            if (data?.type !== "Macro") return ui.notifications.warn(modLoc("macros.notAMacro"))
            const macro = data.uuid ? macroRules.getMacro(data.uuid) : null
            if (!macro || macro.pack) return ui.notifications.warn(modLoc("macros.worldMacroOnly"))
            const ruleEl = dropEl.closest(".dsr-rule")
            await macroRules.update(ruleEl.dataset.scope === "world", ruleEl.dataset.ruleId, {macroUuid: macro.uuid})
        })
    }
}


// ==================================================
// ———————————————————— НАСТРОЙКИ ———————————————————
// ==================================================
// Какие настройки показывать во вкладке «Настройки»
// - Все видимые настройки модуля, кроме кнопки открытия этого окна. Название, подсказка и пределы берутся
//   из регистрации настройки (settings.js), поэтому здесь они всегда совпадают с «Настройками модулей»
const SETTINGS_TAB_GROUPS = [
    {id: "world", icon: "fas fa-globe", keys: ["discordBridgeIsActive", "speakingEventDebounceMs", "speakingStopDelayMs", "allowPlayerRules"]},
    {id: "client", icon: "fas fa-user", keys: ["overlayPopup"]},
]
// Подготовка данных для вкладки «Настройки»
// - Настройки мира меняет только ГМ; игрок их видит, но не может изменить
function getSettingsContext() {
    const isGM = game.user.isGM
    const getField = (key) => {
        const config = game.settings.settings.get(`${C.ID}.${key}`)
        if (!config) return null
        return {
            key,
            name: game.i18n.localize(config.name ?? ""),
            hint: game.i18n.localize(config.hint ?? ""),
            value: game.settings.get(C.ID, key),
            isBoolean: config.type === Boolean,
            range: config.type === Number ? (config.range ?? null) : null,
            readOnly: config.scope === "world" && !isGM,
            requiresReload: !!config.requiresReload,
        }
    }
    return {
        groups: SETTINGS_TAB_GROUPS.map(group => ({
            icon: group.icon,
            title: modLoc(`discordMenu.settingsTab.${group.id}`),
            hint: modLoc(`discordMenu.settingsTab.${group.id}Hint${group.id === "world" && !isGM ? "Player" : ""}`),
            fields: group.keys.map(getField).filter(Boolean),
        })),
    }
}
// Изменение настройки: сохраняется сразу
// - Настройке, которой нужна перезагрузка, - то же окно «Перезагрузить?», что и в «Настройках модулей»
function activateSettings(element) {
    const part = element.querySelector(".dsr-settings")
    if (!part) return
    part.addEventListener("change", async (event) => {
        const input = event.target
        const key = input.name
        const config = key ? game.settings.settings.get(`${C.ID}.${key}`) : null
        if (!config || input.disabled) return
        if (config.scope === "world" && !game.user.isGM) return
        let value = config.type === Boolean ? input.checked : input.value
        if (config.type === Number) {
            value = Number(value)
            if (!Number.isFinite(value)) return refreshSettingsTab()
        }
        if (value === game.settings.get(C.ID, key)) return
        await game.settings.set(C.ID, key, value)
        if (!config.requiresReload) return
        const SettingsConfig = foundry.applications.settings?.SettingsConfig
        if (SettingsConfig?.reloadConfirm) await SettingsConfig.reloadConfirm({world: config.scope === "world"})
        else ui.notifications.info(modLoc("discordMenu.settingsTab.reloadNeeded"))
    })
}


// ==================================================
// ————————————————————— ЖУРНАЛ —————————————————————
// ==================================================
// Подготовка данных для журнала
function getEventLogContext() {
    const ts = Date.now()
    const entries = eventLog.getEntries().map(entry => {
        const foundryName = entry.foundryUserId ? (game.users.get(entry.foundryUserId)?.name ?? entry.foundryUserId) : "—"
        const reason = entry.data?.reason ? modLoc(`discordMenu.log.reasons.${entry.data.reason}`) : ""
        return {
            type: entry.type,
            time: new Date(entry.ts).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}),
            avatarUrl: entry.member?.avatarUrl ?? null,
            icon: C.LOG_ICONS[entry.type] ?? "fas fa-circle-info",
            text: modFormat(`discordMenu.log.types.${entry.type}`, {
                nick: entry.member?.nick ?? "?",
                user: foundryName,
                channel: entry.data?.channelName ?? modLoc("general.unknownVoiceChat"),
                count: entry.data?.userCount ?? 0,
                prevNick: entry.data?.prevNick ?? "?",
                reason,
            }),
            isNew: ts - entry.ts < LOG_NEW_MS,
        }
    })
    return {
        entries,
        logSpeaking: getSettings("logSpeaking", false),
    }
}


// ==================================================
// ——————————————————— ГОЛОСОВОЙ КАНАЛ ——————————————
// ==================================================
// Подготовка данных для списка участников голосового канала
function getVoiceChannelContext() {
    const channel = voiceChannel.getChannel()
    const savedName = getSettings("discordVoiceChatData", false)?.name
    const hasChannel = !!getSettings("discordVoiceChatData", false)?._fullId
    const name = channel?.name || savedName || modLoc(hasChannel ? "general.unknownVoiceChat" : "general.voiceChatNotSet")
    // Почему состава нет: нет основного ретранслятора или данные ещё не пришли
    const notLoadedText = modLoc(relayNetwork.getActiveRelayUserId() ? "discordMenu.voiceChat.waitingData" : "discordMenu.voiceChat.chatInactiveWarning")
    const members = voiceChannel.getMembers()
        .map(member => ({
            userId: member.id,
            nick: member.nick || member.name || member.id,
            avatarUrl: member.avatarUrl,
            mute: member.mute,
            deaf: member.deaf,
            bot: member.bot,
            speaking: member.speaking,
            tooltip: [member.name, member.id].filter(Boolean).join(" · "),
        }))
        .sort((a, b) => String(a.nick).localeCompare(String(b.nick)))
    return {
        name,
        loaded: !!channel,
        userLimit: channel?.userLimit || null,
        members,
        notLoadedText,
    }
}


// ==================================================
// ——————————————— ССЫЛКА НА КАНАЛ ——————————————————
// ==================================================
// Поле ввода ссылки на голосовой канал
// - Менять канал может только ГМ
// - Корректная ссылка сохраняется сама. Некорректная НЕ стирает сохранённый канал (только меняется значок)
// - Пустое поле сбрасывает канал только после подтверждения и только при уходе из поля или Enter:
//   иначе ГМ, который стёр старую ссылку, чтобы вставить новую, отключил бы всех ретрансляторов
function activateVoiceUrlInput(element) {
    const input = element.querySelector("input[name='voiceUrl']")
    const icon = element.querySelector(".dsr-voice-url__icon")
    if (!input || input.disabled) return

    const setIcon = (isValid) => {
        icon?.classList.toggle("fa-circle-check", isValid)
        icon?.classList.toggle("fa-circle-xmark", !isValid)
    }
    // Сохранение ссылки (пустое поле здесь не обрабатываем - см. confirmClear)
    const apply = async () => {
        const value = input.value.trim()
        if (!value) return setIcon(false)
        const ids = parseVoiceUrl(value)
        setIcon(!!ids)
        if (!ids) return
        // Превращаем ссылку в короткий вид «ID сервера/ID канала»
        input.value = `${ids.guild_id}/${ids.channel_id}`
        await saveVoiceChannel(ids)
    }
    // Поле очищено и ГМ ушёл из него - спрашиваем, сбросить ли канал
    // - Отказ - возвращаем в поле сохранённый канал
    let confirming = false
    const confirmClear = async () => {
        if (input.value.trim() || confirming) return
        const saved = getSettings("discordVoiceChatData", false)?._fullId ?? ""
        if (!saved) return
        confirming = true
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: {title: modLoc("discordMenu.relayStatusConfig.clearDialog.title"), icon: "fas fa-volume-xmark"},
            content: `<p>${modLoc("discordMenu.relayStatusConfig.clearDialog.text")}</p>`,
            rejectClose: false,
        })
        confirming = false
        if (ok) return saveVoiceChannel(null)
        input.value = saved
        setIcon(!!parseVoiceUrl(saved))
    }
    const applyDebounced = foundry.utils.debounce(apply, 500)
    // - Ввод (с задержкой, чтобы не сохранять на каждую букву)
    input.addEventListener("input", applyDebounced)
    // - Вставка (сразу)
    input.addEventListener("paste", () => setTimeout(apply, 0))
    // - Уход из поля или Enter (сразу)
    input.addEventListener("change", () => input.value.trim() ? apply() : confirmClear())
}
// Сохранение канала
async function saveVoiceChannel(ids) {
    if (!game.user.isGM) return
    const prev = getSettings("discordVoiceChatData") ?? {}
    // Ничего не поменялось - не сохраняем
    if ((prev.guild_id ?? null) === (ids?.guild_id ?? null) && (prev.channel_id ?? null) === (ids?.channel_id ?? null)) return
    const next = ids ? {
        guild_id: ids.guild_id,
        channel_id: ids.channel_id,
        _fullId: `${ids.guild_id}/${ids.channel_id}`,
        user_limit: null,
        name: null,
        topic: null,
    } : {}
    await game.settings.set(C.ID, "discordVoiceChatData", next)
    ui.notifications.info(modLoc(ids ? "notifications.voiceChatDataUpdated" : "notifications.voiceChatDataCleared"))
}


// ==================================================
// ——————————————— ФУНКЦИИ РУКОВОДСТВА ——————————————
// ==================================================
// Получение текста скрипта TamperMonkey
async function getGuideScript() {
    if (guideScriptCache !== undefined) return guideScriptCache
    if (guideScriptPromise) return guideScriptPromise

    guideScriptPromise = fetch(foundry.utils.getRoute(`${C.MODULE_PATH}/${C.SCRIPT.FILE}`))
        .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.text()
        })
        .then((text) => {
            guideScriptCache = text
            return text
        })
        .catch((error) => {
            console.warn(`${C.ID} | Failed to load TamperMonkey script`, error)
            guideScriptCache = null
            return null
        })
        .finally(() => {
            guideScriptPromise = null
        })

    return guideScriptPromise
}

/*
█████████████████████████████████████████████████████
█████████████████████████████████████████████████████
█████████████████████████████████████████████████████
*/

// ==================================================
// ——————————————————— ОТКРЫТИЕ ОКНА ————————————————
// ==================================================
// Открытие окна модуля
// - Если окно уже открыто - не создаём второе, а выводим существующее на передний план
export async function openDiscordMenu(appData = {}) {
    const {currentTab} = appData
    if (menuInstance) {
        if (currentTab) menuInstance.changeTab(currentTab, "primary", {force: true})
        if (menuInstance.minimized) await menuInstance.maximize()
        menuInstance.bringToFront()
        return menuInstance
    }
    return new DiscordMenu(appData).render(true)
}

// Обновление окна после изменения настроек канала
// - Поле ввода не перерисовываем, пока ГМ в нём печатает (иначе собьётся курсор)
export function refreshDiscordMenu() {
    if (!menuInstance?.rendered) return
    const input = menuInstance.element.querySelector("input[name='voiceUrl']")
    const parts = ["relayStatus"]
    if (!input || document.activeElement !== input) parts.push("relay")
    menuInstance.render({parts})
}

// Обновление таблицы пользователей после изменения связей или кэша профилей
export function refreshDiscordLinks() {
    menuInstance?.renderUsersPart()
}

// Обновление вкладки «Настройки» (изменилась одна из видимых настроек модуля)
export function refreshSettingsTab() {
    if (menuInstance?.rendered) menuInstance.render({parts: ["settings"]})
}

// Обновление вкладки «Макросы» (изменились правила, настройка или права на макросы)
export function refreshMacroRules() {
    if (menuInstance?.rendered) menuInstance.render({parts: ["macros"]})
}

// Пустышка для кнопки в настройках модуля
// - Кнопка настроек всегда создаёт новое окно, поэтому вместо самого окна регистрируем «открывашку»,
//   которая открывает окно через openDiscordMenu (и не плодит копии)
export class DiscordMenuLauncher extends ApplicationV2 {
    async render() {
        await openDiscordMenu()
        return this
    }
}
