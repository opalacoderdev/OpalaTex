const path = require('path');
const preset = require('../core/tailwind-preset.cjs');

module.exports = {
  presets: [preset],
  important: '.ep-root',
  content: [path.join(__dirname, '**/*.{ts,tsx}')],
};
