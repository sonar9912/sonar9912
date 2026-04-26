const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('ssh2');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const ini = require('ini');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Data storage
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Initialize data files
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        telegramBotToken: '',
        adminPassword: bcrypt.hashSync('admin123', 10),
        serverIP: '',
        protocols: ['amnezia', 'xray', 'hysteria', 'tuic', 'shadowsocks', 'mtproxy']
    }, null, 2));
}

if (!fs.existsSync(CLIENTS_FILE)) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify([], null, 2));
}

if (!fs.existsSync(SERVERS_FILE)) {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify([], null, 2));
}

// Load data
let config = JSON.parse(fs.readFileSync(CONFIG_FILE));
let clients = JSON.parse(fs.readFileSync(CLIENTS_FILE));
let servers = JSON.parse(fs.readFileSync(SERVERS_FILE));

// Protocol configurations
const PROTOCOLS = {
    amnezia: {
        name: 'AmneziaWG 2.0',
        port: 51820,
        description: 'Модифицированный WireGuard с параметрами маскировки',
        installScript: `
#!/bin/bash
set -e
echo "Installing AmneziaWG..."
apt update && apt install -y wireguard qrencode
wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.0.0.1/24
SaveConfig = true
ListenPort = 51820
PrivateKey = \$(cat /etc/wireguard/private.key)
# AmneziaWG parameters
Jc = 3
Jmin = 150
Jmax = 900
S1 = 3
S2 = 7
H1 = 28675
H2 = 53881
H3 = 29957
H4 = 35480
PostUp = iptables -t mangle -A POSTROUTING -o eth0 -j MARK --set-mark 0x5555
PostUp = iptables -t mangle -A OUTPUT -p udp --dport 51820 -j MARK --set-mark 0x5555
PostDown = iptables -t mangle -D POSTROUTING -o eth0 -j MARK --set-mark 0x5555
PostDown = iptables -t mangle -D OUTPUT -p udp --dport 51820 -j MARK --set-mark 0x5555
PostUp = iptables -A FORWARD -i %i -j ACCEPT
PostUp = iptables -A FORWARD -o %i -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT
PostDown = iptables -D FORWARD -o %i -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
EOF
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0
echo "AmneziaWG installed successfully"
`,
        clientConfig: (client, server) => {
            const privateKey = client.keys.private;
            const publicKey = client.keys.public;
            const serverPubKey = server.keys.public;
            return `[Interface]
PrivateKey = ${privateKey}
Address = ${client.ip}/32
DNS = 1.1.1.1, 8.8.8.8

# AmneziaWG parameters
Jc = 3
Jmin = 150
Jmax = 900
S1 = 3
S2 = 7
H1 = 28675
H2 = 53881
H3 = 29957
H4 = 35480

[Peer]
PublicKey = ${serverPubKey}
Endpoint = ${server.ip}:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;
        }
    },
    xray: {
        name: 'XRay VLESS Reality',
        port: 443,
        description: 'VLESS с Reality маскировкой под HTTPS',
        installScript: `
#!/bin/bash
set -e
echo "Installing XRay VLESS Reality..."
curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh | bash
DOMAIN="microsoft.com"
UUID=$(uuidgen)
cat > /usr/local/etc/xray/config.json <<EOF
{
  "inbounds": [
    {
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "\${UUID}",
            "flow": "xtls-rprx-vision"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "\${DOMAIN}:443",
          "xver": 0,
          "serverNames": ["\${DOMAIN}"],
          "privateKey": "",
          "shortIds": [""]
        }
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom"
    }
  ]
}
EOF
systemctl restart xray
echo "XRay installed successfully"
`,
        clientConfig: (client, server) => {
            return `vless://${client.uuid}@${server.ip}:443?type=tcp&security=reality&sni=microsoft.com&fp=chrome&pbk=${server.keys.public}&sid=${server.shortId}&flow=xtls-rprx-vision#${client.email}`;
        }
    },
    hysteria: {
        name: 'Hysteria 2',
        port: 8443,
        description: 'Быстрый протокол на базе QUIC с обфускацией',
        installScript: `
#!/bin/bash
set -e
echo "Installing Hysteria 2..."
curl -fsSL https://get.hy2.sh/ | bash
PASSWORD=$(openssl rand -base64 32)
cat > /etc/hysteria/config.yaml <<EOF
listen: :8443
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem
auth:
  type: password
  password: \${PASSWORD}
obfs:
  type: salamander
  salamander:
    password: \${PASSWORD}
EOF
systemctl restart hysteria
echo "Hysteria 2 installed successfully"
`,
        clientConfig: (client, server) => {
            return `hysteria2://${client.password}@${server.ip}:8443?obfs=salamander&obfs-password=${client.password}#${client.email}`;
        }
    },
    tuic: {
        name: 'Tuic v5',
        port: 10443,
        description: 'Сверхбыстрый протокол на основе QUIC',
        installScript: `
#!/bin/bash
set -e
echo "Installing Tuic v5..."
curl -L https://github.com/EAimTY/tuic/releases/latest/download/tuic-server -o /usr/local/bin/tuic-server
chmod +x /usr/local/bin/tuic-server
PASSWORD=$(openssl rand -base64 32)
cat > /etc/tuic/config.json <<EOF
{
  "server": "[::]:10443",
  "users": {},
  "certificate": "/etc/tuic/cert.pem",
  "private_key": "/etc/tuic/key.pem",
  "ip_preference": "ipv4_first",
  "congestion_control": "bbr",
  "alpn": ["h3"],
  "log_level": "info"
}
EOF
systemctl restart tuic
echo "Tuic v5 installed successfully"
`,
        clientConfig: (client, server) => {
            return `tuic://${client.uuid}:${client.password}@${server.ip}:10443?congestion_control=bbr&alpn=h3&udp_relay_mode=native#${client.email}`;
        }
    },
    shadowsocks: {
        name: 'Shadowsocks 2022',
        port: 8388,
        description: 'Последняя версия с улучшенной криптографией',
        installScript: `
#!/bin/bash
set -e
echo "Installing Shadowsocks 2022..."
apt update && apt install -y shadowsocks-libev simple-obfs
PASSWORD=$(openssl rand -base64 32)
cat > /etc/shadowsocks-libev/config.json <<EOF
{
  "server": "0.0.0.0",
  "server_port": 8388,
  "password": "\${PASSWORD}",
  "method": "chacha20-ietf-poly1305",
  "plugin": "obfs-server",
  "plugin_opts": "obfs=tls;obfs-host=www.google.com"
}
EOF
systemctl restart shadowsocks-libev
echo "Shadowsocks 2022 installed successfully"
`,
        clientConfig: (client, server) => {
            const config = {
                server: server.ip,
                server_port: 8388,
                password: client.password,
                method: "chacha20-ietf-poly1305",
                plugin: "obfs-local",
                plugin_opts: "obfs=tls;obfs-host=www.google.com"
            };
            return 'ss://' + Buffer.from(JSON.stringify(config)).toString('base64') + '#' + client.email;
        }
    },
    mtproxy: {
        name: 'MTProxy (Telegram)',
        port: 443,
        description: 'Нативный прокси для Telegram',
        installScript: `
#!/bin/bash
set -e
echo "Installing MTProxy..."
docker run -d --name mtproxy -p 443:443 -e SECRET=\$(head -c 16 /dev/urandom | xxd -ps) -e TAG=mytag nstarikov/mtproxy
echo "MTProxy installed successfully"
`,
        clientConfig: (client, server) => {
            return `https://t.me/proxy?server=${server.ip}&port=443&secret=${client.secret}`;
        }
    }
};

