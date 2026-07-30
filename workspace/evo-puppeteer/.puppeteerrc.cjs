const { join } = require('node:path');

// Chrome baixado dentro do projeto para não depender do cache global da máquina.
module.exports = {
  cacheDir: join(__dirname, '.cache', 'puppeteer'),
};
