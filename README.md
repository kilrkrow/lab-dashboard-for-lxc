# Haven Lab Dashboard

A premium, lightweight, fully static homelab dashboard featuring a modern glassmorphism design. Built specifically to be hosted on ultra-low-resource environments (like Proxmox LXC containers or basic Nginx servers) without the heavy overhead of Docker containers.

![Haven Lab Dashboard Screenshot](public/icons.svg) <!-- Replace with an actual screenshot -->

## Features
- 🚀 **Zero Overhead**: Compiles to pure static HTML/JS/CSS. Can run on an LXC with 30MB of RAM.
- 🎨 **Glassmorphism UI**: Dynamic radial gradients, backdrop blurs, and micro-animations.
- 🔍 **Real-time Search**: Instantly filter hundreds of tiles.
- 🔤 **Category Sorting**: Independent A-Z sorting toggles per category.
- ✏️ **Web Editor Integration**: Link your configuration directly to your private GitHub repo for seamless in-browser editing.
- 🖼️ **Smart Icons**: Uses the [walkxcode/dashboard-icons](https://github.com/walkxcode/dashboard-icons) CDN. Falls back to a smart letter avatar if an icon fails to load.

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/kilrkrow/lab-dashboard-for-lxc.git
   cd lab-dashboard-for-lxc
   npm install
   ```

2. Copy the example configuration to create your own:
   ```bash
   cp public/config.example.json public/config.json
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

## Configuration (`config.json`)

All dashboard data is loaded dynamically at runtime via `public/config.json`. Because it is loaded at runtime, **you should add `public/config.json` to your `.gitignore`** so you don't accidentally push your private internal IPs to a public repository!

### The "Edit Config" Pencil Icon
To make editing your dashboard completely frictionless, you can host your `config.json` in a separate *private* GitHub repository. 

If you add the `editConfigUrl` field to your config, a "Pencil" icon will appear in the top right of the dashboard. When clicked, it will open GitHub's beautiful web-based JSON editor right to your config file!

```json
{
  "title": "My Home Lab",
  "editConfigUrl": "https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO/edit/main/config.json"
}
```

## Advanced: Live "GitOps" Configuration via Nginx
If you store your `config.json` in a private GitHub repository, you can configure your Nginx server to securely fetch the configuration live from GitHub every time the page loads. This means you **never** have to manually update or copy files to your server after editing your config!

Simply add this `location` block to your Nginx configuration (usually `/etc/nginx/sites-available/default`) right above the standard `/` location block. Replace the GitHub URL and insert your Personal Access Token.

```nginx
server {
    listen 80;
    root /var/www/html;
    index index.html;

    # Intercept config.json and fetch securely from private GitHub repo
    location = /config.json {
        resolver 8.8.8.8;
        proxy_pass https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_PRIVATE_REPO/main/config.json;
        proxy_set_header Authorization "token YOUR_GITHUB_PAT";
        proxy_hide_header Authorization;
        proxy_ssl_server_name on;
    }

    # Serve the static React application normally
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## Finding Icons
This dashboard natively relies on the massive [walkxcode/dashboard-icons](https://github.com/walkxcode/dashboard-icons) collection. 
Simply find the app you want in their repo, and use the raw CDN link:
`https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/[icon-name].png`

## Building for Production

When you are ready to deploy:
```bash
npm run build
```

This will generate a `dist/` directory. Simply copy the contents of `dist/` to any standard web server (like `/var/www/html/` on an Nginx server). Because the configuration is dynamically fetched at runtime, you can just drop your private `config.json` right next to the compiled `index.html`.
