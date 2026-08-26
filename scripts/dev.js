#!/usr/bin/env node

const { createDevServer } = require("@supa-media/dev");

createDevServer({ cwd: process.cwd(), args: process.argv.slice(2) });
