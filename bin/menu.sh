#!/bin/bash

# Ensure script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this command as root (e.g., sudo gbpanel)"
  exit 1
fi

GB_CMD="sudo -u gbpanel /opt/gbpanel/panel/gbpanel.js"

# If arguments are provided, pass them directly to the underlying CLI tool
if [ $# -gt 0 ]; then
    $GB_CMD "$@"
    exit $?
fi

while true; do
    clear
    echo -e "\033[1;34m==========================================\033[0m"
    echo -e "\033[1;37m      🎮 GamingBurst Panel Menu 🎮        \033[0m"
    echo -e "\033[1;34m==========================================\033[0m"
    echo -e "\033[1;32m1)\033[0m Add User"
    echo -e "\033[1;32m2)\033[0m List Users"
    echo -e "\033[1;32m3)\033[0m Remove User"
    echo -e "\033[1;32m4)\033[0m Reset User Password"
    echo -e "\033[1;32m5)\033[0m List Servers & Ports"
    echo -e "\033[1;32m6)\033[0m Get Server Folder Path"
    echo -e "\033[1;32m7)\033[0m Restart Panel Service"
    echo -e "\033[1;32m8)\033[0m Stop Panel Service"
    echo -e "\033[1;32m9)\033[0m View Panel Live Logs"
    echo -e "\033[1;32m10)\033[0m Check Panel Status"
    echo -e "\033[1;32m11)\033[0m Update Panel"
    echo -e "\033[1;32m12)\033[0m Start/Stop Panel (Background Mode - No systemctl)"
    echo -e "\033[1;31m13)\033[0m Uninstall Panel & Delete All Data"
    echo -e "\033[1;31m0)\033[0m Exit"
    echo -e "\033[1;34m==========================================\033[0m"
    read -p "Select an option [0-13]: " option

    echo ""
    case $option in
        1)
            $GB_CMD user add
            ;;
        2)
            $GB_CMD user list
            ;;
        3)
            read -p "Enter username to remove: " del_user
            if [ -n "$del_user" ]; then
                $GB_CMD user remove "$del_user"
            fi
            ;;
        4)
            read -p "Enter username to reset password: " reset_user
            if [ -n "$reset_user" ]; then
                $GB_CMD user reset-password "$reset_user"
            fi
            ;;
        5)
            $GB_CMD server list
            ;;
        6)
            read -p "Enter server name: " srv_name
            if [ -n "$srv_name" ]; then
                $GB_CMD server path "$srv_name"
            fi
            ;;
        7)
            echo "Restarting GamingBurst Panel..."
            systemctl restart gbpanel
            echo "Done."
            ;;
        8)
            echo "Stopping GamingBurst Panel..."
            systemctl stop gbpanel
            echo "Done."
            ;;
        9)
            echo "Press Ctrl+C to exit logs."
            journalctl -u gbpanel -f
            ;;
        10)
            echo "Checking Panel Status..."
            if systemctl is-active --quiet gbpanel; then
                echo -e "\033[1;32mPanel is ONLINE and running normally.\033[0m"
            else
                echo -e "\033[1;31mPanel is OFFLINE.\033[0m"
                read -p "Do you want to start the panel now? (y/n): " ans
                if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
                    systemctl start gbpanel
                    echo "Panel started."
                fi
            fi
            ;;
        11)
            echo "Checking for Updates..."
            cd /opt/gbpanel/panel
            sudo -u gbpanel git fetch origin main > /dev/null 2>&1
            LOCAL=$(sudo -u gbpanel git rev-parse HEAD)
            REMOTE=$(sudo -u gbpanel git rev-parse origin/main)
            if [ "$LOCAL" = "$REMOTE" ]; then
                echo -e "\033[1;32mGamingBurst Panel is already completely up to date!\033[0m"
            else
                echo -e "\033[1;36mUpdate found! Downloading and installing...\033[0m"
                sudo systemctl stop gbpanel && sudo -u gbpanel bash -c "cd /opt/gbpanel/panel && git fetch origin main && git reset --hard origin/main && git pull origin main" && sudo bash /opt/gbpanel/panel/install.sh
                echo -e "\033[1;32mPanel updated successfully!\033[0m"
            fi
            ;;
        12)
            $GB_CMD bg
            ;;
        13)
            echo -e "\033[1;31mWARNING: This will completely delete GamingBurst Panel, including all your Minecraft servers, user data, and files.\033[0m"
            read -p "Are you absolutely sure you want to completely uninstall the panel? (Type 'YES' to confirm): " confirm_uninstall
            if [ "$confirm_uninstall" = "YES" ]; then
                echo "Uninstalling GamingBurst Panel..."
                systemctl stop gbpanel
                systemctl disable gbpanel
                rm -f /etc/systemd/system/gbpanel.service
                systemctl daemon-reload
                rm -f /usr/local/bin/gbpanel /usr/bin/gbpanel /usr/local/bin/gb /usr/bin/gb
                userdel -r gbpanel 2>/dev/null
                rm -rf /opt/gbpanel
                echo -e "\033[1;32mUninstall complete. All files and servers have been deleted.\033[0m"
                exit 0
            else
                echo "Uninstall cancelled."
            fi
            ;;
        0)
            echo "Exiting Menu."
            exit 0
            ;;
        *)
            echo "Invalid option."
            ;;
    esac
    
    echo ""
    read -p "Press [Enter] to return to the menu..."
done
