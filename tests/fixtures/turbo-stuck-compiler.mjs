import { writeFileSync } from 'node:fs';

// No native code, app or window. This compiler never exits without collection.
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
