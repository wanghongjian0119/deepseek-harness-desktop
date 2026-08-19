#!/bin/sh
# Deb post-install. electron-builder REPLACES the default postinst when
# afterInstall is set, so this script restores every default responsibility:
#
# 1. the /usr/bin launcher link (update-alternatives, as the default does);
# 2. the SUID chrome-sandbox helper. The default postinst only sets mode
#    4755 when its userns probe fails — but the probe runs as root, where
#    `unshare --user true` always succeeds, so it never sets the setuid bit
#    and Chromium 150 aborts at startup ("click does nothing"). Chromium
#    requires either a usable SUID helper or a working unprivileged userns,
#    so set 4755 unconditionally (the helper is root-owned by the deb);
# 3. the desktop-database and hicolor icon cache, so the launcher shows the
#    icon without a logout/login.
set -e

if type update-alternatives >/dev/null 2>&1; then
  # Remove a previous link that does not use update-alternatives.
  if [ -L '/usr/bin/dsh-desktop' ] && [ -e '/usr/bin/dsh-desktop' ] \
    && [ "$(readlink '/usr/bin/dsh-desktop')" != '/etc/alternatives/dsh-desktop' ]; then
    rm -f '/usr/bin/dsh-desktop'
  fi
  update-alternatives --install '/usr/bin/dsh-desktop' 'dsh-desktop' '/opt/DeepSeek Harness/dsh-desktop' 100 \
    || ln -sf '/opt/DeepSeek Harness/dsh-desktop' '/usr/bin/dsh-desktop'
else
  ln -sf '/opt/DeepSeek Harness/dsh-desktop' '/usr/bin/dsh-desktop'
fi

APP_DIR="$(dirname "$(readlink -f '/usr/bin/dsh-desktop' 2>/dev/null || echo '/opt/DeepSeek Harness/dsh-desktop')")"
chmod 4755 "$APP_DIR/chrome-sandbox" || true
chmod 755 "$APP_DIR/dsh-desktop-launcher" || true

# electron-builder derives Exec from linux.executableName and rejects an
# override, so point the installed desktop entry at the sandbox-fallback
# wrapper after the fact.
sed -i 's|^Exec=.*|Exec="/opt/DeepSeek Harness/dsh-desktop-launcher" %U|' /usr/share/applications/dsh-desktop.desktop

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
