// ARQUIVO: server.js (COMPLETO E CORRIGIDO)

require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const url = require('url');

const apiRouter = require('./routes/bots'); // Importa as rotas refatoradas

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 10001;

app.set('trust proxy', 1);

const sessionParser = cookieSession({
    name: 'bcp-session',
    keys: [process.env.SESSION_SECRET || 'default-secret-key'],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
});

app.use(sessionParser);
app.use(cookieParser());

// Middleware de autenticação (aplicado agora dentro das rotas)
const checkAuth = (req, res, next) => {
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Não autorizado. Por favor, faça login.' });
    }
    res.redirect('/');
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
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

// Usa o router da API com o middleware de autenticação
app.use('/api', checkAuth, apiRouter);


// --- Lógica do WebSocket (movida para dentro do router para acesso a serviços) ---
// Para simplificar, mantemos o WebSocket aqui, mas passamos a função `getBotsStatus` para o router.
const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};
const NVM_PREFIX = 'source /root/.nvm/nvm.sh && ';
const dashboardClients = new Set();

async function getBotsStatus() {
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NVM_PREFIX}pm2 jlist`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) {
            console.error('Falha ao obter a lista de bots:', result.stderr);
            return [];
        }
        return JSON.parse(result.stdout);
    } catch (error) {
        console.error(`Falha ao buscar status dos bots. Detalhe: ${error.message}`);
        return [];
    } finally {
        if (ssh.connection) ssh.dispose();
    }
}
// Passa a função para as rotas, se necessário, ou a mantém aqui para o broadcast
apiRouter.getBotsStatus = getBotsStatus;
apiRouter.dashboardClients = dashboardClients;


async function broadcastStatus() {
    if (dashboardClients.size === 0) return;
    const status = await getBotsStatus();
    const message = JSON.stringify({ type: 'statusUpdate', data: status });
    dashboardClients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}
setInterval(broadcastStatus, 5000);
// Exporta a função para que as rotas possam chamar um broadcast após uma ação
apiRouter.broadcastStatus = broadcastStatus;


// --- Configuração do Upgrade do Servidor para WebSocket ---
server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
        if (!request.session || !request.session.isAuthenticated) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
});

wss.on('connection', (ws, request) => {
    const { pathname } = url.parse(request.url);
    
    if (pathname === '/ws/dashboard') {
        dashboardClients.add(ws);
        console.log('Cliente do dashboard conectado. Total:', dashboardClients.size);

        getBotsStatus().then(status => {
            ws.send(JSON.stringify({ type: 'statusUpdate', data: status }));
        });

        ws.on('close', () => {
            dashboardClients.delete(ws);
            console.log('Cliente do dashboard desconectado. Total:', dashboardClients.size);
        });
        return;
    }

    const logMatch = pathname.match(/^\/ws\/logs\/(.+)$/);
    if (logMatch) {
        const botName = logMatch[1];
        if (!botName) {
            ws.close(1008, 'Nome do bot não fornecido.');
            return;
        }

        console.log(`Cliente WebSocket conectado para os logs de: ${botName}`);
        const ssh = new NodeSSH();

        ssh.connect(sshConfig)
            .then(() => {
                ssh.execCommand(`${NVM_PREFIX}pm2 logs ${botName} --raw --lines 20`, {
                    onStdout: (chunk) => {
                        if (ws.readyState === ws.OPEN) ws.send(chunk.toString('utf8'));
                    },
                    onStderr: (chunk) => {
                        if (ws.readyState === ws.OPEN) ws.send(`[ERRO SSH]: ${chunk.toString('utf8')}`);
                    }
                });
            })
            .catch(err => {
                console.error(`Erro na conexão SSH ou comando para logs de ${botName}:`, err);
                if (ws.readyState === ws.OPEN) ws.close(1011, 'Erro no servidor ao iniciar o stream de logs.');
            });

        ws.on('close', () => {
            console.log(`Cliente WebSocket desconectado para os logs de: ${botName}`);
            if (ssh.connection) ssh.dispose();
        });
        return;
    }

    ws.close(1002, 'Endpoint WebSocket inválido.');
});

server.listen(PORT, () => {
    console.log(`Painel de Controlo de Bots a rodar na porta ${PORT}`);
});