#!/usr/bin/env bash
# Opens a terminal shell with `bgit` ready to use.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$DIR:$PATH"
cd "$DIR" || exit 1
clear
echo "bgit - versioned backups for any mounted storage"
echo
echo "  bgit --help                     show all commands"
echo "  bgit formats                    formats available here"
echo "  bgit sync --src DIR --dst DIR   dry run (nothing written)"
echo "  bgit sync --src DIR --dst DIR --commit"
echo
echo "Example:"
echo "  bgit sync --src ~/Documents --dst /mnt/nas/backup --commit"
echo
exec "${SHELL:-bash}"
