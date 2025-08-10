// ARQUIVO: routes/bots.js (COMPLETO E CORRIGIDO)

const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const notificationService = require('../services/notificationService');

const router = express.Router();

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};

const NVM_PREFIX = 'source /root/.nvm/nvm.sh && ';
const BASE_BOT_PATH = process.env.BASE_BOT_PATH || '/root';

// #################### ROTAS DE GESTÃO DE BOTS ####################

// ROTA CORRIGIDA PARA INICIAR O BOT NO DIRETÓRIO CORRETO
router.post('/bots/add-from-git', async (req, res) => {
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
        
        const scriptPath = path.posix.join(botDirectory, mainScript);
        outputLog += `> Script principal encontrado: ${scriptPath}\n\n`;

        outputLog += `> Iniciando o bot com PM2 no diretório correto...\n`;
        // ### CORREÇÃO PRINCIPAL APLICADA AQUI ###
        const pm2Result = await ssh.execCommand(`${NVM_PREFIX}pm2 start "${scriptPath}" --name "${name}" --cwd "${botDirectory}"`);
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

router.post('/bots/manage', async (req, res) => {
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

router.post('/bots/env/:name', async (req, res) => {
    const { name } = req.params;
    const { content, scriptPath } = req.body;
    if (!name || !content || !scriptPath) return res.status(400).json({ error: 'Faltam dados essenciais.' });

    const botDirectory = path.posix.dirname(scriptPath);
    const envPath = path.posix.join(botDirectory, '.env');
    const ssh = new NodeSSH();

    try {
        await ssh.connect(sshConfig);
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

router.post('/bots/update/:name', async (req, res) => {
    const { name } = req.params;
    const { scriptPath, gitUrl } = req.body;
    if (!name || !scriptPath || !gitUrl) return res.status(400).json({ error: 'Nome, caminho do script e URL do Git são obrigatórios.' });

    const botDirectory = path.posix.dirname(scriptPath);
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const commands = [
            `git -C "${botDirectory}" remote set-url origin ${gitUrl}`,
            `git -C "${botDirectory}" fetch origin`,
            `git -C "${botDirectory}" reset --hard origin/main`,
            `${NVM_PREFIX}npm --prefix "${botDirectory}" install`,
            `${NVM_PREFIX}pm2 reload "${name}"`
        ];

        let fullOutput = `Iniciando deploy para o bot '${name}' a partir de ${gitUrl}...\n\n`;
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

router.get('/bots/notifications/:name', async (req, res) => {
    const { name } = req.params;
    const { scriptPath } = req.query;
    if (!name || !scriptPath) return res.status(400).json({ error: 'Nome do bot e caminho do script são obrigatórios.' });

    const botDirectory = path.posix.dirname(scriptPath);
    const envPath = path.posix.join(botDirectory, '.env');
    const ssh = new NodeSSH();

    try {
        await ssh.connect(sshConfig);
        const checkResult = await ssh.execCommand(`test -f "${envPath}" && echo "exists"`);
        if (checkResult.code !== 0) return res.json({ notifications: [], notifierInjected: false });

        const envContentResult = await ssh.execCommand(`cat "${envPath}"`);
        if (envContentResult.code !== 0) throw new Error(envContentResult.stderr);
        const notifications = notificationService.parseNotifications(envContentResult.stdout);
        
        const mainScriptContentResult = await ssh.execCommand(`cat "${scriptPath}"`);
        const mainScriptContent = mainScriptContentResult.stdout;
        const notifierInjected = mainScriptContent.includes("require('./telegramNotifier.js')");

        res.json({ notifications, notifierInjected });

    } catch (error) {
        res.status(500).json({ error: `Falha ao ler as configurações de notificação. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

router.post('/bots/notifications/:name', async (req, res) => {
    const { name } = req.params;
    const { scriptPath, notification } = req.body;
    if (!name || !scriptPath || !notification) return res.status(400).json({ error: 'Dados incompletos.' });

    const botDirectory = path.posix.dirname(scriptPath);
    const envPath = path.posix.join(botDirectory, '.env');
    const ssh = new NodeSSH();

    try {
        await ssh.connect(sshConfig);
        
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

router.post('/bots/notifications/test', async (req, res) => {
    const { token, chatId, message } = req.body;
    if (!token || !chatId) return res.status(400).json({ error: 'Token e Chat ID são obrigatórios.' });
    try {
        await notificationService.sendTestMessage(token, chatId, message || 'Mensagem de teste do Painel de Controlo de Bots.');
        res.json({ message: 'Mensagem de teste enviada com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: `Falha ao enviar mensagem de teste. Detalhe: ${error.message}` });
    }
});

router.post('/bots/inject-notifier/:name', async (req, res) => {
    const { name } = req.params;
    const { scriptPath } = req.body;
    if (!name || !scriptPath) return res.status(400).json({ error: 'Nome do bot e caminho do script são obrigatórios.' });

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        
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