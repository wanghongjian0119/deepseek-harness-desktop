#!/bin/sh
# Deb post-remove. electron-builder REPLACES the default postrm when
# afterRemove is set, so this script restores the default responsibility
# (dropping the /usr/bin launcher link) and refreshes the desktop-database
# and hicolor icon cache.
set -e

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove 'dsh-desktop' '/opt/DeepSeek Harness/dsh-desktop' >/dev/null 2>&1 || true
fi
rm -f '/usr/bin/dsh-desktop'

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
