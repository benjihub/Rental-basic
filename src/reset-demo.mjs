import { existsSync, rmSync } from 'node:fs';
import { DB_PATH } from './db.mjs';
if(existsSync(DB_PATH)) rmSync(DB_PATH);
console.log('Database deleted. Run npm start to recreate demo data.');