// Generate keys for client
function generateClientKeys(protocol) {
    switch(protocol) {
        case 'amnezia':
            const wgPrivateKey = crypto.randomBytes(32).toString('base64');
            const wgPublicKey = crypto.createHash('sha256').update(wgPrivateKey).digest('base64');
            return { private: wgPrivateKey, public: wgPublicKey };
        case 'xray':
        case 'tuic':
            return { uuid: uuidv4() };
        case 'hysteria':
        case 'shadowsocks':
            return { password: crypto.randomBytes(32).toString('base64') };
        case 'mtproxy':
            return { secret: crypto.randomBytes(16).toString('hex') };
        default:
            return {};
    }
}

// SSH Connection helper
function connectSSH(server, callback) {
    const conn = new Client();
    conn.on('ready', () => {
        callback(null, conn);
    }).on('error', (err) => {
        callback(err, null);
    });

    const sshConfig = {
        host: server.ip,
        port: server.port || 22,
        username: server.username
    };

    if (server.authType === 'password') {
        sshConfig.password = server.password;
    } else {
        sshConfig.privateKey = fs.readFileSync(server.keyPath);
    }

    conn.connect(sshConfig);
}

// Deploy protocol to server
async function deployProtocol(server, protocol) {
    return new Promise((resolve, reject) => {
        connectSSH(server, (err, conn) => {
            if (err) return reject(err);

            let cmd = PROTOCOLS[protocol].installScript;
            
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);

                let output = '';
                stream.on('close', (code, signal) => {
                    conn.end();
                    resolve(output);
                }).on('data', (data) => {
                    output += data.toString();
                }).stderr.on('data', (data) => {
                    output += data.toString();
                });
            });
        });
    });
}

