import fs from 'node:fs';
import { hashPassword } from './auth.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { validateDefinition } from '../shared/schema.ts';

// Maintenance commands, run inside the container:
//   node server/cli.ts hash-password            (reads the password from stdin)
//   node server/cli.ts validate <survey.json>
//   node server/cli.ts count <surveyId>
//   node server/cli.ts purge <surveyId> --yes   (deletes all responses, e.g. after a test run)

const [command, arg, flag] = process.argv.slice(2);

function readStdin(): string {
  return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

switch (command) {
  case 'hash-password': {
    console.log(hashPassword(readStdin()));
    break;
  }
  case 'validate': {
    if (!arg) throw new Error('usage: validate <survey.json>');
    const errors = validateDefinition(JSON.parse(fs.readFileSync(arg, 'utf8')));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    console.log('valid');
    break;
  }
  case 'count': {
    if (!arg) throw new Error('usage: count <surveyId>');
    const store = new Store(loadConfig().dataDir);
    console.log(store.count(arg));
    store.close();
    break;
  }
  case 'purge': {
    if (!arg || flag !== '--yes') throw new Error('usage: purge <surveyId> --yes');
    const store = new Store(loadConfig().dataDir);
    console.log(`deleted ${store.purge(arg)} response(s) of ${arg}`);
    store.close();
    break;
  }
  default:
    console.error('commands: hash-password | validate <file> | count <surveyId> | purge <surveyId> --yes');
    process.exit(2);
}
