// ARQUIVO: server.js (COMPLETO E CORRIGIDO - V4)

require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const url = require('url');
const nodemailer = require('nodemailer');

const apiRouter = require('./routes/bots');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 10001;
const NVM_PREFIX = 'source /root/.nvm/nvm.sh && ';

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

const checkAuth = (req, res, next) => {
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Não autorizado. Por favor, faça login.' });
    }
    res.redirect('/');
};

// ### CORREÇÃO ###
// O middleware express.json() foi removido daqui para ser colocado
// diretamente no ficheiro de rotas (routes/bots.js).
// Isto garante que ele é aplicado apenas onde é necessário e evita conflitos.

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

app.post('/api/login', express.json(), (req, res) => { // Adicionado parser aqui para a rota de login
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

app.post('/api/forgot-password', async (req, res) => {
    const { ADMIN_USER, ADMIN_PASSWORD, EMAIL_USER, EMAIL_PASS } = process.env;
    if (!ADMIN_USER || !ADMIN_PASSWORD || !EMAIL_USER || !EMAIL_PASS) {
        return res.status(500).json({ error: 'Funcionalidade de recuperação não configurada no servidor.' });
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS,
        },
    });

    const mailOptions = {
        from: `"Painel de Controlo de Bots" <${EMAIL_USER}>`,
        to: 'francisjuniocosta@gmail.com',
        subject: 'Recuperação de Credenciais - Painel de Controlo de Bots',
        html: `
            <div style="font-family: sans-serif; padding: 20px; color: #333;">
                <h2>Recuperação de Credenciais</h2>
                <p>Olá, foi solicitada a recuperação das suas credenciais de acesso ao Painel de Controlo de Bots.</p>
                <ul>
                    <li><strong>Utilizador:</strong> ${ADMIN_USER}</li>
                    <li><strong>Palavra-passe:</strong> ${ADMIN_PASSWORD}</li>
                </ul>
                <p>Recomenda-se que apague este e-mail após guardar as credenciais em local seguro.</p>
                <hr>
                <p style="font-size: 0.8em; color: #888;">Se não solicitou esta recuperação, por favor ignore este e-mail.</p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'As suas credenciais foram enviadas para o e-mail de recuperação.' });
    } catch (error) {
        console.error("Erro ao enviar e-mail de recuperação:", error);
        res.status(500).json({ error: 'Falha ao enviar o e-mail de recuperação.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ message: 'Logout bem-sucedido' });
});

app.use('/api', checkAuth, apiRouter);

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};
const dashboardClients = new Set();

async function getBotsStatus(sshInstance) {
    const ssh = sshInstance || new NodeSSH();
    const shouldDispose = !sshInstance;
    try {
        if (!ssh.connection) await ssh.connect(sshConfig);
        const command = `${NVM_PREFIX}pm2 jlist`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) {
            console.error('Falha ao obter a lista de bots:', result.stderr);
            return []; // Retorna array vazio em caso de erro para não quebrar a lógica seguinte
        }
        // Se stdout estiver vazio, pm2 pode não ter processos, retorna array vazio
        if (!result.stdout) return [];
        return JSON.parse(result.stdout);
    } catch (error) {
        console.error(`Falha ao buscar status dos bots: ${error.message}`);
        return [];
    } finally {
        if (shouldDispose && ssh.connection) ssh.dispose();
    }
}

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
        getBotsStatus().then(status => {
            ws.send(JSON.stringify({ type: 'statusUpdate', data: status }));
        });

        ws.on('message', async (message) => {
            try {
                const parsedMessage = JSON.parse(message);
                if (parsedMessage.type === 'resetSession') {
                    await handleResetSession(ws, parsedMessage.data);
                }
            } catch (e) {
                ws.send(JSON.stringify({ type: 'error', message: 'Mensagem inválida.' }));
            }
        });

        ws.on('close', () => {
            dashboardClients.delete(ws);
        });
        return;
    }

    const logMatch = pathname.match(/^\/ws\/logs\/(.+)$/);
    if (logMatch) {
        const botName = logMatch[1];
        if (!botName) return ws.close(1008, 'Nome do bot não fornecido.');

        const ssh = new NodeSSH();
        ssh.connect(sshConfig).then(() => {
            ssh.execCommand(`${NVM_PREFIX}pm2 logs ${botName} --raw --lines 20`, {
                onStdout: (chunk) => ws.readyState === ws.OPEN && ws.send(chunk.toString('utf8')),
                onStderr: (chunk) => ws.readyState === ws.OPEN && ws.send(`[ERRO SSH]: ${chunk.toString('utf8')}`)
            });
        }).catch(err => ws.readyState === ws.OPEN && ws.close(1011, 'Erro no servidor ao iniciar o stream de logs.'));

        ws.on('close', () => ssh.connection && ssh.dispose());
        return;
    }

    ws.close(1002, 'Endpoint WebSocket inválido.');
});

async function handleResetSession(ws, data) {
    const { name, scriptPath } = data; // scriptPath é o caminho completo para o script principal
    const sendProgress = (message) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'progress', message: `[PAINEL] ${message}` }));
        }
    };
    
    const ssh = new NodeSSH();
    const botDirectory = path.posix.dirname(scriptPath);
    const mainScript = path.posix.basename(scriptPath);

    try {
        await ssh.connect(sshConfig);
        sendProgress(`Iniciando procedimento para gerar novo QR Code para '${name}'...`);

        // PASSO 1: Parar e apagar o processo da lista do PM2 para limpar a configuração antiga.
        // Isto NÃO apaga os ficheiros do bot.
        sendProgress(`A parar e a remover o processo '${name}' do PM2 para limpar a configuração...`);
        const deleteResult = await ssh.execCommand(`${NVM_PREFIX}pm2 delete ${name}`);
        // Ignoramos o erro se o processo não existir, o que é aceitável.
        if (deleteResult.code !== 0 && !deleteResult.stderr.includes('not found')) {
            throw new Error(`Falha ao remover o processo do PM2: ${deleteResult.stderr}`);
        }
        sendProgress(`Processo removido da lista do PM2 com sucesso.`);
        
        // PASSO 2: Apagar a pasta de sessão para forçar a regeneração do QR Code.
        sendProgress(`A apagar a pasta de sessão .wwebjs_auth...`);
        const sessionPath = path.posix.join(botDirectory, '.wwebjs_auth');
        const rmResult = await ssh.execCommand(`rm -rf "${sessionPath}"`);
        if(rmResult.code !== 0){
             throw new Error(`Falha ao executar o comando para apagar a pasta de sessão: ${rmResult.stderr}`);
        }
        sendProgress(`Pasta de sessão apagada.`);

        // PASSO 3: Iniciar o bot novamente, mas da maneira correta, replicando os passos manuais.
        sendProgress(`A iniciar o bot novamente com o diretório de trabalho correto...`);
        const pm2Command = `cd "${botDirectory}" && ${NVM_PREFIX}pm2 start ${mainScript} --name "${name}"`;
        const pm2Result = await ssh.execCommand(pm2Command);
        if (pm2Result.code !== 0) {
            throw new Error(`Falha ao iniciar o bot com PM2: ${pm2Result.stderr}`);
        }
        
        sendProgress(`\nPROCESSO CONCLUÍDO COM SUCESSO!`);
        sendProgress(`O bot '${name}' foi reiniciado corretamente.`);
        sendProgress(`Por favor, observe os logs para ler o novo QR Code.`);

    } catch (error) {
        sendProgress(`\nERRO: ${error.message}`);
        sendProgress(`Ocorreu um erro. A tentar restaurar o bot...`);
        // Tenta iniciar o bot novamente em caso de falha.
        const pm2Command = `cd "${botDirectory}" && ${NVM_PREFIX}pm2 start ${mainScript} --name "${name}"`;
        await ssh.execCommand(pm2Command).catch((err)=>{
             sendProgress(`AVISO: Não foi possível restaurar o bot automaticamente. Verifique o estado manualmente. Erro: ${err.message}`);
        });
    } finally {
        if (ssh.connection) {
            ssh.dispose();
        }
    }
}

server.listen(PORT, () => {
    console.log(`Painel de Controlo de Bots a rodar na porta ${PORT}`);
});
