#!/usr/bin/env bash
set -euo pipefail

# Installs and configures nginx natively for local dev (no Docker).
# Run this once, then services run via `pnpm dev` and nginx proxies on port 80.

echo "==> Installing nginx..."
sudo apt install -y nginx

echo "==> Copying local dev nginx config..."
sudo cp "$(dirname "$0")/../nginx/local/conf.d/default.conf" /etc/nginx/sites-available/default

echo "==> Testing nginx config..."
sudo nginx -t

echo "==> Restarting nginx..."
sudo systemctl restart nginx

echo ""
echo "Done! nginx is running on http://localhost"
echo ""
echo "Usage:"
echo "  Start : sudo systemctl start nginx"
echo "  Stop  : sudo systemctl stop nginx"
echo "  Status: sudo systemctl status nginx"
echo "  Logs  : sudo tail -f /var/log/nginx/access.log"
echo ""
echo "Run 'pnpm dev' in another terminal to start services."
echo "Frontend calls http://localhost/api/auth/... etc."
