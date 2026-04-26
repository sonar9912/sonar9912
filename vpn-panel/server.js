const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const { Client: SSHClient } = require('ssh2');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_DIR = path.join(__dirname, 'configs');
const DB_PATH = path.join(__dirname, 'db.json');

// Инициализация хранилища
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
if (!fs.existsSync(path.join(CONFIG_DIR, 'qr'))) fs.mkdirSync(path.join(CONFIG_DIR, 'qr'));

let db = {
    clients: [],
    telegram: { token: null, bot: null, chatId: null },
    servers: [] // { id, name, ip, port, user, password/keyPath, authType, status, protocols: [] }
};

if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH));
        console.log('База данных загружена.');
    } catch (e) {
        console.error('Ошибка чтения БД:', e);
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- Утилиты ---
function saveDB() {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function generateWireGuardKeys() {
    const randomKey = () => {
        const buf = crypto.randomBytes(32);
        buf[0] &= 248;
        buf[31] &= 127;
        buf[31] |= 64;
        return buf.toString('base64');
    };
    return {
        privateKey: randomKey(),
        publicKey: randomKey(),
        presharedKey: randomKey()
    };
}

function generateVLESSUUID() {
    return uuidv4();
}

function generateMTProxySecret() {
    return crypto.randomBytes(16).toString('hex');
}

// --- Генерация конфигураций ---
function generateAmneziaWGConfig(client, server) {
    const keys = generateWireGuardKeys();
    const ip = `10.0.0.${db.clients.filter(c => c.protocol === 'AmneziaWG' || c.protocol === 'WireGuard').length + 2}`;
    
    const config = `[Interface]
PrivateKey = ${keys.privateKey}
Address = ${ip}/24
DNS = 8.8.8.8, 1.1.1.1
Jc = 3
Jmin = 500
Jmax = 1500
S1 = 15
S2 = 20
H1 = 333333
H2 = 222222
H3 = 777777
H4 = 555555

[Peer]
PublicKey = ${server.publicKey || 'SERVER_PUBLIC_KEY'}
PresharedKey = ${keys.presharedKey}
Endpoint = ${server.ip}:${server.wgPort || 51820}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

    return { keys, config, qrData: config };
}

function generateXRayVLESSConfig(client, server) {
    const uuid = generateVLESSUUID();
    const config = {
        v: "2",
        ps: `VPN-${client.email}`,
        add: server.ip,
        port: server.vlessPort || 443,
        id: uuid,
        aid: "0",
        net: "ws",
        type: "none",
        host: "",
        path: "/vless",
        tls: "tls",
        sni: server.sni || ""
    };
    
    const qrString = `vless://${uuid}@${server.ip}:${server.port}?path=${encodeURIComponent(config.path)}&security=${config.tls}&type=${config.net}&host=${config.host}&sni=${config.sni}#${encodeURIComponent(client.email)}`;
    
    return { keys: { uuid }, config: JSON.stringify(config, null, 2), qrData: qrString };
}

function generateMTProxyConfig(client, server) {
    const secret = generateMTProxySecret();
    const config = {
        server: server.ip,
        port: server.mtPort || 443,
        secret: secret,
        type: "mtproto"
    };
    
    const qrString = `https://t.me/proxy?server=${server.ip}&port=${server.mtPort || 443}&secret=${secret}`;
    
    return { keys: { secret }, config: JSON.stringify(config, null, 2), qrData: qrString };
}

// --- SSH Развертывание ---
async function connectSSH(server) {
    return new Promise((resolve, reject) => {
        const conn = new SSHClient();
        
        const config = {
            host: server.ip,
            port: server.port || 22,
            username: server.user
        };
        
        if (server.authType === 'password') {
            config.password = server.password;
        } else {
            try {
                config.privateKey = fs.readFileSync(server.keyPath);
            } catch (e) {
                reject(new Error(`Не удалось прочитать ключ: ${e.message}`));
                return;
            }
        }
        
        conn.on('ready', () => resolve(conn))
            .on('error', (err) => reject(err))
            .connect(config);
    });
}

async function deployProtocol(server, protocol, clientData) {
    let conn;
    try {
        conn = await connectSSH(server);
        
        const commands = {
            'AmneziaWG': `
                sudo apt-get update
                sudo apt-get install -y wireguard qrencode
                echo "${clientData.config}" | sudo tee /etc/wireguard/wg0.conf
                sudo wg-quick down wg0 || true
                sudo wg-quick up wg0
            `,
            'XRay': `
                bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
                echo "${clientData.config}" | sudo tee /usr/local/etc/xray/config.json
                sudo systemctl restart xray
            `,
            'MTProxy': `
                sudo apt-get install -y docker.io
                docker run -d -p ${server.mtPort || 443}:443 --name mtproxy derailed/mtproxy
            `
        };
        
        if (commands[protocol]) {
            const result = await new Promise((resolve, reject) => {
                conn.exec(commands[protocol], (err, stream) => {
                    if (err) return reject(err);
                    let output = '';
                    stream.on('close', (code) => resolve({ code, output }))
                          .on('data', (data) => { output += data.toString(); });
                });
            });
            
            if (result.code !== 0 && protocol !== 'MTProxy') {
                throw new Error(`Ошибка выполнения: ${result.output}`);
            }
        }
        
        conn.end();
        return { success: true, message: `Развернуто на ${server.name}` };
    } catch (error) {
        if (conn) conn.end();
        return { success: false, message: error.message };
    }
}

// --- Telegram Bot ---
function initBot() {
    if (db.telegram.token) {
        try {
            if (db.telegram.bot) db.telegram.bot.stop();
            db.telegram.bot = new Telegraf(db.telegram.token);
            
            const bot = db.telegram.bot;

            bot.start((ctx) => {
                db.telegram.chatId = ctx.chat.id;
                saveDB();
                ctx.replyWithPhoto({ url: 'https://cdn-icons-png.flaticon.com/512/2830/2830305.png' }, {
                    caption: '👋 *VPN Panel Pro*\n\nУправление через меню:\n/deploy - Добавить клиента\n/servers - Список серверов\n/status - Статистика\n/protocols - Доступные протоколы',
                    parse_mode: 'Markdown'
                });
            });

            bot.command('status', (ctx) => {
                const wgCount = db.clients.filter(c => c.protocol === 'WireGuard' || c.protocol === 'AmneziaWG').length;
                const vlessCount = db.clients.filter(c => c.protocol === 'XRay').length;
                const mtCount = db.clients.filter(c => c.protocol === 'MTProxy').length;
                
                ctx.reply(`📊 *Статистика:*\n\n👥 Всего клиентов: ${db.clients.length}\n🔹 WireGuard/Amnezia: ${wgCount}\n🔸 VLESS: ${vlessCount}\n🔺 MTProxy: ${mtCount}\n🖥 Серверов: ${db.servers.length}`, { parse_mode: 'Markdown' });
            });

            bot.command('servers', (ctx) => {
                let msg = '🖥 *Список серверов:*\n\n';
                db.servers.forEach(s => {
                    msg += `▪️ *${s.name}* (\`${s.ip}\`)\n   Статус: ${s.status.toUpperCase()}\n   Протоколы: ${s.protocols?.join(', ') || 'None'}\n   Клиентов: ${s.activeClients?.length || 0}\n\n`;
                });
                if (db.servers.length === 0) msg += '❌ Нет серверов';
                ctx.reply(msg, { parse_mode: 'Markdown' });
            });

            bot.command('protocols', (ctx) => {
                ctx.reply(`📡 *Доступные протоколы:*\n\n🔹 WireGuard - Быстрый, современный\n🔹 AmneziaWG 2.0 - Обход блокировок\n🔸 XRay VLESS - Универсальный\n🔺 MTProxy - Для Telegram`, { parse_mode: 'Markdown' });
            });

            bot.command('deploy', async (ctx) => {
                const args = ctx.message.text.split(' ');
                if (args.length < 3) {
                    return ctx.reply('❌ Использование:\n/deploy <email> <протокол>\n\nПротоколы: AmneziaWG, XRay, MTProxy');
                }
                
                const email = args[1];
                const protocol = args[2];
                
                const targetServer = db.servers.find(s => s.status === 'active' && s.protocols?.includes(protocol));
                if (!targetServer) {
                    return ctx.reply(`❌ Нет активных серверов с протоколом ${protocol}`);
                }

                ctx.reply(`🚀 Развертывание ${protocol} для ${email}...`);
                
                const result = await createClientAndDeploy(email, targetServer.id, protocol);
                
                if (result.success) {
                    const qrPath = path.join(CONFIG_DIR, 'qr', `${result.client.id}.png`);
                    await QRCode.toFile(qrPath, result.client.qrData);
                    
                    await ctx.replyWithPhoto({ source: qrPath }, {
                        caption: `✅ *Клиент создан!*\n\n📧 Email: \`${email}\`\n🔹 Протокол: ${protocol}\n🖥 Сервер: ${targetServer.name}\n\n📱 Отсканируйте QR код для подключения`,
                        parse_mode: 'Markdown'
                    });
                    
                    // Отправка файла конфига
                    if (result.client.configFile) {
                        await ctx.replyWithDocument({ source: result.client.configFile, filename: `${email}.txt` });
                    }
                } else {
                    ctx.reply(`❌ Ошибка: ${result.message}`);
                }
            });

            bot.launch();
            console.log('✅ Telegram bot запущен');
        } catch (e) {
            console.error('❌ Ошибка запуска бота:', e.message);
        }
    }
}

// --- API Routes ---

app.get('/api/status', (req, res) => {
    res.json({
        clients: db.clients.length,
        servers: db.servers.length,
        botActive: !!db.telegram.token,
        protocols: {
            amnezia: db.clients.filter(c => c.protocol === 'AmneziaWG').length,
            vless: db.clients.filter(c => c.protocol === 'XRay').length,
            mtproxy: db.clients.filter(c => c.protocol === 'MTProxy').length
        }
    });
});

app.get('/api/clients', (req, res) => res.json(db.clients));

app.post('/api/clients', async (req, res) => {
    const { email, serverId, protocol } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });
    if (!protocol) return res.status(400).json({ error: 'Протокол обязателен' });

    const targetServerId = serverId || (db.servers.length > 0 ? db.servers[0].id : null);
    if (!targetServerId) return res.status(400).json({ error: 'Сервер не выбран' });
    
    const result = await createClientAndDeploy(email, targetServerId, protocol);
    
    if (result.success) {
        // Генерация QR
        const qrPath = path.join(CONFIG_DIR, 'qr', `${result.client.id}.png`);
        await QRCode.toFile(qrPath, result.client.qrData);
        
        res.json({ 
            ...result.client, 
            qrImage: `/api/qr/${result.client.id}` 
        });
        
        if (db.telegram.bot && db.telegram.chatId) {
            db.telegram.bot.telegram.sendMessage(db.telegram.chatId, `🆕 Новый клиент: ${email}\nПротокол: ${protocol}`);
        }
    } else {
        res.status(500).json({ error: result.message });
    }
});

