// ARQUIVO: services/notificationService.js (VERSÃO FINAL COM CORREÇÃO DE NVM E DOTENV)

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// Prefixo para garantir que o ambiente NVM seja carregado na sessão SSH
const NVM_PREFIX = 'source /root/.nvm/nvm.sh && ';

function parseNotifications(envContent) {
    const notifications = {};
    const lines = envContent.split('\n');

    lines.forEach(line => {
        const matchName = line.match(/^TELEGRAM_NAME_(\d+)="?([^"]+)"?$/);
        if (matchName) {
            const id = matchName[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].name = matchName[2];
        }
        const matchToken = line.match(/^TELEGRAM_TOKEN_(\d+)="?([^"]+)"?$/);
        if (matchToken) {
            const id = matchToken[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].token = matchToken[2];
        }
        const matchChatId = line.match(/^TELEGRAM_CHAT_ID_(\d+)="?([^"]+)"?$/);
        if (matchChatId) {
            const id = matchChatId[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].chatId = matchChatId[2];
        }
        const matchPurpose = line.match(/^TELEGRAM_PURPOSE_(\d+)="?([^"]+)"?$/);
        if (matchPurpose) {
            const id = matchPurpose[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].purpose = matchPurpose[2];
        }
    });

    return Object.values(notifications).filter(n => n.id && n.name && n.token && n.chatId);
}

function updateEnvFile(currentEnvContent, updatedNotification) {
    const existingNotifications = parseNotifications(currentEnvContent);
    const notificationIndex = existingNotifications.findIndex(n => n.id == updatedNotification.id);
    if (notificationIndex > -1) {
        existingNotifications[notificationIndex] = updatedNotification;
    } else {
        existingNotifications.push(updatedNotification);
    }
    
    return generateNewEnvContent(currentEnvContent, existingNotifications);
}

function removeNotificationFromEnv(currentEnvContent, notificationIdToRemove) {
    let existingNotifications = parseNotifications(currentEnvContent);
    existingNotifications = existingNotifications.filter(n => n.id != notificationIdToRemove);
    return generateNewEnvContent(currentEnvContent, existingNotifications);
}

function generateNewEnvContent(currentEnvContent, notifications) {
    let otherLines = currentEnvContent.split('\n').filter(line => 
        !line.startsWith('TELEGRAM_NAME_') &&
        !line.startsWith('TELEGRAM_TOKEN_') &&
        !line.startsWith('TELEGRAM_CHAT_ID_') &&
        !line.startsWith('TELEGRAM_PURPOSE_')
    );

    otherLines = otherLines.filter(line => line.trim() !== '' && !line.trim().startsWith('#') || line.includes('='));
    
    let newEnvContent = otherLines.join('\n');
    if (newEnvContent.length > 0 && !newEnvContent.endsWith('\n\n')) {
        newEnvContent += '\n\n';
    }
    
    newEnvContent += `# ==========================================================\n`;
    newEnvContent += `# ARQUITETO: Chaves de API do Telegram para notificações\n`;
    newEnvContent += `# (Gerado e gerido automaticamente pelo Painel de Controlo)\n`;
    newEnvContent += `# ==========================================================\n\n`;

    notifications.forEach(notif => {
        newEnvContent +=`TELEGRAM_NAME_${notif.id}="${notif.name}"\n`;
        newEnvContent +=`TELEGRAM_PURPOSE_${notif.id}="${notif.purpose || ''}"\n`;
        newEnvContent +=`TELEGRAM_TOKEN_${notif.id}="${notif.token}"\n`;
        newEnvContent +=`TELEGRAM_CHAT_ID_${notif.id}="${notif.chatId}"\n\n`;
    });

    return newEnvContent.trim() + '\n';
}


