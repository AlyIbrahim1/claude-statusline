#!/usr/bin/env node
'use strict';
// npm 7+ does not run uninstall scripts; this only helps older npm. Users should run
// `claude-statusline uninstall` before `npm uninstall -g`.
const { uninstall } = require('./uninstall');

try {
	uninstall();
} catch (e) {} // fully silent — best-effort cleanup
process.exit(0);
