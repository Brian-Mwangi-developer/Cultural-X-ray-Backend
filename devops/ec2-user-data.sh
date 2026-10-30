#!/usr/bin/env bash
# First boot of the EC2 host (Ubuntu 24.04): Docker with the Compose plugin, and 2 GB of swap
# so an ffmpeg spike in the worker slows down instead of being killed. Passed as user data.
set -euxo pipefail

fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
sysctl --system

curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
systemctl enable --now docker

mkdir -p /opt/xray/rabbitmq
chown -R ubuntu: /opt/xray
