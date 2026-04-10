'use strict';

function normalizeProjectSlug(projectPath) {
  return String(projectPath || '').replace(/[/\\]/g, '-');
}

module.exports = { normalizeProjectSlug };
