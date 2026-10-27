const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 180_000,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    // The same test on a page that keeps the files in IndexedDB. It must fail.
    { name: 'idbfs-control', use: { browserName: 'chromium' }, metadata: { control: true } },
  ],
});
