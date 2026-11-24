// ==================================================
// ————————————————— ТОЧКА ВХОДА ————————————————————
// ==================================================
// Единственный файл из module.json: порядок загрузки частей модуля задаётся здесь
import "../data/socket.js"
import "./relay.js"
import "./relayNetwork.js"
import "./voiceChannel.js"
import "./userLinks.js"
import "./eventLog.js"
import "./macroRules.js"
import "./api.js"
// Устаревший API старой версии (удалить в 2.0.0 вместе с файлом)
import "./legacy.js"
import "./settings.js"
