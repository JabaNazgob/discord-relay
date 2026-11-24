import { Constants as C } from "./const.js"
import { isObject } from "./functions.js"

// ==================================================
// ————————————————————{ СОКЕТЫ }————————————————————
// ==================================================
// Обмен сообщениями между клиентами
// - Сообщение от клиента сервер пересылает всем ОСТАЛЬНЫМ клиентам (отправителю оно не возвращается)
// - Каждое сообщение: {type, senderId, data}

const SOCKET_NAME = `module.${C.ID}`
// Обработчики по типу сообщения
const handlers = new Map()

// Подписка на тип сообщения
export function onSocket(type, handler) {
    handlers.set(type, handler)
}

// Отправка сообщения всем остальным клиентам
export function emitSocket(type, data = {}) {
    game.socket.emit(SOCKET_NAME, {type, senderId: game.user.id, data})
}

// Приём сообщений
Hooks.once("setup", () => {
    game.socket.on(SOCKET_NAME, (msg) => {
        if (!isObject(msg) || typeof msg.type !== "string") return
        if (CONFIG.debug?.discordBridge?.onSocket) console.log(`${C.ID} | socket:`, msg)
        const handler = handlers.get(msg.type)
        if (!handler) return
        try {
            handler(msg.data ?? {}, msg.senderId)
        } catch (err) {
            console.error(`${C.ID} | socket handler "${msg.type}" failed`, err)
        }
    })
})