function getNotifierContent() {
    return `
// Ficheiro gerado automaticamente pelo Bot Control Panel - NÃO EDITE MANUALMENTE
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
// ### CORREÇÃO APLICADA AQUI: Carrega o .env a partir do diretório do script principal ###
require('dotenv').config({ path: path.join(__dirname, '.env') });

const botsByPurpose = {};

Object.keys(process.env).forEach(key => {
    const matchPurpose = key.match(/^TELEGRAM_PURPOSE_(\\d+)$/);
    if (matchPurpose) {
        const id = matchPurpose[1];
        const purpose = process.env[key];
        const token = process.env[\`TELEGRAM_TOKEN_\${id}\`];
        const chatId = process.env[\`TELEGRAM_CHAT_ID_\${id}\`];

        if (purpose && token && chatId) {
            try {
                // Previne que um token inválido quebre o bot inteiro
                if (!botsByPurpose[purpose]) {
                    botsByPurpose[purpose] = {
                        instance: new TelegramBot(token),
                        chatId: chatId,
                    };
                }
            } catch(e) {
                console.error(\`[Notifier] Falha ao inicializar o bot do Telegram para a finalidade: '\${purpose}'. Verifique se o TOKEN é válido. Erro: \`, e.message);
            }
        }
    }
});

/**
 * Envia uma mensagem para uma notificação com uma finalidade específica.
 * @param {string} notificationPurpose - A finalidade da notificação (ex: "alerta_novo_lead").
 * @param {string} message - A mensagem a ser enviada.
 */
async function sendNotification(notificationPurpose, message) {
    const botInfo = botsByPurpose[notificationPurpose];
    if (!botInfo) {
        console.error(\`[Notifier] Tentativa de enviar notificação para uma finalidade não configurada: "\${notificationPurpose}"\`);
        return;
    }
    try {
        await botInfo.instance.sendMessage(botInfo.chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(\`[Notifier] Erro ao enviar mensagem para a finalidade "\${notificationPurpose}":\`, error.response ? error.response.body : error.message);
    }
}

module.exports = { sendNotification };
`;
}

async function injectNotifier(ssh, scriptPath) {
    const botDirectory = path.dirname(scriptPath);
    const notifierPath = path.join(botDirectory, 'telegramNotifier.js');
    const mainScriptPath = scriptPath;

    console.log(`[PAINEL] A garantir que as dependências de notificação existem em ${botDirectory}...`);
    const installCommand = `${NVM_PREFIX}npm install --prefix "${botDirectory}" node-telegram-bot-api dotenv`;
    const installResult = await ssh.execCommand(installCommand);
    
    if (installResult.code !== 0) {
        console.error(`[PAINEL] Falha ao instalar dependências de notificação:`, installResult.stderr);
        throw new Error(`Falha ao executar 'npm install' para as dependências de notificação. Detalhe: ${installResult.stderr}`);
    }
    console.log(`[PAINEL] Dependências de notificação instaladas com sucesso.`);


    const notifierContent = getNotifierContent();
    const base64Content = Buffer.from(notifierContent).toString('base64');
    await ssh.execCommand(`echo ${base64Content} | base64 --decode > ${notifierPath}`);

    const mainScriptContentResult = await ssh.execCommand(`cat ${mainScriptPath}`);
    let mainScriptContent = mainScriptContentResult.stdout;
    let modified = false;

    const injectionLine = `const { sendNotification } = require('./telegramNotifier.js');`;
    if (!mainScriptContent.includes(injectionLine)) {
        mainScriptContent = injectionLine + '\n' + mainScriptContent;
        modified = true;
    }

    if (modified) {
        await ssh.execCommand(`cp ${mainScriptPath} ${mainScriptPath}.bak`).catch(() => console.log('Backup do script principal não pôde ser criado.'));
        const base64MainContent = Buffer.from(mainScriptContent).toString('base64');
        await ssh.execCommand(`echo ${base64MainContent} | base64 --decode > ${mainScriptPath}`);
    }
}

async function sendTestMessage(token, chatId, message) {
    try {
        const bot = new TelegramBot(token);
        await bot.sendMessage(chatId, message);
    } catch (error) {
        const errorMessage = error.response ? error.response.body.description : error.message;
        throw new Error(errorMessage || 'Erro desconhecido.');
    }
}

module.exports = { parseNotifications, updateEnvFile, getNotifierContent, injectNotifier, sendTestMessage, removeNotificationFromEnv };