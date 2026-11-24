import { Constants as C } from "./const.js"

// Получение локализации
export const modLoc = (key) => game.i18n.localize(`${C.ID}.${key}`)
export const modFormat = (key, data) => game.i18n.format(`${C.ID}.${key}`, data)
// Проверка, является ли значение объектом
export const isObject = (x) => !!x && typeof x === "object"
// Текущее время
export const now = () => Date.now()


// ==================================================
// ———————————————————— НАСТРОЙКИ ———————————————————
// ==================================================
// Получение настроек
// - По умолчанию возвращаем копию, чтобы случайно не изменить сохранённое значение
export const getSettings = (key, deepClone = true) => deepClone ? foundry.utils.deepClone(game.settings.get(C.ID, key)) : game.settings.get(C.ID, key)


// ==================================================
// ————————————————— ГОЛОСОВОЙ КАНАЛ ————————————————
// ==================================================
// Извлечение ID сервера и канала из ссылки (или из строки "ID/ID")
// - Возвращает {guild_id, channel_id} или null
export function parseVoiceUrl(value) {
    const match = String(value ?? "").match(C.VOICE_URL_REGEX)
    if (!match) return null
    return {guild_id: match[1], channel_id: match[2]}
}
// Получение ID сервера и канала из настроек
// - Возвращает {guild_id, channel_id} или null, если канал не указан
export function getVoiceChannelIds() {
    const data = getSettings("discordVoiceChatData", false) ?? {}
    if (!data.guild_id || !data.channel_id) return null
    return {guild_id: data.guild_id, channel_id: data.channel_id}
}
// Ссылка на оверлей StreamKit для канала
export const getOverlayUrl = ({guild_id, channel_id}) => `${C.STREAMKIT_ORIGIN}/overlay/voice/${guild_id}/${channel_id}`


// ==================================================
// ——————————————————— ОКРУЖЕНИЕ ————————————————————
// ==================================================
// Открыт ли Foundry в приложении (а не в браузере)
// - В приложении Foundry строка userAgent содержит "FoundryVirtualTabletop/..." и "Electron/..."
export const isFoundryApp = () => /FoundryVirtualTabletop\/|Electron\//.test(navigator.userAgent)
// Ссылка на страницу входа в мир (для копирования и открытия в браузере)
export const getWorldJoinUrl = () => new URL(foundry.utils.getRoute("join"), window.location.origin).href


// ==================================================
// ———————————————————— ТАЙМЕРЫ —————————————————————
// ==================================================
// Создание таймера, который не замедляется в фоновой вкладке
// - Браузер сильно замедляет setInterval в свёрнутых/фоновых вкладках. Таймеры внутри Web Worker так не замедляются,
//   поэтому «тикаем» из воркера. Если воркер создать не удалось - используем обычный setInterval
// - Воркер создаётся один раз, а stop() только ставит его на паузу: таймер, который часто включается и выключается
//   (например, фильтр коротких звуков - на каждую фразу), не создаёт каждый раз новый воркер
export function createTicker(fn, intervalMs) {
    let worker = null
    let intervalId = null
    let running = false

    // Воркер: получает интервал (0 - пауза) и тикает с ним
    const createWorker = () => {
        const code = "let id = null\nonmessage = (e) => { clearInterval(id); id = e.data ? setInterval(() => postMessage(0), e.data) : null }"
        const url = URL.createObjectURL(new Blob([code], {type: "text/javascript"}))
        worker = new Worker(url)
        // Ссылку на код воркера освобождаем после первого тика (раньше нельзя: воркер мог ещё не загрузиться)
        let urlRevoked = false
        worker.onmessage = () => {
            if (!urlRevoked) {
                URL.revokeObjectURL(url)
                urlRevoked = true
            }
            // Тик, отправленный воркером до паузы, мог прийти уже после stop()
            if (running) fn()
        }
    }

    const start = () => {
        if (running) return
        running = true
        try {
            if (!worker) createWorker()
            worker.postMessage(intervalMs)
        } catch (err) {
            worker?.terminate()
            worker = null
            intervalId = setInterval(fn, intervalMs)
        }
    }
    const stop = () => {
        running = false
        try { worker?.postMessage(0) } catch (err) {}
        if (intervalId) clearInterval(intervalId)
        intervalId = null
    }
    const isRunning = () => running

    return {start, stop, isRunning}
}


// ==================================================
// ————————————————— БУФЕР ОБМЕНА ———————————————————
// ==================================================
// Копирование текста в буфер обмена
// - navigator.clipboard работает только по https/localhost, поэтому есть запасной вариант через execCommand
export async function copyTextToClipboard(text) {
    if (!text) return false
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch (err) {
        // Пробуем запасной вариант
    }

    try {
        const textarea = document.createElement("textarea")
        textarea.value = text
        textarea.setAttribute("readonly", "")
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        textarea.style.left = "-9999px"
        document.body.appendChild(textarea)
        textarea.select()
        textarea.setSelectionRange(0, textarea.value.length)
        const ok = document.execCommand("copy")
        textarea.remove()
        return ok
    } catch (err) {
        return false
    }
}