// Telegram Bot Setup
let bot = null;

function setupBot(token) {
    if (bot) {
        bot.stopPolling();
    }
    
    bot = new TelegramBot(token, {polling: true});

    // Main menu with buttons
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{text: "📊 Статус", callback_data: "status"}],
                    [{text: "👥 Мои клиенты", callback_data: "my_clients"}],
                    [{text: "➕ Добавить клиента", callback_data: "add_client"}],
                    [{text: "🌐 Серверы", callback_data: "servers"}],
                    [{text: "⚙️ Настройки", callback_data: "settings"}]
                ]
            }
        };
        bot.sendMessage(chatId, "👋 Добро пожаловать в VPN Панель!\nВыберите действие:", keyboard);
    });

    // Callback query handler
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        switch(data) {
            case 'status':
                const stats = {
                    total: clients.length,
                    byProtocol: {}
                };
                clients.forEach(c => {
                    stats.byProtocol[c.protocol] = (stats.byProtocol[c.protocol] || 0) + 1;
                });
                
                let statusMsg = "📊 *Статистика:*\n";
                statusMsg += `Всего клиентов: ${stats.total}\n\n`;
                for (const [proto, count] of Object.entries(stats.byProtocol)) {
                    statusMsg += `${PROTOCOLS[proto].name}: ${count}\n`;
                }
                
                bot.sendMessage(chatId, statusMsg, {parse_mode: 'Markdown'});
                break;

            case 'my_clients':
                let clientsMsg = "👥 *Ваши клиенты:*\n";
                clients.forEach((c, i) => {
                    clientsMsg += `${i+1}. ${c.email} (${PROTOCOLS[c.protocol].name})\n`;
                });
                
                const kb = {
                    inline_keyboard: clients.map((c, i) => [
                        {text: `📱 ${c.email}`, callback_data: `client_${c.id}`}
                    ])
                };
                
                bot.sendMessage(chatId, clientsMsg, {parse_mode: 'Markdown', reply_markup: kb});
                break;

            case 'add_client':
                const protoKb = {
                    inline_keyboard: Object.keys(PROTOCOLS).map(p => [
                        {text: PROTOCOLS[p].name, callback_data: `select_proto_${p}`}
                    ])
                };
                bot.sendMessage(chatId, "Выберите протокол:", {reply_markup: protoKb});
                break;

            case 'servers':
                let serversMsg = "🌐 *Серверы:*\n";
                servers.forEach((s, i) => {
                    serversMsg += `${i+1}. ${s.name} (${s.ip})\n`;
                });
                bot.sendMessage(chatId, serversMsg, {parse_mode: 'Markdown'});
                break;

            case 'settings':
                bot.sendMessage(chatId, "⚙️ Настройки доступны в веб-панели");
                break;

            default:
                if (data.startsWith('select_proto_')) {
                    const protocol = data.replace('select_proto_', '');
                    bot.sendMessage(chatId, `Введите email для клиента (${PROTOCOLS[protocol].name}):`);
                    // Store protocol selection for next message
                    bot.tempData = bot.tempData || {};
                    bot.tempData[chatId] = {action: 'create_client', protocol};
                } else if (data.startsWith('client_')) {
                    const clientId = data.replace('client_', '');
                    const client = clients.find(c => c.id === clientId);
                    if (client) {
                        const config = getClientConfig(client);
                        const qrDataUrl = await QRCode.toDataURL(config.link);
                        
                        bot.sendPhoto(chatId, qrDataUrl, {caption: `Конфигурация для ${client.email}`});
                        bot.sendMessage(chatId, config.link);
                    }
                }
                break;
        }

        bot.answerCallbackQuery(query.id);
    });

    // Handle text messages for client creation
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (bot.tempData && bot.tempData[chatId]) {
            const {action, protocol} = bot.tempData[chatId];
            
            if (action === 'create_client' && text) {
                try {
                    const server = servers[0]; // Use first server
                    if (!server) {
                        bot.sendMessage(chatId, "❌ Нет доступных серверов");
                        return;
                    }

                    const client = createClient(text, protocol, server);
                    const config = getClientConfig(client);
                    
                    const qrDataUrl = await QRCode.toDataURL(config.link);
                    bot.sendPhoto(chatId, qrDataUrl, {caption: `✅ Клиент создан!\n${client.email}`});
                    bot.sendMessage(chatId, `Ссылка:\n${config.link}`);
                    bot.sendMessage(chatId, `Конфиг файл:\n\`\`\`\n${config.config}\`\`\``, {parse_mode: 'Markdown'});
                    
                    delete bot.tempData[chatId];
                } catch (err) {
                    bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
                }
            }
        }
    });
}