async function createClientAndDeploy(email, serverId, protocol) {
    const server = db.servers.find(s => s.id === serverId);
    if (!server) return { success: false, message: 'Сервер не найден' };
    
    let clientData;
    
    switch(protocol) {
        case 'AmneziaWG':
            clientData = generateAmneziaWGConfig({ email }, server);
            break;
        case 'XRay':
            clientData = generateXRayVLESSConfig({ email }, server);
            break;
        case 'MTProxy':
            clientData = generateMTProxyConfig({ email }, server);
            break;
        default:
            return { success: false, message: 'Неизвестный протокол' };
    }
    
    const client = {
        id: uuidv4(),
        email,
        protocol,
        serverId,
        createdAt: new Date().toISOString(),
        keys: clientData.keys,
        configContent: clientData.config,
        qrData: clientData.qrData,
        configFile: Buffer.from(clientData.config)
    };

    db.clients.push(client);
    
    if (!server.activeClients) server.activeClients = [];
    server.activeClients.push(client.id);

    saveDB();

    // Развертывание на сервере
    const deployResult = await deployProtocol(server, protocol, clientData);
    if (!deployResult.success) {
        return { success: false, message: deployResult.message };
    }

    return { success: true, client, message: 'Клиент создан и развернут' };
}

app.delete('/api/clients/:id', (req, res) => {
    const { id } = req.params;
    db.clients = db.clients.filter(c => c.id !== id);
    saveDB();
    res.json({ success: true });
});

