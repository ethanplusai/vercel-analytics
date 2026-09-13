#!/usr/bin/env node
const [major] = process.versions.node.split('.').map(Number);

if (major < 20) {
  console.error(`vercel-analytics needs Node 20 or newer. You are on ${process.versions.node}.`);
  console.error('Install a newer Node (https://nodejs.org) and try again.');
  process.exit(1);
}

const { main } = await import('../server.js');
await main();
