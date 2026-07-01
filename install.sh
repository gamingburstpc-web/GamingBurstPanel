#!/bin/bash

# GamingBurst Panel — VPS Installer Script
# Works on Ubuntu 22.04 & Debian 12
# Installs Node.js, Java 21, clones/downloads the panel, sets up systemd and global CLI link.

set -e

# ── Colors ────────────────────────────────────────────────────────────────────
C_RESET="\e[0m"
C_BOLD="\e[1m"
C_GREEN="\e[32m"
C_RED="\e[31m"
C_CYAN="\e[36m"
C_YELLOW="\e[33m"

print_status() {
    echo -e "${C_BOLD}${C_CYAN}>>> ${1}${C_RESET}"
}

print_success() {
    echo -e "${C_BOLD}${C_GREEN}✓ ${1}${C_RESET}"
}

print_error() {
    echo -e "${C_BOLD}${C_RED}✗ Error: ${1}${C_RESET}"
}

# ── Root Check ────────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    print_error "Please run this installer as root (e.g. using sudo)."
    exit 1
fi

print_status "Starting GamingBurst Panel Installation..."

# ── Detect OS ─────────────────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VER=$VERSION_ID
else
    print_error "Unsupported Linux distribution. Could not read /etc/os-release."
    exit 1
fi

if [ "$OS" != "ubuntu" ] && [ "$OS" != "debian" ]; then
    print_error "This installer only supports Ubuntu and Debian."
    exit 1
fi

print_success "Detected $NAME ($VERSION)"

# ── Update & Install Prerequisites ────────────────────────────────────────────
print_status "Updating package lists..."
apt-get update -y

print_status "Installing core dependencies (curl, git, gnupg, build-essential)..."
apt-get install -y curl git gnupg build-essential ufw

# ── Install Node.js (v20 LTS) ─────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    print_status "Installing Node.js v20 (LTS) via NodeSource..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
    print_success "Node.js $(node -v) installed."
else
    print_success "Node.js already installed: $(node -v)"
fi

# ── Install Java 25 ───────────────────────────────────────────────────────────
if ! command -v java &> /dev/null; then
    print_status "Installing OpenJDK 25 JRE (Required for Minecraft 1.26+)..."
    apt-get install -y openjdk-25-jre-headless
    print_success "Java 25 installed: $(java -version 2>&1 | head -n 1)"
else
    print_success "Java already installed: $(java -version 2>&1 | head -n 1)"
fi

# ── Setup User and Group ──────────────────────────────────────────────────────
# Creating a dedicated user keeps the running Minecraft servers isolated from root
if ! id "gbpanel" &>/dev/null; then
    print_status "Creating dedicated system user 'gbpanel'..."
    useradd -r -m -d /opt/gbpanel -s /bin/bash gbpanel
    print_success "User 'gbpanel' created."
else
    print_success "User 'gbpanel' already exists."
fi

# ── Clone / Download Repo ─────────────────────────────────────────────────────
INSTALL_DIR="/opt/gbpanel/panel"
print_status "Setting up project directory at $INSTALL_DIR..."

REPO_URL="https://github.com/gamingburstpc-web/GamingBurstPanel.git"

if [ -d "$INSTALL_DIR/.git" ]; then
    print_status "Existing Git repository found. Pulling latest changes..."
    sudo -u gbpanel bash -c "cd $INSTALL_DIR && git reset --hard && git pull origin main"
else
    if [ -d "$INSTALL_DIR" ]; then
        print_status "Existing non-git directory found. Backing up to ${INSTALL_DIR}_backup..."
        mv "$INSTALL_DIR" "${INSTALL_DIR}_backup_$(date +%s)"
    fi
    mkdir -p "$INSTALL_DIR"
    print_status "Cloning repository $REPO_URL..."
    git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ── Install Project Dependencies ──────────────────────────────────────────────
print_status "Installing npm packages..."
cd "$INSTALL_DIR"
npm install --omit=dev

