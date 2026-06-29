#!/usr/bin/env node
'use strict';

// Thin wrapper so `sudo gbpanel` works when symlinked to /usr/local/bin
const path = require('path');
process.chdir(path.join(__dirname));
require('./bin/gbpanel.js');
