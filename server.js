require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 10001;

// --- Configuração da Sessão com cookie-session ---
// Esta abordagem é segura e não requer um serviço externo como Redis.
app.use(cookieSession({
    name: 'bcp-session', // Nome do cookie
    keys: [process.env.SESSION_SECRET || 'uma-chave-secreta-muito-forte-e-dificil-de-adivinhar'], // Use uma variável de ambiente para isto!
    maxAge: 24 * 60 * 60 * 1000, // 24 horas de validade
    httpOnly: true, // Impede que o cookie seja acedido por JavaScript no frontend
    secure: process.env.NODE_ENV === 'production' // Garante que o cookie só seja enviado via HTTPS em produção
}));

// --- Middleware de Autenticação Baseado em Sessão ---
const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    // Se a chamada for para uma API, retorna erro. Se for para uma página, redireciona.
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
    const { username, password } = req.body;

    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        req.session.isAuthenticated = true;
        req.session.user = username;
        return res.status(200).json({ message: 'Login bem-sucedido' });
    }
    
    res.status(401).json({ error: 'Credenciais inválidas' });
});

app.post('/api/logout', (req, res) => {
    req.session = null; // Limpa a sessão
    res.status(200).json({ message: 'Logout bem-sucedido' });
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

// Anexe o router protegido ao prefixo /api
app.use('/api', apiRouter);

// O health check não precisa de autenticação, então fica de fora do apiRouter
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Painel de Controlo de Bots a rodar na porta ${PORT}`);
});