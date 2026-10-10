import path from 'node:path';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../src/api/types/collaboration';
import { startCollaborationServer, type CollaborationServerOptions } from './server';

function parseArgs(argv: string[]): CollaborationServerOptions {
  const options: CollaborationServerOptions = {
    host: '127.0.0.1',
    port: 12345,
    dataDir: path.resolve('.aeonstagery-collab'),
    accessToken: process.env.AEONSTAGERY_COLLAB_TOKEN,
    password: process.env.AEONSTAGERY_COLLAB_PASSWORD,
    allowedOrigins: process.env.AEONSTAGERY_COLLAB_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host' && next) {
      options.host = next;
      i++;
    } else if (arg === '--port' && next) {
      options.port = Number(next);
      i++;
    } else if (arg === '--data-dir' && next) {
      options.dataDir = path.resolve(next);
      i++;
    } else if ((arg === '--schema-version' || arg === '--collaboration-schema-version') && next) {
      const schemaVersion = Number(next);
      if (
        schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2 &&
        schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
      ) {
        throw new Error(
          `Only collaboration schema versions ${COLLABORATION_SCHEMA_VERSION_V2} and ${COLLABORATION_SCHEMA_VERSION_V3} are supported`,
        );
      }
      options.schemaVersion = schemaVersion;
      i++;
    }
  }

  return options;
}

void startCollaborationServer(parseArgs(process.argv.slice(2)))
  .then((server) => {
    const status = server.getStatus();
    console.log(`[collab] listening on ${status.localUrl}`);
    console.log(`[collab] schema version: ${status.schemaVersion}`);
    for (const url of status.lanUrls) {
      if (url !== status.localUrl) console.log(`[collab] LAN: ${url}`);
    }
    if (status.connectionPassword) console.log(`[collab] password (keep private): ${status.connectionPassword}`);
    for (const url of status.inviteUrls) console.log(`[collab] invite (keep private): ${url}`);
    console.log(`[collab] data dir: ${status.dataDir}`);
  })
  .catch((error) => {
    console.error('[collab] failed to start:', error);
    process.exitCode = 1;
  });
