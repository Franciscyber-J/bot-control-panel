// ARQUIVO: services/notificationService.js (COMPLETO E CORRIGIDO)

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

/**
 * Parsea o conteúdo de um ficheiro .env para encontrar as configurações de notificação.
 * Esta versão é inteligente e suporta múltiplos formatos legados.
 */
function parseNotifications(envContent) {
    const notifications = {};
    const lines = envContent.split('\n');
    let hasNewFormat = false;

    // Prioridade 1: Tenta parsear o novo formato numerado primeiro.
    lines.forEach(line => {
        const matchName = line.match(/^TELEGRAM_NAME_(\d+)="?([^"]+)"?$/);
        if (matchName) {
            hasNewFormat = true;
            const id = matchName[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].name = matchName[2];
        }
        const matchToken = line.match(/^TELEGRAM_TOKEN_(\d+)="?([^"]+)"?$/);
        if (matchToken) {
            hasNewFormat = true;
            const id = matchToken[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].token = matchToken[2];
        }
        const matchChatId = line.match(/^TELEGRAM_CHAT_ID_(\d+)="?([^"]+)"?$/);
        if (matchChatId) {
            hasNewFormat = true;
            const id = matchChatId[1];
            if (!notifications[id]) notifications[id] = { id };
            notifications[id].chatId = matchChatId[2];
        }
    });

    // Se o novo formato não foi encontrado, procura pelos formatos legados.
    if (!hasNewFormat) {
        // Formato Legado 1: ..._PRINCIPAL / ..._SECUNDARIO
        const principalTokenLine = lines.find(l => l.startsWith('TELEGRAM_BOT_TOKEN_PRINCIPAL='));
        const principalChatIdLine = lines.find(l => l.startsWith('TELEGRAM_CHAT_ID_PRINCIPAL='));
        if (principalTokenLine && principalChatIdLine) {
            notifications[1] = {
                id: 1, name: 'Principal',
                token: principalTokenLine.split('=')[1].replace(/"/g, ''),
                chatId: principalChatIdLine.split('=')[1].replace(/"/g, '')
            };
        }
        const secundarioTokenLine = lines.find(l => l.startsWith('TELEGRAM_BOT_TOKEN_SECUNDARIO='));
        const secundarioChatIdLine = lines.find(l => l.startsWith('TELEGRAM_CHAT_ID_SECUNDARIO='));
        if (secundarioTokenLine && secundarioChatIdLine) {
            notifications[2] = {
                id: 2, name: 'Secundario',
                token: secundarioTokenLine.split('=')[1].replace(/"/g, ''),
                chatId: secundarioChatIdLine.split('=')[1].replace(/"/g, '')
            };
        }

        // Formato Legado 2: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (sem sufixo)
        const singleTokenLine = lines.find(l => l.startsWith('TELEGRAM_BOT_TOKEN='));
        const singleChatIdLine = lines.find(l => l.startsWith('TELEGRAM_CHAT_ID='));
        if (singleTokenLine && singleChatIdLine) {
            notifications[1] = { // Assume ID 1 para o formato simples
                id: 1, name: 'Padrão', // Nome genérico
                token: singleTokenLine.split('=')[1].replace(/"/g, ''),
                chatId: singleChatIdLine.split('=')[1].replace(/"/g, '')
            };
        }
    }

    return Object.values(notifications).filter(n => n.id && n.name && n.token && n.chatId);
}

/**
 * Atualiza ou adiciona uma notificação. Esta função sempre escreve no NOVO FORMATO,
 * migrando automaticamente o .env se ele estava em um formato legado.
 */
function updateEnvFile(currentEnvContent, updatedNotification) {
    const existingNotifications = parseNotifications(currentEnvContent);
    const notificationIndex = existingNotifications.findIndex(n => n.id == updatedNotification.id);
    if (notificationIndex > -1) {
        existingNotifications[notificationIndex] = updatedNotification;
    } else {
        existingNotifications.push(updatedNotification);
    }
    
    // Filtra as linhas do .env, removendo TODAS as variáveis de notificação (legadas e novas)
    let otherLines = currentEnvContent.split('\n').filter(line => 
        !line.startsWith('TELEGRAM_BOT_TOKEN_PRINCIPAL=') &&
        !line.startsWith('TELEGRAM_CHAT_ID_PRINCIPAL=') &&
        !line.startsWith('TELEGRAM_BOT_TOKEN_SECUNDARIO=') &&
        !line.startsWith('TELEGRAM_CHAT_ID_SECUNDARIO=') &&
        !line.startsWith('TELEGRAM_BOT_TOKEN=') &&
        !line.startsWith('TELEGRAM_CHAT_ID=') &&
        !line.startsWith('TELEGRAM_NAME_') &&
        !line.startsWith('TELEGRAM_TOKEN_') &&
        !line.startsWith('TELEGRAM_CHAT_ID_')
    );

    // Limpa linhas em branco e comentários vazios
    otherLines = otherLines.filter(line => line.trim() !== '' && !line.trim().startsWith('#') || line.includes('='));
    
    let newEnvContent = otherLines.join('\n');
    if (newEnvContent.length > 0) {
        newEnvContent += '\n\n';
    }
    
    newEnvContent += `# ==========================================================\n`;
    newEnvContent += `# ARQUITETO: Chaves de API do Telegram para notificações\n`;
    newEnvContent += `# (Gerado e gerido automaticamente pelo Painel de Controlo)\n`;
    newEnvContent += `# ==========================================================\n\n`;

    existingNotifications.forEach(notif => {
        newEnvContent +=`TELEGRAM_NAME_${notif.id}="${notif.name}"\n`;
        newEnvContent +=`TELEGRAM_TOKEN_${notif.id}="${notif.token}"\n`;
        newEnvContent +=`TELEGRAM_CHAT_ID_${notif.id}="${notif.chatId}"\n\n`;
    });

    return newEnvContent.trim() + '\n';
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
 * Garante que o ficheiro do notificador e a sua injeção no bot principal existem,
 * e desativa o código legado de notificação.
 */
async function injectNotifier(ssh, scriptPath) {
    const botDirectory = path.dirname(scriptPath);
    const notifierPath = path.join(botDirectory, 'telegramNotifier.js');
    const mainScriptPath = scriptPath;

    // Garante que as dependências para o notificador estejam sempre instaladas no bot.
    await ssh.execCommand(`npm --prefix ${botDirectory} install node-telegram-bot-api dotenv`);

    // 1. Garante que o ficheiro notifier.js existe
    const checkNotifierFile = await ssh.execCommand(`test -f ${notifierPath} && echo "exists"`);
    if (checkNotifierFile.code !== 0) {
        const notifierContent = getNotifierContent();
        const base64Content = Buffer.from(notifierContent).toString('base64');
        await ssh.execCommand(`echo ${base64Content} | base64 --decode > ${notifierPath}`);
    }

    // 2. Lê o conteúdo do script principal para fazer a migração
    const mainScriptContentResult = await ssh.execCommand(`cat ${mainScriptPath}`);
    let mainScriptContent = mainScriptContentResult.stdout;
    let modified = false;

    // 3. Comenta o require antigo do telegram-bot-api se existir
    const requireRegex = /^(const\s+.*\s*=\s*)?require\(['"]node-telegram-bot-api['"]\);?/gm;
    if (mainScriptContent.match(requireRegex)) {
        mainScriptContent = mainScriptContent.replace(requireRegex, '// $&');
        modified = true;
    }

    // 4. Comenta a inicialização antiga do bot
    const newBotRegex = /new\s+TelegramBot\([^)]+\)/g;
    if (mainScriptContent.match(newBotRegex)) {
        mainScriptContent = mainScriptContent.replace(newBotRegex, '// $&');
        modified = true;
    }

    // 5. Adiciona a nova linha de require no topo, se não existir
    const injectionLine = `const { sendNotification } = require('./telegramNotifier.js');`;
    if (!mainScriptContent.includes(injectionLine)) {
        mainScriptContent = injectionLine + '\n' + mainScriptContent;
        modified = true;
    }

    // 6. Se houve alguma modificação, escreve o novo conteúdo no ficheiro
    if (modified) {
        // Faz um backup do script principal antes de sobrescrever
        await ssh.execCommand(`cp ${mainScriptPath} ${mainScriptPath}.bak`).catch(() => console.log('Backup do script principal não pôde ser criado.'));
        const base64Content = Buffer.from(mainScriptContent).toString('base64');
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
        const errorMessage = error.response ? error.response.body.description : error.message;
        throw new Error(errorMessage || 'Erro desconhecido.');
    }
}

module.exports = { parseNotifications, updateEnvFile, getNotifierContent, injectNotifier, sendTestMessage };