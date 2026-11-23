'use strict';
// Příkazová řádka: run(argv, { lib, today }) → { code, out }. Příkazy jsou v commands/*.js.
const books = require('./commands/books');
const members = require('./commands/members');
const loans = require('./commands/loans');
const report = require('./commands/report');

const COMMANDS = { ...books, ...members, ...loans, ...report };
const USAGE = 'použití: ' + Object.values(COMMANDS).map((c) => c.usage).join(' | ');

function run(argv, ctx) {
  const [name, ...args] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) return { code: 2, out: USAGE };
  if (args.length < cmd.min || args.length > (cmd.max ?? cmd.min)) return { code: 2, out: USAGE };
  try {
    return cmd.run(args, ctx);
  } catch (e) {
    return { code: 1, out: e.message };
  }
}
module.exports = { run, USAGE, COMMANDS };