# ── Environment Configuration ─────────────────────────────────────────────────
if [ ! -f .env ]; then
    print_status "Creating default .env file..."
    if [ -f .env.example ]; then
        cp .env.example .env
    else
        cat <<EOT > .env
PANEL_PORT=7676
DB_PATH=./data/panel.db
SERVERS_DIR=../servers
DEFAULT_TZ=Asia/Kolkata
BCRYPT_ROUNDS=10
SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
EOT
    fi
fi

# Ensure servers folder exists
mkdir -p /opt/gbpanel/servers

# ── Set Permissions ───────────────────────────────────────────────────────────
print_status "Configuring file ownership and permissions..."
chown -R gbpanel:gbpanel /opt/gbpanel
chmod -R 755 /opt/gbpanel

# ── Global CLI Command Setup ──────────────────────────────────────────────────
print_status "Configuring global CLI shortcut..."
# Create a symlink in /usr/bin & /usr/local/bin pointing to the cli
chmod +x "$INSTALL_DIR/bin/menu.sh"
ln -sf "$INSTALL_DIR/bin/menu.sh" /usr/local/bin/gbpanel
ln -sf "$INSTALL_DIR/bin/menu.sh" /usr/bin/gbpanel
ln -sf "$INSTALL_DIR/bin/menu.sh" /usr/local/bin/gb
ln -sf "$INSTALL_DIR/bin/menu.sh" /usr/bin/gb
print_success "CLI shortcut registered universally as 'gb' and 'gbpanel'."

# ── Systemd Service Setup ─────────────────────────────────────────────────────
print_status "Creating systemd daemon service..."
SERVICE_FILE="/etc/systemd/system/gbpanel.service"

cat <<EOT > "$SERVICE_FILE"
[Unit]
Description=GamingBurst Minecraft Server Control Panel
After=network.target

[Service]
Type=simple
User=gbpanel
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=PATH=/usr/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOT

systemctl daemon-reload
systemctl enable gbpanel.service
systemctl start gbpanel.service

# ── Port Configuration (UFW) ──────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
    print_status "Allowing panel port 7676 in UFW..."
    ufw allow 7676/tcp comment "GamingBurst Panel"
    # Also allow standard minecraft port range
    ufw allow 25565:25575/tcp comment "Minecraft Servers"
fi

print_success "GamingBurst Panel installed successfully!"
echo -e ""
echo -e "${C_BOLD}To complete setup, follow these steps:${C_RESET}"
echo -e "  1. Create your administrator account:"
echo -e "     ${C_GREEN}sudo -u gbpanel gbpanel user add${C_RESET}"
echo -e ""
echo -e "  2. Access the panel in your browser at:"
echo -e "     ${C_CYAN}http://your_vps_ip:7676${C_RESET}"
echo -e ""
echo -e "  3. You can manage the panel service using standard commands:"
echo -e "     ${C_BOLD}systemctl status gbpanel${C_RESET}"
echo -e "     ${C_BOLD}systemctl restart gbpanel${C_RESET}"
echo -e ""
echo -e "${C_CYAN}========================================================================${C_RESET}"
echo -e "${C_BOLD}Designed, developed, and fully maintained by GamingBurst007.${C_RESET}"
echo -e "I'm a beginner solo coder, so please show your support for more amazing projects like this!"
echo -e "YouTube: ${C_BLUE}https://www.youtube.com/@gamingburst007${C_RESET}"
echo -e "Discord: ${C_BLUE}https://discord.gg/JZ7nwxTaNs${C_RESET}"
echo -e "${C_CYAN}========================================================================${C_RESET}"

if command -v python3 &> /dev/null; then
    python3 -m webbrowser "https://www.youtube.com/@gamingburst007" 2>/dev/null &
elif command -v xdg-open &> /dev/null; then
    xdg-open "https://www.youtube.com/@gamingburst007" 2>/dev/null &
fi
