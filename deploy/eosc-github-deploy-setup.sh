#!/bin/bash
# One-time setup on the EOSC VM for deploys from GitHub Actions (.github/workflows/deploy-eosc.yml).
# Run from a copy of this deploy/ folder, after eosc-assistant.sh has installed the service:
#
#   sudo bash eosc-github-deploy-setup.sh "ssh-ed25519 AAAA… github-actions-deploy"
#
# Creates a `deploy` user whose only key may run `/usr/local/sbin/iamparis-deploy <commit>` as root
# (a forced command: no shell, no forwarding). Safe to run again; it replaces the key.
set -euo pipefail
cd "$(dirname "$0")"

key="${1:?Give the public half of the GitHub deploy key}"
if ! [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]]; then
  echo "Expected one ssh-ed25519 public key." >&2
  exit 1
fi

install -m 755 -o root -g root iamparis-deploy /usr/local/sbin/iamparis-deploy
id deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/iamparis-deploy *' >/etc/sudoers.d/iamparis-deploy
chmod 440 /etc/sudoers.d/iamparis-deploy
visudo -cqf /etc/sudoers.d/iamparis-deploy

home=$(getent passwd deploy | cut -d: -f6)
install -d -m 700 -o deploy -g deploy "$home/.ssh"
printf '%s %s\n' \
  'command="sudo -n /usr/local/sbin/iamparis-deploy \"$SSH_ORIGINAL_COMMAND\"",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty' \
  "$key" >"$home/.ssh/authorized_keys"
chown deploy:deploy "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
echo "Deploy key installed for user deploy."
