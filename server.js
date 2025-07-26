require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const basicAuth = require('basic-auth');

const app = express();
const PORT = process.env.PORT || 10001;

// --- Configuração de Segurança ---
const auth = (req, res, next) => {
    const user = basicAuth(req);
    if (!user || user.name !== process.env.ADMIN_USER || user.pass !== process.env.ADMIN_PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="Bot Control Panel"');
        return res.status(401).send('Authentication required.');
    }
    return next();
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Configuração da Conexão SSH ---
const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    // Adicionamos um timeout para evitar que a conexão fique pendurada indefinidamente
    readyTimeout: 20000 
};

// #################### ARQUITETURA DA CORREÇÃO ####################
// A lógica de conexão SSH foi movida para dentro de cada rota.
// Cada pedido de API agora cria, usa e destrói a sua própria conexão de forma isolada e segura.
// Isto previne os erros de ECONNRESET ao não reutilizar ou manter conexões abertas de forma inadequada.
// #################################################################

// --- Rotas da API ---

// Rota para obter o status de todos os bots
app.get('/api/bots/status', auth, async (req, res) => {
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        
        const nodePath = '/root/.nvm/versions/node/v18.20.8/bin/node';
        const pm2Path = '/root/.nvm/versions/node/v18.20.8/bin/pm2';
        const command = `${nodePath} ${pm2Path} jlist`;

        const result = await ssh.execCommand(command, { cwd: '/root' });

        if (result.code !== 0) {
            // Se houver erro, o stderr é mais informativo
            throw new Error(result.stderr || 'O comando `pm2 jlist` falhou no servidor remoto.');
        }

        res.json(JSON.parse(result.stdout));

    } catch (error) {
        console.error("Erro na rota /api/bots/status:", error.message);
        res.status(500).json({ error: `Falha ao conectar ou executar o comando no servidor remoto. Detalhe: ${error.message}` });
    } finally {
        // Garante que a conexão seja sempre fechada
        if (ssh.connection) {
            ssh.dispose();
        }
    }
});

// Rota para gerir um bot específico (start, stop, restart)
app.post('/api/bots/manage', auth, async (req, res) => {
    const { name, action } = req.body;
    if (!name || !['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Ação ou nome de bot inválido.' });
    }

    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);

        const nodePath = '/root/.nvm/versions/node/v18.20.8/bin/node';
        const pm2Path = '/root/.nvm/versions/node/v18.20.8/bin/pm2';
        const command = `${nodePath} ${pm2Path} ${action} ${name}`;

        const result = await ssh.execCommand(command, { cwd: '/root' });

        if (result.code !== 0) {
            throw new Error(result.stderr || `O comando \`pm2 ${action} ${name}\` falhou.`);
        }
        
        res.json({ message: `Ação '${action}' executada com sucesso para o bot '${name}'.`, output: result.stdout });

    } catch (error) {
        console.error(`Erro na rota /api/bots/manage para ${name}:`, error.message);
        res.status(500).json({ error: `Falha ao executar a ação '${action}' no bot '${name}'. Detalhe: ${error.message}` });
    } finally {
        // Garante que a conexão seja sempre fechada
        if (ssh.connection) {
            ssh.dispose();
        }
    }
});

// --- Rota Principal ---
app.get('/', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Bot Control Panel a rodar em http://localhost:${PORT}`);
});