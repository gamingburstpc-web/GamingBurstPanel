# 🎮 GamingBurst Panel

An ultra-lightweight, high-performance monolithic control panel for managing Minecraft servers. Built specifically to run on low-resource VPS nodes with near-zero idle memory footprint.

---

## 🚀 One-Line Installation

Run this command on your fresh Ubuntu 22.04 or Debian 12 VPS to automatically install Node.js, Java 21, configure the panel daemon, setup global commands, and open the firewall ports:

```bash
sudo apt-get update && sudo apt-get install -y curl && \
curl -sSL https://raw.githubusercontent.com/gamingburstpc-web/GamingBurstPanel/main/install.sh | sudo bash
```

---

## 🔑 Initial Setup

After installation, the panel will start on port **`7676`**. Open your browser and navigate to:
```
http://your_vps_ip:7676
```

Because no users exist, it will prompt you to create the first admin user. Run the following command in your SSH terminal to bootstrap the panel:

```bash
sudo -u gbpanel gbpanel user add
```

---

## 📟 Command Reference (`gbpanel` CLI)

You can run these commands from any directory on your VPS. Always prepend with `sudo -u gbpanel` to ensure files are saved with correct permissions.

| Command | Action | Description |
| :--- | :--- | :--- |
| `sudo -u gbpanel gbpanel user add` | **Add User** | Create a new user with interactive masked password and role prompt. |
| `sudo -u gbpanel gbpanel user list` | **List Users** | Show all registered panel users, their roles, and creation dates. |
| `sudo -u gbpanel gbpanel user remove <username>` | **Delete User** | Delete a user account (asks for confirmation). |
| `sudo -u gbpanel gbpanel user reset-password <username>` | **Reset Password** | Reset the password of an existing user account. |

---

## ⚙️ Daemon Management (`systemctl`)

The panel runs in the background as a systemd service (`gbpanel.service`) and will auto-start when the VPS boots up.

* **Check if panel is running:**
  ```bash
  systemctl status gbpanel
  ```

* **Restart the panel:**
  ```bash
  sudo systemctl restart gbpanel
  ```

* **Stop the panel:**
  ```bash
  sudo systemctl stop gbpanel
  ```

* **Start the panel:**
  ```bash
  sudo systemctl start gbpanel
  ```

* **View live logs of the panel background process:**
  ```bash
  journalctl -u gbpanel -f
  ```

---

## 🔒 Firewall and Port Configuration

The installer opens the following ports on UFW automatically:
* **`7676` (TCP)** — Web Panel access.
* **`25565 - 25575` (TCP)** — Minecraft game ports.
