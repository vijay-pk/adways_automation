#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 22.04/24.04 VPS. Run as root (or with sudo).
# Installs Docker, firewall (SSH/HTTP/HTTPS only), automatic security updates and swap,
# then clones the repository to /opt/course-tutor.
set -euo pipefail
REPO="${REPO:-https://github.com/vijay-pk/adways_automation.git}"
DIR=/opt/course-tutor

apt-get update
apt-get install -y ca-certificates curl git ufw unattended-upgrades

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

dpkg-reconfigure -f noninteractive unattended-upgrades

# 2 GB swap helps image builds on small servers.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
mkdir -p "$DIR/backups" && chown 1000:1000 "$DIR/backups"
chmod +x "$DIR"/deploy/*.sh

echo
echo "Done. Next steps:"
echo "  1. cp $DIR/server/.env.production.example $DIR/server/.env.production && chmod 600 $DIR/server/.env.production"
echo "  2. Edit it with your Supabase, Groq and embedding credentials."
echo "  3. Point automation.adwaysacademy.com (A record) to this server's IP, wait for DNS."
echo "  4. cd $DIR && ./deploy/deploy.sh"
