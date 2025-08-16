// ARQUIVO: routes/bots.js (COM LEITURA DE FINALIDADES E ATUALIZAÇÃO DE BRANCH DINÂMICA)

console.log('--- [BCP INFO] Ficheiro routes/bots.js carregado. Versão: 7.3 ---');

const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const notificationService = require('../services/notificationService');

const router = express.Router();
const jsonParser = express.json();

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};

const NVM_PREFIX = 'source /root/.nvm/nvm.sh && ';
const BASE_BOT_PATH = process.env.BASE_BOT_PATH || '/root';

// Função auxiliar para encontrar o caminho do script principal de um bot
async function findBotScriptPath(ssh, botName) {
    const pm2ListResult = await ssh.execCommand(`${NVM_PREFIX}pm2 jlist`);
    if (pm2ListResult.code !== 0 || !pm2ListResult.stdout) {
        throw new Error(`Falha ao obter a lista de processos do PM2: ${pm2ListResult.stderr}`);
    }
    const bots = JSON.parse(pm2ListResult.stdout);
    const botInfo = bots.find(b => b.name === botName);

    if (!botInfo || !botInfo.pm2_env || !botInfo.pm2_env.pm_cwd) {
        throw new Error(`Não foi possível encontrar o diretório de trabalho (pm_cwd) para o bot '${botName}' no PM2.`);
    }
    const botDirectory = botInfo.pm2_env.pm_cwd;

    const packageJsonPath = path.posix.join(botDirectory, 'package.json');
    const catResult = await ssh.execCommand(`cat "${packageJsonPath}"`);
    if (catResult.code !== 0) {
        throw new Error(`Não foi possível ler o package.json em ${packageJsonPath}: ${catResult.stderr}`);
    }
    const packageJson = JSON.parse(catResult.stdout);
    const mainScript = packageJson.main || (packageJson.scripts && packageJson.scripts.start ? packageJson.scripts.start.split(' ').pop() : null);
    if (!mainScript) {
        throw new Error('Não foi possível encontrar a entrada "main" ou "scripts.start" no package.json do bot.');
    }
    
    return path.posix.join(botDirectory, mainScript);
}


// #################### ROTAS DE GESTÃO DE BOTS ####################

