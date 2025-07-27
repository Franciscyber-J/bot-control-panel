require('dotenv').config();
const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 10001;

app.set('trust proxy', 1);

const sessionParser = cookieSession({
    name: 'bcp-session',
    keys: [process.env.SESSION_SECRET],
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

const apiRouter = express.Router();
apiRouter.use(checkAuth);

const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
    readyTimeout: 20000
};

const NODE_PATH = '/root/.nvm/versions/node/v18.20.8/bin/node';
const PM2_PATH = '/root/.nvm/versions/node/v18.20.8/bin/pm2';
const NPM_PATH = '/root/.nvm/versions/node/v18.20.8/bin/npm';

apiRouter.get('/bots/status', async (req, res) => {
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NODE_PATH} ${PM2_PATH} jlist`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || 'Falha ao obter a lista de bots.');
        res.json(JSON.parse(result.stdout));
    } catch (error) {
        res.status(500).json({ error: `Falha na rota de status. Detalhe: ${error.message}` });
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
        const command = `${NODE_PATH} ${PM2_PATH} start ${scriptPath} --name ${name}`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || `Falha ao iniciar o bot '${name}'.`);
        res.json({ message: `Bot '${name}' adicionado e iniciado com sucesso.` });
    } catch (error) {
        res.status(500).json({ error: `Falha ao adicionar o bot. Detalhe: ${error.message}` });
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
        const command = `${NODE_PATH} ${PM2_PATH} ${action} ${name}`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || `O comando \`pm2 ${action} ${name}\` falhou.`);
        res.json({ message: `Ação '${action}' executada com sucesso para o bot '${name}'.` });
    } catch (error) {
        res.status(500).json({ error: `Falha ao executar a ação '${action}' no bot '${name}'. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.post('/bots/env/:name', async (req, res) => {
    const { name } = req.params;
    const { content, scriptPath } = req.body;
    if (!name || !content || !scriptPath) {
        return res.status(400).json({ error: 'Faltam dados essenciais.' });
    }
    const botDirectory = path.dirname(scriptPath);
    const envPath = path.join(botDirectory, '.env');
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const base64Content = Buffer.from(content).toString('base64');
        const writeCommand = `echo ${base64Content} | base64 --decode > ${envPath}`;
        const writeResult = await ssh.execCommand(writeCommand);
        if (writeResult.code !== 0) {
            throw new Error(writeResult.stderr || 'Falha ao escrever o ficheiro .env no servidor.');
        }
        const reloadCommand = `${NODE_PATH} ${PM2_PATH} reload ${name}`;
        const reloadResult = await ssh.execCommand(reloadCommand);
        if (reloadResult.code !== 0) {
            throw new Error(reloadResult.stderr || `Ficheiro .env atualizado, mas falha ao reiniciar o bot '${name}'.`);
        }
        res.json({ message: `Ficheiro .env para o bot '${name}' atualizado e bot reiniciado com sucesso.` });
    } catch (error) {
        res.status(500).json({ error: `Falha ao atualizar o ficheiro .env. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.delete('/bots/delete/:name', async (req, res) => {
    const { name } = req.params;
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const command = `${NODE_PATH} ${PM2_PATH} delete ${name}`;
        const result = await ssh.execCommand(command);
        if (result.code !== 0) throw new Error(result.stderr || `Falha ao excluir o bot '${name}'.`);
        res.json({ message: `Bot '${name}' parado e excluído com sucesso.` });
    } catch (error) {
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
        const command = `${NODE_PATH} ${PM2_PATH} logs ${name} --lines 100 --nostream`;
        const result = await ssh.execCommand(command);
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
        res.json({ logs: result.stdout || 'Nenhum log disponível.' });
    } catch (error) {
        res.status(500).json({ error: `Falha ao buscar logs do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

apiRouter.post('/bots/update/:name', async (req, res) => {
    const { name } = req.params;
    const { scriptPath, gitUrl } = req.body;
    if (!name || !scriptPath || !gitUrl) {
        return res.status(400).json({ error: 'Nome, caminho do script e URL do Git são obrigatórios.' });
    }
    const botDirectory = path.dirname(scriptPath);
    const ssh = new NodeSSH();
    try {
        await ssh.connect(sshConfig);
        const commands = [
            `git -C ${botDirectory} remote set-url origin ${gitUrl}`,
            `git -C ${botDirectory} fetch origin`,
            `git -C ${botDirectory} reset --hard origin/main`,
            `${NODE_PATH} ${NPM_PATH} --prefix ${botDirectory} install`,
            `${NODE_PATH} ${PM2_PATH} reload ${name}`
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
    } catch (error) {
        res.status(500).json({ error: `Falha no deploy do bot. Detalhe: ${error.message}` });
    } finally {
        if (ssh.connection) ssh.dispose();
    }
});

app.use('/api', apiRouter);

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
    const urlParts = request.url.split('/');
    const botName = urlParts[urlParts.length - 1];
    
    if (!botName) {
        ws.close(1008, 'Nome do bot não fornecido.');
        return;
    }

    console.log(`Cliente WebSocket conectado para os logs de: ${botName}`);
    const ssh = new NodeSSH();
    
    ssh.connect(sshConfig)
        .then(() => {
            ssh.execCommand(`${NODE_PATH} ${PM2_PATH} logs ${botName} --raw --lines 20`, {
                onStdout: (chunk) => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(chunk.toString('utf8'));
                    }
                },
                onStderr: (chunk) => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(`[ERRO SSH]: ${chunk.toString('utf8')}`);
                    }
                }
            });
        })
        .catch(err => {
            console.error(`Erro na conexão SSH ou comando para logs de ${botName}:`, err);
            if (ws.readyState === ws.OPEN) {
                ws.close(1011, 'Erro no servidor ao iniciar o stream de logs.');
            }
        });

    ws.on('close', () => {
        console.log(`Cliente WebSocket desconectado para os logs de: ${botName}`);
        if (ssh.connection) {
            ssh.dispose();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Painel de Controlo de Bots a rodar na porta ${PORT}`);
});