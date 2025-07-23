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
        
        // #################### INÍCIO DA CORREÇÃO ####################
        // ARQUITETO: Definimos o caminho completo para o Node.js e para o PM2.
        // O comando agora executa o 'node' e passa o script do 'pm2' como argumento.
        const nodePath = '/root/.nvm/versions/node/v18.20.8/bin/node';
        const pm2Path = '/root/.nvm/versions/node/v18.20.8/bin/pm2';
        const fullCommand = `${nodePath} ${pm2Path} ${command}`;
        // ##################### FIM DA CORREÇÃO ######################

        const result = await ssh.execCommand(fullCommand, { cwd: '/root' });
        ssh.dispose();
        if (result.code !== 0) {
            // Se houver erro, o stderr é mais informativo
            throw new Error(result.stderr || 'O comando falhou sem uma saída de erro específica.');
        }
        return result.stdout;
    } catch (error) {
        console.error("Erro SSH:", error.message);
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
        const result = await executeRemoteCommand('jlist');
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
        const result = await executeRemoteCommand(`${action} ${name}`);
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