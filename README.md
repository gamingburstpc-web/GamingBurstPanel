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

## 🕹️ Interactive Menu (`gbpanel`)

For the easiest experience, simply type `gbpanel` in your terminal as `root` to launch the interactive UI menu.

```bash
gbpanel
```
This graphical menu allows you to press numbers (0-9) to quickly add users, view servers, check panel logs, and restart the daemon without memorizing any long commands!

---

## 📟 Command Reference (Direct CLI)

If you prefer to run single commands directly (e.g. for scripts), you can pass arguments to `gbpanel`. 

> [!TIP]
> **Smart Wrapper**
> Because `gbpanel` is now a smart system wrapper, you do **not** need to type `sudo -u gbpanel` anymore. The shortcut automatically assumes the correct permissions securely for you in the background!

| Command | Action | Description |
| :--- | :--- | :--- |
| `gbpanel user add` | **Add User** | Create a new user with interactive masked password and role prompt. |
| `gbpanel user list` | **List Users** | Show all registered panel users, their roles, and creation dates. |
| `gbpanel user remove <username>` | **Delete User** | Delete a user account (asks for confirmation). |
| `gbpanel user reset-password <username>` | **Reset Password** | Reset the password of an existing user account. |
| `gbpanel server list` | **List Servers** | Show all servers, ports, online status, and paths. |
| `gbpanel server path <server_name>` | **Get Path** | Print the absolute directory path of a server. |

### 📂 Quick CD to Server Folder
To quickly jump into a server's folder in your SSH console, run:
```bash
cd $(gbpanel server path <server_name>)
```

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
