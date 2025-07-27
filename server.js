require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 10001;

app.set('trust proxy', 1);

app.use(cookieSession({
    name: 'bcp-session',
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
}));

const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Não autorizado. Por favor, faça login.' });
    }
    res.redirect('/'); 
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'As credenciais de administrador não estão configuradas no servidor.' });
    }
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        req.session.isAuthenticated = true;
        req.session.user = username;
        return res.status(200).json({ message: 'Login bem-sucedido' });
    }
    res.status(401).json({ error: 'Credenciais inválidas' });
});

app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ message: 'Logout bem-sucedido' });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

const apiRouter = express.Router();
apiRouter.use(checkAuth);

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};

// Caminhos absolutos para os executáveis no servidor Hostinger
const NODE_PATH = '/root/.nvm/versions/node/v18.20.8/bin/node';
const PM2_PATH = '/root/.nvm/versions/node/v18.20.8/bin/pm2';

apiRouter.get('/bots/status', async (req, res) => {
    const ssh = new NodeSSH();
    const BOTS_DIRECTORY = '/root/bots';
    const performDiscovery = req.query.discover === 'true';

    try {
        await ssh.connect(sshConfig);

        if (performDiscovery) {
            console.log('Executando rotina de descoberta de novos bots...');
            const pm2ListResult = await ssh.execCommand(`${PM2_PATH} jlist`);
            if (pm2ListResult.code !== 0) throw new Error(pm2ListResult.stderr || 'Falha ao executar pm2 jlist.');
            const managedBots = JSON.parse(pm2ListResult.stdout);
            const managedBotNames = managedBots.map(bot => bot.name);

            const dirListResult = await ssh.execCommand(`ls ${BOTS_DIRECTORY}`);
            if (dirListResult.code !== 0) throw new Error(`Não foi possível listar o diretório ${BOTS_DIRECTORY}.`);
            const potentialBotNames = dirListResult.stdout.split('\n').filter(Boolean);

            const newBotsToStart = potentialBotNames.filter(name => !managedBotNames.includes(name));

            if (newBotsToStart.length > 0) {
                console.log(`Novos bots encontrados: ${newBotsToStart.join(', ')}. A iniciar...`);
                for (const botName of newBotsToStart) {
                    const scriptPath = `${BOTS_DIRECTORY}/${botName}/index.js`;
                    const startCommand = `${PM2_PATH} start ${scriptPath} --name ${botName}`;
                    await ssh.execCommand(startCommand);
                }
            }
        }

        const finalListResult = await ssh.execCommand(`${PM2_PATH} jlist`);
        if (finalListResult.code !== 0) throw new Error(finalListResult.stderr || 'Falha ao obter a lista final de bots.');
        
        res.json(JSON.parse(finalListResult.stdout));

    } catch (error) {
        console.error("Erro na rota de status:", error.message);
        res.status(500).json({ error: `Falha na rota de status. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.post('/bots/manage', async (req, res) => {
    const { name, action } = req.body;
    if (!name || !['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Ação ou nome de bot inválido.' });
    }
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${PM2_PATH} ${action} ${name}`;
        const result = await ssh.execCommand(command, { cwd: '/root' });
        if (result.code !== 0) throw new Error(result.stderr || `O comando \`pm2 ${action} ${name}\` falhou.`);
        res.json({ message: `Ação '${action}' executada com sucesso para o bot '${name}'.` });
    } catch (error) {
        console.error(`Erro na rota /api/bots/manage para ${name}:`, error.message);
        res.status(500).json({ error: `Falha ao executar a ação '${action}' no bot '${name}'. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.delete('/bots/delete/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${PM2_PATH} delete ${name}`;
        const result = await ssh.execCommand(command, { cwd: '/root' });
        if (result.code !== 0) throw new Error(result.stderr || `Falha ao excluir o bot '${name}'.`);
        res.json({ message: `Bot '${name}' parado e excluído com sucesso.` });
    } catch (error) {
        console.error(`Erro ao excluir o bot ${name}:`, error.message);
        res.status(500).json({ error: `Falha ao excluir o bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.get('/bots/logs/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${PM2_PATH} logs ${name} --lines 100 --nostream`;
        const result = await ssh.execCommand(command, { cwd: '/root' });
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
        res.json({ logs: result.stdout || 'Nenhum log disponível.' });
    } catch (error) {
        console.error(`Erro ao buscar logs para o bot ${name}:`, error.message);
        res.status(500).json({ error: `Falha ao buscar logs do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.post('/bots/update/:name', async (req, res) => {
    const { name } = req.params;
    const botData = req.body.scriptPath;
    if (!name || !botData) {
        return res.status(400).json({ error: 'Nome e caminho do script do bot são obrigatórios.' });
    }
    const botDirectory = path.dirname(botData);
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const commands = [
            'git pull',
            'npm install',
            `${PM2_PATH} reload ${name}`
        ];
        let fullOutput = `Iniciando deploy para o bot '${name}' no diretório '${botDirectory}'...\n\n`;
        for (const command of commands) {
            fullOutput += `> Executando: ${command}\n`;
            const result = await ssh.execCommand(command, { cwd: botDirectory });
            if (result.code !== 0) {
                fullOutput += `ERRO:\n${result.stderr}`;
                throw new Error(`O comando '${command}' falhou:\n${result.stderr}`);
            }
            fullOutput += `${result.stdout}\n\n`;
        }
        res.json({ message: `Deploy do bot '${name}' concluído com sucesso.`, output: fullOutput });
    } catch (error) {
        console.error(`Erro no deploy do bot ${name}:`, error.message);
        res.status(500).json({ error: `Falha no deploy do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

app.use('/api', apiRouter);

app.listen(PORT, () => {
    console.log(`Painel de Controlo de Bots a rodar na porta ${PORT}`);
});