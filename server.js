require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const basicAuth = require('basic-auth');

const app = express();
const ssh = new NodeSSH();
const PORT = process.env.PORT || 10001;

// --- Configuração de Segurança ---
const auth = (req, res, next) => {
    const user = basicAuth(req);
    if (!user || user.name !== process.env.ADMIN_USER || user.pass !== process.env.ADMIN_PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="example"');
        return res.status(401).send('Authentication required.');
    }
    return next();
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Conexão SSH ---
const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
};

// Função para executar comandos remotos
async function executeRemoteCommand(command) {
    try {
        await ssh.connect(sshConfig);
        const result = await ssh.execCommand(command, { cwd: '/root' });
        ssh.dispose();
        if (result.code !== 0) {
            throw new Error(result.stderr);
        }
        return result.stdout;
    } catch (error) {
        console.error("Erro SSH:", error);
        // Garante que a conexão seja fechada em caso de erro
        if (ssh.connection) {
            ssh.dispose();
        }
        throw error;
    }
}

// --- Rotas da API ---
app.get('/api/bots/status', auth, async (req, res) => {
    try {
        const result = await executeRemoteCommand('pm2 jlist');
        res.json(JSON.parse(result));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bots/manage', auth, async (req, res) => {
    const { name, action } = req.body;
    if (!name || !['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Ação ou nome inválido.' });
    }
    try {
        const result = await executeRemoteCommand(`pm2 ${action} ${name}`);
        res.json({ message: `Ação '${action}' executada com sucesso para '${name}'.`, output: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Rota Principal ---
app.get('/', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Bot Control Panel a rodar em http://localhost:${PORT}`);
});