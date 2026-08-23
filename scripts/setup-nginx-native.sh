#!/usr/bin/env bash
set -euo pipefail

# Installs and configures nginx natively for local dev (no Docker).
# Uses a project-specific site file (/etc/nginx/sites-available/jtrack) plus
# a sites-enabled symlink, so this project coexists with other projects that
# share the same machine-level nginx installation.
# Run once, then services run via `pnpm dev` and nginx proxies on port 80.

SITE_NAME="jtrack"
CONF_SRC="$(dirname "$0")/../nginx/local/conf.d/jtrack.conf"
AVAILABLE="/etc/nginx/sites-available/$SITE_NAME"
ENABLED="/etc/nginx/sites-enabled/$SITE_NAME"

echo "==> Installing nginx (idempotent)..."
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt install -y nginx
fi

# Keep the machine's default site intact. If a previous run of the OLD version
# of this script overwrote /etc/nginx/sites-available/default with the J-Track
# config, restore a stock placeholder there so the machine default is usable again.
if sudo grep -q "Local dev nginx config (no Docker, nginx installed natively)" /etc/nginx/sites-available/default 2>/dev/null; then
  echo "==> Restoring stock default site (old setup had overwritten it)..."
  sudo tee /etc/nginx/sites-available/default >/dev/null <<'EOF'
# Default server configuration (stock "Welcome to nginx" placeholder)
server {
	listen 80 default_server;
	listen [::]:80 default_server;

	root /var/www/html;

	index index.html index.htm index.nginx-debian.html;

	server_name _;

	location / {
		try_files $uri $uri/ =404;
	}

	location = /favicon.ico {
		log_not_found off;
		access_log off;
	}

	location /50x.html {
		root /var/www/html;
	}
}
EOF
fi

echo "==> Installing J-Track site as $AVAILABLE..."
sudo cp "$CONF_SRC" "$AVAILABLE"

echo "==> Enabling site via $ENABLED symlink..."
sudo ln -sfn "$AVAILABLE" "$ENABLED"

echo "==> Adding jtrack.localhost to /etc/hosts..."
if ! grep -q "jtrack.localhost" /etc/hosts; then
  echo "127.0.0.1 jtrack.localhost" | sudo tee -a /etc/hosts >/dev/null
fi

echo "==> Testing nginx config..."
sudo nginx -t

echo "==> Restarting nginx..."
sudo systemctl restart nginx

echo ""
echo "Done! J-Track is served at:"
echo "  http://jtrack.localhost   (project-specific host)"
echo "  http://localhost          (kept working for the existing frontend)"
echo ""
echo "Usage:"
echo "  Start : sudo systemctl start nginx"
echo "  Stop  : sudo systemctl stop nginx"
echo "  Status: sudo systemctl status nginx"
echo "  Logs  : sudo tail -f /var/log/nginx/access.log"
echo ""
echo "Other projects install their own file under /etc/nginx/sites-available/"
echo "and link it into /etc/nginx/sites-enabled/ — no conflicts."