// Create client
function createClient(email, protocol, server) {
    const id = uuidv4();
    const keys = generateClientKeys(protocol);
    const ip = `10.0.0.${clients.length + 2}`;
    
    const client = {
        id,
        email,
        protocol,
        ip,
        createdAt: new Date().toISOString(),
        ...keys,
        serverId: server.id
    };
    
    clients.push(client);
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
    
    return client;
}

// Get client config
function getClientConfig(client) {
    const server = servers.find(s => s.id === client.serverId) || servers[0];
    if (!server) throw new Error('Server not found');
    
    const protocolHandler = PROTOCOLS[client.protocol];
    const link = protocolHandler.clientConfig(client, server);
    const config = protocolHandler.clientConfig(client, server);
    
    return {link, config};
}

// API Routes
app.get('/api/status', (req, res) => {
    const stats = {
        totalClients: clients.length,
        totalServers: servers.length,
        byProtocol: {}
    };
    
    clients.forEach(c => {
        stats.byProtocol[c.protocol] = (stats.byProtocol[c.protocol] || 0) + 1;
    });
    
    res.json(stats);
});

app.get('/api/clients', (req, res) => {
    res.json(clients);
});

app.post('/api/clients', (req, res) => {
    const {email, protocol, serverId} = req.body;
    
    if (!email || !protocol) {
        return res.status(400).json({error: 'Email and protocol required'});
    }
    
    const server = servers.find(s => s.id === serverId) || servers[0];
    if (!server) {
        return res.status(400).json({error: 'Server not found'});
    }
    
    try {
        const client = createClient(email, protocol, server);
        const config = getClientConfig(client);
        res.json({...client, config: config.config, link: config.link});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.delete('/api/clients/:id', (req, res) => {
    const {id} = req.params;
    clients = clients.filter(c => c.id !== id);
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
    res.json({success: true});
});

app.get('/api/clients/:id/config', (req, res) => {
    const {id} = req.params;
    const client = clients.find(c => c.id === id);
    
    if (!client) {
        return res.status(404).json({error: 'Client not found'});
    }
    
    try {
        const config = getClientConfig(client);
        res.json(config);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.get('/api/servers', (req, res) => {
    res.json(servers);
});

app.post('/api/servers', async (req, res) => {
    const {name, ip, username, password, keyPath, authType, port} = req.body;
    
    const server = {
        id: uuidv4(),
        name,
        ip,
        username,
        password,
        keyPath,
        authType: authType || 'password',
        port: port || 22,
        createdAt: new Date().toISOString()
    };
    
    servers.push(server);
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
    
    // Auto-deploy all protocols
    const results = {};
    for (const protocol of config.protocols) {
        try {
            await deployProtocol(server, protocol);
            results[protocol] = 'success';
        } catch (err) {
            results[protocol] = `failed: ${err.message}`;
        }
    }
    
    res.json({...server, deployment: results});
});

app.delete('/api/servers/:id', (req, res) => {
    const {id} = req.params;
    servers = servers.filter(s => s.id !== id);
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
    res.json({success: true});
});

app.get('/api/protocols', (req, res) => {
    res.json(PROTOCOLS);
});

app.post('/api/telegram/setup', (req, res) => {
    const {token} = req.body;
    config.telegramBotToken = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    
    if (token) {
        setupBot(token);
    }
    
    res.json({success: true});
});

// Web Interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`VPN Panel running at http://localhost:${PORT}`);
    
    // Setup Telegram bot if token exists
    if (config.telegramBotToken) {
        setupBot(config.telegramBotToken);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    if (bot) {
        bot.stopPolling();
    }
    process.exit(0);
});
