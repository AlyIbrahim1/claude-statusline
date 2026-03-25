#!/usr/bin/env node
'use strict';
const { uninstall } = require('./uninstall');
try { uninstall(); } catch (e) {} // fully silent — best-effort cleanup
process.exit(0);
