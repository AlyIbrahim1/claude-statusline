#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { getSettingsPath } = require('./config');
const { uninstall } = require('./uninstall');

const FILES = ['history.md', 'history-enable.md', 'history-disable.md', 'history-mode.md'];

try {
	const commandsDir = path.join(path.dirname(getSettingsPath()), 'commands');
	for (const f of FILES) {
		const dest = path.join(commandsDir, f);
		if (fs.existsSync(dest)) fs.unlinkSync(dest);
	}
	uninstall();
} catch (e) {} // fully silent — best-effort cleanup
process.exit(0);
