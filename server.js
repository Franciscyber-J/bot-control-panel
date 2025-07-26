require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 10001;

// --- Configuração da Sessão com cookie-session ---
app.use(cookieSession({
    name: 'bcp-session',
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    // Em desenvolvimento, 'secure' deve ser false para funcionar com http://localhost
    secure: process.env.NODE_ENV === 'production' 
}));

// --- Middleware de Autenticação Baseado em Sessão ---
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

// --- Rotas das Páginas ---
app.get('/', (req, res) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Rotas da API de Autenticação ---
app.post('/api/login', (req, res) => {
    // [LOG DE DIAGNÓSTICO]
    console.log(`[${new Date().toISOString()}] Recebido pedido de login para a rota /api/login.`);
    
    const { username, password } = req.body;
    console.log(`[DIAGNÓSTICO] Tentativa de login com o utilizador: "${username}"`);

    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
        console.error('[ERRO CRÍTICO] Variáveis de ambiente ADMIN_USER ou ADMIN_PASSWORD não estão configuradas.');
        return res.status(500).json({ error: 'As credenciais de administrador não estão configuradas no servidor.' });
    }

    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        console.log(`[DIAGNÓSTICO] Autenticação bem-sucedida para "${username}". A criar sessão...`);
        req.session.isAuthenticated = true;
        req.session.user = username;
        return res.status(200).json({ message: 'Login bem-sucedido' });
    }
    
    console.log(`[DIAGNÓSTICO] Falha na autenticação para "${username}". Credenciais inválidas.`);
    res.status(401).json({ error: 'Credenciais inválidas' });
});

app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ message: 'Logout bem-sucedido' });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// --- Rotas da API do Painel (Protegidas) ---
const apiRouter = express.Router();
apiRouter.use(checkAuth);

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};

apiRouter.get('/bots/status', async (req, res) => {
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} jlist`;
        const result = await ssh.execCommand(command, { cwd: '/root' });
        if (result.code !== 0) throw new Error(result.stderr || 'Falha ao listar bots.');
        res.json(JSON.parse(result.stdout));
    } catch (error) {
        console.error("Erro na rota /api/bots/status:", error.message);
        res.status(500).json({ error: `Falha ao conectar ou executar o comando no servidor remoto. Detalhe: ${error.message}` });
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
        const command = `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} ${action} ${name}`;
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

apiRouter.post('/bots/add', async (req, res) => {
    const { name, scriptPath } = req.body;
    if (!name || !scriptPath) {
        return res.status(400).json({ error: 'Nome e caminho do script são obrigatórios.' });
    }
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} start ${scriptPath} --name ${name}`;
        const result = await ssh.execCommand(command, { cwd: '/root' });
        if (result.code !== 0) throw new Error(result.stderr || `Falha ao iniciar o bot '${name}'.`);
        res.json({ message: `Bot '${name}' adicionado e iniciado com sucesso.` });
    } catch (error) {
        console.error(`Erro ao adicionar o bot ${name}:`, error.message);
        res.status(500).json({ error: `Falha ao adicionar o bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.delete('/bots/delete/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} delete ${name}`;
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
        const command = `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} logs ${name} --lines 100 --nostream`;
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
            `${'/root/.nvm/versions/node/v18.20.8/bin/node'} ${'/root/.nvm/versions/node/v18.20.8/bin/pm2'} reload ${name}`
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