app.get('/api/clients/:id/config', (req, res) => {
    const client = db.clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${client.email}.txt"`);
    res.send(client.configContent);
});

app.get('/api/qr/:id', async (req, res) => {
    const client = db.clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).send('Not found');
    
    const qrPath = path.join(CONFIG_DIR, 'qr', `${client.id}.png`);
    if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
    } else {
        // Генерация на лету
        const qrBuffer = await QRCode.toBuffer(client.qrData);
        res.setHeader('Content-Type', 'image/png');
        res.send(qrBuffer);
    }
});

// Управление серверами
app.get('/api/servers', (req, res) => res.json(db.servers));

app.post('/api/servers', async (req, res) => {
    const { name, ip, port, user, authType, password, keyPath, protocols, wgPort, vlessPort, mtPort, sni } = req.body;
    
    const newServer = {
        id: uuidv4(),
        name,
        ip,
        port: port || 22,
        user,
        authType: authType || 'password',
        password: authType === 'password' ? password : undefined,
        keyPath: authType === 'key' ? keyPath : undefined,
        protocols: protocols || ['AmneziaWG'],
        wgPort: wgPort || 51820,
        vlessPort: vlessPort || 443,
        mtPort: mtPort || 443,
        sni: sni || '',
        status: 'checking...',
        activeClients: [],
        addedAt: new Date().toISOString()
    };
    
    // Проверка подключения
    try {
        const conn = await connectSSH(newServer);
        newServer.status = 'active';
        
        // Проверка установленных протоколов
        const checkResult = await new Promise((resolve) => {
            conn.exec('which wg xray docker', (err, stream) => {
                let output = '';
                stream.on('close', () => resolve(output))
                      .on('data', (data) => { output += data.toString(); });
            });
        });
        
        // Авто-обнаружение доступных протоколов
        if (!newServer.protocols || newServer.protocols.length === 0) {
            newServer.protocols = [];
            if (checkResult.includes('wg')) newServer.protocols.push('AmneziaWG');
            if (checkResult.includes('xray')) newServer.protocols.push('XRay');
            if (checkResult.includes('docker')) newServer.protocols.push('MTProxy');
        }
        
        conn.end();
    } catch (e) {
        newServer.status = 'error';
        newServer.errorMessage = e.message;
    }

    db.servers.push(newServer);
    saveDB();
    res.json(newServer);
});

app.delete('/api/servers/:id', (req, res) => {
    db.servers = db.servers.filter(s => s.id !== req.params.id);
    saveDB();
    res.json({ success: true });
});

// Настройки бота
app.post('/api/bot/settings', (req, res) => {
    const { token } = req.body;
    db.telegram.token = token;
    saveDB();
    initBot();
    res.json({ success: true, message: 'Настройки бота обновлены' });
});

// Рассылка
app.post('/api/bot/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!db.telegram.bot || !db.telegram.chatId) {
        return res.status(400).json({ error: 'Бот не настроен' });
    }
    try {
        await db.telegram.bot.telegram.sendMessage(db.telegram.chatId, `📢 *Рассылка:*\n\n${message}`, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VPN Panel Pro running on http://0.0.0.0:${PORT}`);
    initBot();
});
