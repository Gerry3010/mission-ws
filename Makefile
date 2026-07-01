# SPDX-License-Identifier: MIT
UUID = mission-ws@geraldhofbauer.net
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = extension.js decorator.js stylesheet.css metadata.json

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
		.

zip: pack

# Launch a throwaway nested shell with the extension enabled (Wayland-safe;
# does not touch your live session).
test: install
	env MUTTER_DEBUG_DUMMY_MODE_SPECS=1400x900 \
		dbus-run-session -- gnome-shell --nested --wayland

lint:
	@command -v eslint >/dev/null 2>&1 && eslint . || \
		echo "eslint not installed; skipping"