router.post('/bots/add-from-git', jsonParser, async (req, res) => {
    const { gitUrl, name, envContent } = req.body;
    if (!gitUrl || !name || !envContent) {
        return res.status(400).json({ error: 'URL do Git, Nome do Bot e Ficheiro .env são obrigatórios.' });
    }

    const botDirectory = path.posix.join(BASE_BOT_PATH, name);
    const ssh = new NodeSSH();

    try {
        await ssh.connect(sshConfig);
        let outputLog = `Iniciando deploy do novo bot '${name}' a partir de ${gitUrl}...\n\n`;

        outputLog += `> Clonando repositório para ${botDirectory}...\n`;
        const cloneResult = await ssh.execCommand(`git clone ${gitUrl} "${botDirectory}"`);
        if (cloneResult.code !== 0) throw new Error(`Falha ao clonar o repositório: ${cloneResult.stderr}`);
        outputLog += cloneResult.stdout + '\n\n';

        outputLog += `> Escrevendo ficheiro .env no servidor...\n`;
        const envPath = path.posix.join(botDirectory, '.env');
        const base64Content = Buffer.from(envContent).toString('base64');
        const writeResult = await ssh.execCommand(`echo ${base64Content} | base64 --decode > "${envPath}"`);
        if (writeResult.code !== 0) throw new Error(`Falha ao escrever o ficheiro .env: ${writeResult.stderr}`);
        outputLog += `Ficheiro .env enviado com sucesso.\n\n`;

        outputLog += `> Instalando dependências com npm...\n`;
        const npmResult = await ssh.execCommand(`${NVM_PREFIX}npm install --prefix "${botDirectory}"`);
        if (npmResult.code !== 0) throw new Error(`Falha ao instalar dependências: ${npmResult.stderr}`);
        outputLog += npmResult.stdout + '\n\n';

        outputLog += `> Lendo package.json para encontrar o script principal...\n`;
        const packageJsonPath = path.posix.join(botDirectory, 'package.json');
        const catResult = await ssh.execCommand(`cat "${packageJsonPath}"`);
        if (catResult.code !== 0) throw new Error(`Não foi possível ler o package.json: ${catResult.stderr}`);
        
        const packageJson = JSON.parse(catResult.stdout);
        const mainScript = packageJson.main || (packageJson.scripts && packageJson.scripts.start ? packageJson.scripts.start.split(' ').pop() : null);
        if (!mainScript) throw new Error('Não foi possível encontrar a entrada "main" ou "scripts.start" no package.json.');
        
        outputLog += `> Script principal encontrado: ${mainScript}\n\n`;

        outputLog += `> Iniciando o bot com PM2 (replicando os passos manuais)...\n`;
        const pm2Command = `cd "${botDirectory}" && ${NVM_PREFIX}pm2 start ${mainScript} --name "${name}"`;
        const pm2Result = await ssh.execCommand(pm2Command);
        if (pm2Result.code !== 0) throw new Error(`Falha ao iniciar o bot com PM2: ${pm2Result.stderr}`);
        outputLog += pm2Result.stdout + '\n\n';

        outputLog += `Bot '${name}' adicionado e iniciado com sucesso!`;
        res.json({ message: outputLog });
        if (router.broadcastStatus) await router.broadcastStatus();

    } catch (error) {
        if (ssh.connection) {
            await ssh.execCommand(`rm -rf "${botDirectory}"`);
        }
        res.status(500).json({ error: `Falha ao adicionar o bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.post('/bots/manage', jsonParser, async (req, res) => {
    const { name, action } = req.body;
    if (!name || !['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Ação ou nome de bot inválido.' });
    }
    
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NVM_PREFIX}pm2 ${action} "${name}"`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || `O comando \`pm2 ${action} ${name}\` falhou.`);
        
        res.json({ message: `Ação '${action}' executada com sucesso para o bot '${name}'.` });
        if (router.broadcastStatus) await router.broadcastStatus();
    } catch (error) {
        res.status(500).json({ error: `Falha ao executar a ação '${action}' no bot '${name}'. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.post('/bots/env/:name', jsonParser, async (req, res) => {
    const { name } = req.params;
    const { content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Faltam dados essenciais.' });

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const scriptPath = await findBotScriptPath(ssh, name);
        const botDirectory = path.posix.dirname(scriptPath);
        const envPath = path.posix.join(botDirectory, '.env');

        const base64Content = Buffer.from(content).toString('base64');
        const writeCommand = `echo ${base64Content} | base64 --decode > "${envPath}"`;
        const writeResult = await ssh.execCommand(writeCommand);
        if (writeResult.code !== 0) throw new Error(writeResult.stderr || 'Falha ao escrever o ficheiro .env no servidor.');

        const reloadCommand = `${NVM_PREFIX}pm2 reload "${name}"`;
        const reloadResult = await ssh.execCommand(reloadCommand);
        if (reloadResult.code !== 0) throw new Error(reloadResult.stderr || `Ficheiro .env atualizado, mas falha ao reiniciar o bot '${name}'.`);
        
        res.json({ message: `Ficheiro .env para o bot '${name}' atualizado e bot reiniciado com sucesso.` });
        if (router.broadcastStatus) await router.broadcastStatus();
    } catch (error) {
        res.status(500).json({ error: `Falha ao atualizar o ficheiro .env. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.delete('/bots/delete/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NVM_PREFIX}pm2 delete "${name}"`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || `Falha ao excluir o bot '${name}'.`);
        
        res.json({ message: `Bot '${name}' parado e excluído com sucesso.` });
        if (router.broadcastStatus) await router.broadcastStatus();
    } catch (error) {
        res.status(500).json({ error: `Falha ao excluir o bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.get('/bots/logs/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NVM_PREFIX}pm2 logs "${name}" --lines 100 --nostream`;
        const result = await ssh.execCommand(command);
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
        res.json({ logs: result.stdout || 'Nenhum log disponível.' });
    } catch (error) {
        res.status(500).json({ error: `Falha ao buscar logs do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.post('/bots/update/:name', jsonParser, async (req, res) => {
    const { name } = req.params;
    const { gitUrl } = req.body;
    if (!name || !gitUrl) {
        return res.status(400).json({ error: 'Nome do bot e URL do Git são obrigatórios.' });
    }

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        
        let fullOutput = `Iniciando deploy para o bot '${name}' a partir de ${gitUrl}...\n\n`;

        const scriptPath = await findBotScriptPath(ssh, name);
        const botDirectory = path.posix.dirname(scriptPath);
        fullOutput += `> Diretório de trabalho encontrado: ${botDirectory}\n\n`;

        fullOutput += `> Verificando a branch principal do repositório...\n`;
        const findBranchCmd = `git -C "${botDirectory}" symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`;
        const findBranchResult = await ssh.execCommand(findBranchCmd);

        if (findBranchResult.code !== 0 || !findBranchResult.stdout.trim()) {
            throw new Error(`Não foi possível determinar a branch principal. Verifique o repositório. Saída: ${findBranchResult.stderr}`);
        }
        const mainBranch = findBranchResult.stdout.trim();
        fullOutput += `> Branch principal encontrada: ${mainBranch}\n\n`;

        const commands = [
            `git -C "${botDirectory}" remote set-url origin ${gitUrl}`,
            `git -C "${botDirectory}" fetch origin`,
            `git -C "${botDirectory}" reset --hard origin/${mainBranch}`,
            `${NVM_PREFIX}npm --prefix "${botDirectory}" install`,
            `${NVM_PREFIX}pm2 reload "${name}"`
        ];

        for (const command of commands) {
            fullOutput += `> Executando: ${command}\n`;
            const result = await ssh.execCommand(command);
            if (result.code !== 0) {
                fullOutput += `ERRO:\n${result.stderr}`;
                throw new Error(`O comando '${command}' falhou:\n${result.stderr}`);
            }
            fullOutput += `${result.stdout}\n\n`;
        }
        res.json({ message: `Deploy do bot '${name}' concluído com sucesso.`, output: fullOutput });
        if (router.broadcastStatus) await router.broadcastStatus();
    } catch (error) {
        res.status(500).json({ error: `Falha no deploy do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

// #################### ROTAS DE NOTIFICAÇÕES ####################

router.post('/bots/notifications/test', jsonParser, async (req, res) => {
    const { token, chatId, message } = req.body;
    if (!token || !chatId) {
        return res.status(400).json({ error: 'Token ou Chat ID não recebidos pelo servidor.' });
    }
    try {
        await notificationService.sendTestMessage(token, chatId, message || 'Mensagem de teste do Painel de Controlo de Bots.');
        res.json({ message: 'Mensagem de teste enviada com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: `Falha ao enviar mensagem de teste. Detalhe: ${error.message}` });
    }
});

// ### ROTA ATUALIZADA PARA LER AS FINALIDADES DO CÓDIGO ###
router.get('/bots/notifications/:name', async (req, res) => {
    const { name } = req.params;
    if (!name) return res.status(400).json({ error: 'Nome do bot é obrigatório.' });
    
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const scriptPath = await findBotScriptPath(ssh, name);
        const botDirectory = path.posix.dirname(scriptPath);
        const envPath = path.posix.join(botDirectory, '.env');

        const checkResult = await ssh.execCommand(`test -f "${envPath}" && echo "exists"`);
        let notifications = [];
        if (checkResult.code === 0) {
            const envContentResult = await ssh.execCommand(`cat "${envPath}"`);
            if (envContentResult.code !== 0) throw new Error(envContentResult.stderr);
            notifications = notificationService.parseNotifications(envContentResult.stdout);
        }
        
        const mainScriptContentResult = await ssh.execCommand(`cat "${scriptPath}"`);
        const mainScriptContent = mainScriptContentResult.stdout;
        const notifierInjected = mainScriptContent.includes("require('./telegramNotifier.js')");

        // Extrai as finalidades do código
        const foundPurposes = [...mainScriptContent.matchAll(/sendNotification\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
        const uniquePurposes = [...new Set(foundPurposes)];

        res.json({ notifications, notifierInjected, foundPurposes: uniquePurposes });

    } catch (error) {
        res.status(500).json({ error: `Falha ao ler as configurações de notificação. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.post('/bots/notifications/:name', jsonParser, async (req, res) => {
    const { name } = req.params;
    const { notification } = req.body;
    if (!name || !notification) return res.status(400).json({ error: 'Dados incompletos.' });

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const scriptPath = await findBotScriptPath(ssh, name);
        const botDirectory = path.posix.dirname(scriptPath);
        const envPath = path.posix.join(botDirectory, '.env');
        
        await ssh.execCommand(`cp "${envPath}" "${envPath}.bak"`).catch(() => console.log('Backup do .env não pôde ser criado.'));
        
        const envContentResult = await ssh.execCommand(`cat "${envPath}"`).catch(() => ({ stdout: '' }));
        let envContent = notificationService.updateEnvFile(envContentResult.stdout, notification);
        
        const base64Content = Buffer.from(envContent).toString('base64');
        await ssh.execCommand(`echo ${base64Content} | base64 --decode > "${envPath}"`);
        
        await notificationService.injectNotifier(ssh, scriptPath);
        
        const reloadCommand = `${NVM_PREFIX}pm2 reload "${name}"`;
        const reloadResult = await ssh.execCommand(reloadCommand);
        if (reloadResult.code !== 0) throw new Error(reloadResult.stderr || `Configuração salva, mas falha ao reiniciar o bot '${name}'.`);

        res.json({ message: 'Notificação salva e bot reiniciado com sucesso.' });
        if (router.broadcastStatus) await router.broadcastStatus();

    } catch (error) {
        await ssh.execCommand(`cp "${envPath}.bak" "${envPath}"`).catch(() => {});
        res.status(500).json({ error: `Falha ao salvar a notificação. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.delete('/bots/notifications/:name/:notificationId', async (req, res) => {
    const { name, notificationId } = req.params;
    if (!name || !notificationId) return res.status(400).json({ error: 'Dados incompletos para remoção.' });

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const scriptPath = await findBotScriptPath(ssh, name);
        const botDirectory = path.posix.dirname(scriptPath);
        const envPath = path.posix.join(botDirectory, '.env');
        
        await ssh.execCommand(`cp "${envPath}" "${envPath}.bak"`).catch(() => console.log('Backup do .env não pôde ser criado.'));
        
        const envContentResult = await ssh.execCommand(`cat "${envPath}"`);
        if (envContentResult.code !== 0) throw new Error('Não foi possível ler o ficheiro .env para remover a notificação.');

        let envContent = notificationService.removeNotificationFromEnv(envContentResult.stdout, notificationId);

        const base64Content = Buffer.from(envContent).toString('base64');
        await ssh.execCommand(`echo ${base64Content} | base64 --decode > "${envPath}"`);

        const reloadCommand = `${NVM_PREFIX}pm2 reload "${name}"`;
        await ssh.execCommand(reloadCommand);

        res.json({ message: 'Notificação removida e bot reiniciado com sucesso.' });
        if (router.broadcastStatus) await router.broadcastStatus();

    } catch (error) {
        await ssh.execCommand(`cp "${envPath}.bak" "${envPath}"`).catch(() => {});
        res.status(500).json({ error: `Falha ao remover a notificação. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});


router.post('/bots/inject-notifier/:name', jsonParser, async (req, res) => {
    const { name } = req.params;
    if (!name) return res.status(400).json({ error: 'Nome do bot é obrigatório.' });

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const scriptPath = await findBotScriptPath(ssh, name);
        
        await notificationService.injectNotifier(ssh, scriptPath);
        
        const reloadCommand = `${NVM_PREFIX}pm2 reload "${name}"`;
        await ssh.execCommand(reloadCommand);

        res.json({ message: `Correção aplicada com sucesso! A linha de código foi injetada e o bot '${name}' foi reiniciado.` });
        if (router.broadcastStatus) await router.broadcastStatus();

    } catch (error) {
        res.status(500).json({ error: `Falha ao aplicar a correção. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

module.exports = router;