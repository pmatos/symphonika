# Service config file name

Symphonika's service config file is named `symphonika.yml`. The CLI first uses `./symphonika.yml` when the current directory provides one, otherwise it uses the initialized user config at `$XDG_CONFIG_HOME/symphonika/symphonika.yml` (or `~/.config/symphonika/symphonika.yml`). The name makes the file's owner explicit, avoids confusion with repository-owned `WORKFLOW.md`, and gives agents a stable path to inspect when operating the local daemon.
