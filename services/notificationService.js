// ARQUIVO: services/notificationService.js (NOVO)

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

/**
 * Parsea o conteúdo de um ficheiro .env para encontrar as configurações de notificação.
 * Retorna um array de objetos de notificação.
 */
function parseNotifications(envContent) {
    const notifications = {};
    const lines = envContent.split('\n');

    lines.forEach(line => {
        const matchName = line.match(/^TELEGRAM_NAME_(\d+)="?([^"]+)"?$/);
        const matchToken = line.match(/^TELEGRAM_TOKEN_(\d+)="?([^"]+)"?$/);
        const matchChatId = line.match(/^TELEGRAM_CHAT_ID_(\d+)="?([^"]+)"?$/);

        if (matchName) {
            const id = matchName[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].name = matchName[2];
        } else if (matchToken) {
            const id = matchToken[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].token = matchToken[2];
        } else if (matchChatId) {
            const id = matchChatId[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].chatId = matchChatId[2];
        }
    });

    return Object.values(notifications).filter(n => n.name && n.token && n.chatId);
}


/**
 * Atualiza ou adiciona uma nova notificação no conteúdo do ficheiro .env.
 * @param {string} envContent - O conteúdo atual do ficheiro .env.
 * @param {object} notification - O objeto de notificação { id, name, token, chatId }.
 * @returns {string} - O novo conteúdo do ficheiro .env.
 */
function updateEnvFile(envContent, notification) {
    let lines = envContent.split('\n');
    const { id, name, token, chatId } = notification;

    // Remove as linhas antigas para este ID, se existirem
    lines = lines.filter(line => !line.startsWith(`TELEGRAM_NAME_${id}=`) &&
                                 !line.startsWith(`TELEGRAM_TOKEN_${id}=`) &&
                                 !line.startsWith(`TELEGRAM_CHAT_ID_${id}=`));

    // Adiciona as novas linhas
    lines.push(`TELEGRAM_NAME_${id}="${name}"`);
    lines.push(`TELEGRAM_TOKEN_${id}="${token}"`);
    lines.push(`TELEGRAM_CHAT_ID_${id}="${chatId}"`);

    // Limpa linhas em branco do final
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }
    
    return lines.join('\n') + '\n';
}

/**
 * Gera o conteúdo do ficheiro `telegramNotifier.js`.
 */
function getNotifierContent() {
    return `
// Ficheiro gerado automaticamente pelo Bot Control Panel - NÃO EDITE MANUALMENTE
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const bots = {};

// Lê todas as variáveis de ambiente TELEGRAM_* e inicializa os bots
Object.keys(process.env).forEach(key => {
    const matchName = key.match(/^TELEGRAM_NAME_(\\d+)$/);
    if (matchName) {
        const id = matchName[1];
        const name = process.env[key];
        const token = process.env[\`TELEGRAM_TOKEN_\${id}\`];
        const chatId = process.env[\`TELEGRAM_CHAT_ID_\${id}\`];

        if (name && token && chatId) {
            try {
                bots[name] = {
                    instance: new TelegramBot(token),
                    chatId: chatId,
                };
            } catch(e) {
                console.error(\`[Notifier] Falha ao inicializar o bot do Telegram para: \${name}\`, e.message);
            }
        }
    }
});

/**
 * Envia uma mensagem para uma notificação configurada específica.
 * @param {string} notificationName - O nome da notificação (ex: "Alertas Admin").
 * @param {string} message - A mensagem a ser enviada.
 */
async function sendNotification(notificationName, message) {
    const botInfo = bots[notificationName];
    if (!botInfo) {
        console.error(\`[Notifier] Tentativa de enviar notificação para um canal não configurado: "\${notificationName}"\`);
        return;
    }
    try {
        await botInfo.instance.sendMessage(botInfo.chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(\`[Notifier] Erro ao enviar mensagem para "\${notificationName}":\`, error.response ? error.response.body : error.message);
    }
}

module.exports = { sendNotification };
`;
}


/**
 * Garante que o ficheiro do notificador e a sua injeção no bot principal existem.
 */
async function injectNotifier(ssh, scriptPath) {
    const botDirectory = path.dirname(scriptPath);
    const notifierPath = path.join(botDirectory, 'telegramNotifier.js');
    const mainScriptPath = scriptPath;

    // 1. Verifica se o notifier.js existe. Se não, cria.
    const checkNotifierFile = await ssh.execCommand(`test -f ${notifierPath} && echo "exists"`);
    if (checkNotifierFile.code !== 0) {
        const notifierContent = getNotifierContent();
        const base64Content = Buffer.from(notifierContent).toString('base64');
        await ssh.execCommand(`echo ${base64Content} | base64 --decode > ${notifierPath}`);
        // Também instala a dependência do telegram no diretório do bot
        await ssh.execCommand(`npm --prefix ${botDirectory} install node-telegram-bot-api`);
    }

    // 2. Verifica se o script principal já importa o notificador. Se não, injeta.
    const mainScriptContentResult = await ssh.execCommand(`cat ${mainScriptPath}`);
    const mainScriptContent = mainScriptContentResult.stdout;
    const injectionLine = `const { sendNotification } = require('./telegramNotifier.js');`;

    if (!mainScriptContent.includes(injectionLine)) {
        const newContent = injectionLine + '\n' + mainScriptContent;
        const base64Content = Buffer.from(newContent).toString('base64');
        await ssh.execCommand(`echo ${base64Content} | base64 --decode > ${mainScriptPath}`);
    }
}


/**
 * Envia uma mensagem de teste diretamente.
 */
async function sendTestMessage(token, chatId, message) {
    try {
        const bot = new TelegramBot(token);
        await bot.sendMessage(chatId, message);
    } catch (error) {
        // Tenta extrair uma mensagem de erro mais útil da API do Telegram
        const errorMessage = error.response ? error.response.body.description : error.message;
        throw new Error(errorMessage || 'Erro desconhecido.');
    }
}


module.exports = {
    parseNotifications,
    updateEnvFile,
    getNotifierContent,
    injectNotifier,
    sendTestMessage
};