// Convenience launcher: run TrainTrack on port 5050.
// Port 3000 is taken on this machine by Pronto's LocalAgent, and `npm start` defaults to 3000,
// so this pins 5050. Portable — no shell env syntax — works identically in cmd, PowerShell and
// Git Bash via `npm run start:5050`. server.js exports start(); we set PORT then call it.
'use strict';

process.env.PORT = process.env.PORT || '5050';

require('./server').start().catch((e) => {
  console.error('TrainTrack startup failed:', (e && e.message) || e);
  process.exit(1);
});
