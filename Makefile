# SPDX-License-Identifier: MIT
UUID = mission-ws@geraldhofbauer.net
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = extension.js decorator.js appgrid.js stylesheet.css metadata.json

.PHONY: install install-link uninstall enable disable pack zip test lint

# Copy the extension into the user extensions dir (for real sessions).
install:
	rm -rf "$(EXTDIR)"
	mkdir -p "$(EXTDIR)"
	cp -r $(SOURCES) "$(EXTDIR)/"
	@echo "Installed to $(EXTDIR)"

# Symlink instead of copy (handy during development).
install-link:
	rm -rf "$(EXTDIR)"
	ln -s "$(CURDIR)" "$(EXTDIR)"
	@echo "Linked $(CURDIR) -> $(EXTDIR)"

uninstall:
	rm -rf "$(EXTDIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Build a distributable zip via the official tool.
pack:
	gnome-extensions pack --force \
		--extra-source=decorator.js \
		--extra-source=appgrid.js \
		.

zip: pack

# Launch a throwaway nested shell with the extension enabled, in a window
# (Wayland-safe; does not touch your live session). GNOME 48+ dropped the old
# `--nested` flag; the current dev path is `--devkit`, which runs a headless
# no-modeset shell (no seat/logind conflict) shown by the mutter-devkit viewer.
# Requires the `mutter-devkit` package (Arch/Manjaro: `pacman -S mutter-devkit`).
test: install
	dbus-run-session -- gnome-shell --devkit

lint:
	@command -v eslint >/dev/null 2>&1 && eslint . || \
		echo "eslint not installed; skipping"
