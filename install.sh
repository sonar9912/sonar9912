#!/bin/bash

# VPN Panel Installation Script
# This script installs all dependencies and sets up the VPN panel

set -e

echo "🚀 Установка VPN панели..."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "Пожалуйста, запустите от имени root (sudo ./install.sh)"
    exit 1
fi

# Update system
log_info "Обновление пакетов..."
apt update -y

# Install Node.js if not installed
if ! command -v node &> /dev/null; then
    log_info "Установка Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# Install required packages
log_info "Установка зависимостей..."
apt install -y \
    wireguard \
    qrencode \
    openssl \
    curl \
    wget \
    git \
    iptables \
    docker.io \
    uuid-runtime

# Enable IP forwarding
log_info "Включение IP forwarding..."
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
sysctl -p

# Setup Docker
log_info "Настройка Docker..."
systemctl enable docker
systemctl start docker

# Create app directory
APP_DIR="/opt/vpn-panel"
log_info "Создание директории $APP_DIR..."
mkdir -p $APP_DIR

# Copy application files
log_info "Копирование файлов приложения..."
cp -r /workspace/vpn-panel/* $APP_DIR/

# Install npm dependencies
log_info "Установка npm зависимостей..."
cd $APP_DIR
npm install --production

# Generate random admin password
ADMIN_PASSWORD=$(openssl rand -base64 12)
log_info "Генерация пароля администратора..."

# Create systemd service
log_info "Создание systemd сервиса..."
cat > /etc/systemd/system/vpn-panel.service <<EOF
[Unit]
Description=VPN Panel Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
log_info "Запуск сервиса..."
systemctl daemon-reload
systemctl enable vpn-panel
systemctl restart vpn-panel

# Wait for service to start
sleep 3

# Get server IP
SERVER_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')

# Show installation summary
echo ""
echo "=============================================="
echo "          ✅ УСТАНОВКА ЗАВЕРШЕНА!            "
echo "=============================================="
echo ""
echo "🌐 Веб-панель:"
echo "   URL: http://${SERVER_IP}:3000"
echo "   Логин: admin"
echo "   Пароль: ${ADMIN_PASSWORD}"
echo ""
echo "📱 Telegram бот:"
echo "   1. Создайте бота через @BotFather"
echo "   2. Получите токен"
echo "   3. Введите токен в веб-панели во вкладке 'Telegram Бот'"
echo ""
echo "🛡️ Доступные протоколы:"
echo "   • AmneziaWG 2.0 (порт 51820)"
echo "   • XRay VLESS Reality (порт 443)"
echo "   • Hysteria 2 (порт 8443)"
echo "   • Tuic v5 (порт 10443)"
echo "   • Shadowsocks 2022 (порт 8388)"
echo "   • MTProxy (порт 443)"
echo ""
echo "📋 Полезные команды:"
echo "   systemctl status vpn-panel  # Статус сервиса"
echo "   systemctl restart vpn-panel # Перезапуск"
echo "   journalctl -u vpn-panel -f  # Логи"
echo ""
echo "=============================================="
echo ""

# Save credentials to file
cat > /root/vpn-panel-credentials.txt <<EOF
VPN Panel Credentials
=====================
URL: http://${SERVER_IP}:3000
Login: admin
Password: ${ADMIN_PASSWORD}

Generated: $(date)
EOF

log_info "Учетные данные сохранены в /root/vpn-panel-credentials.txt"
log_info "Установка завершена успешно!"
