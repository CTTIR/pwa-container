import fs from 'node:fs';
import { generatePassword, hashPassword } from './auth.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { validateDefinition } from '../shared/schema.ts';

// Files this process creates (databases, routes) are not readable for others on the host.
process.umask(0o027);

// Maintenance commands, run inside the container:
//   node server/cli.ts new-password             (prints a random password and its hash)
//   node server/cli.ts hash-password            (reads the password from stdin)
//   node server/cli.ts validate <survey.json>
//   node server/cli.ts count <surveyId>
//   node server/cli.ts purge <surveyId> --yes   (deletes all responses, e.g. after a test run)

const [command, arg, flag] = process.argv.slice(2);

function readStdin(): string {
  return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

switch (command) {
  case 'new-password': {
    const password = generatePassword();
    console.log(`password: ${password}`);
    console.log(`hash:     ${hashPassword(password)}`);
    break;
  }
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
    if (!store.hasDatabase(arg)) throw new Error(`no database for ${arg}`);
    console.log(store.count(arg));
    store.close();
    break;
  }
  case 'purge': {
    if (!arg || flag !== '--yes') throw new Error('usage: purge <surveyId> --yes');
    const store = new Store(loadConfig().dataDir);
    if (!store.hasDatabase(arg)) throw new Error(`no database for ${arg}`);
    console.log(`deleted ${store.purge(arg)} response(s) of ${arg}`);
    store.close();
    break;
  }
  default:
    console.error('commands: new-password | hash-password | validate <file> | count <surveyId> | purge <surveyId> --yes');
    process.exit(2);
}
