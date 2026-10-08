import { createServer } from 'node:http';

const shell = (title, body) => `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:20px system-ui;max-width:540px;margin:32px auto;padding:16px}label{display:block;margin:20px 0}input,select,button{font:inherit}input[type=text],input[type=email]{width:95%}button,a{display:inline-block;padding:12px}</style>${body}`;

// Each run has a loopback server and its own nonce. The check reads this
// process's records; none of the page's success messages count as proof.
export async function serveRealPage(ctx, flow = false) {
  const state = { received: [], events: [], value: '' };
  const prefix = `/${ctx.nonce}/`;
  const server = createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith(prefix)) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (!flow) {
        if (req.method === 'POST' && route === prefix) {
          state.received.push(fields);
          res.end(shell(`Form ${ctx.nonce}`, '<h1>Submitted</h1>'));
        } else if (req.method === 'GET' && route === prefix) {
          res.end(shell(`Form ${ctx.nonce}`, `<h1>Project signup</h1><form method="post">
<label>Name <input name="name" type="text" autocomplete="off"></label>
<label>Email <input name="email" type="email" autocomplete="off"></label>
<label>Team <select name="team"><option>Engineering</option><option>Design</option><option>Operations</option></select></label>
<label><input name="updates" type="checkbox" value="yes"> Send updates</label>
<label>Code <input name="code" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></label>
<button>Submit</button></form>`));
        } else res.writeHead(404).end();
        return;
      }
      const screen = route.slice(prefix.length);
      if (req.method === 'GET' && (screen === '' || screen === 'home')) {
        state.events.push('home');
        // Only the exact fixture value is rendered, so arbitrary POST input
        // cannot become HTML. The check still compares the original value.
        const visible = state.value === `Flow ${ctx.nonce}` ? state.value : 'Not set';
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Profile</h1><p>Saved value: <strong>${visible}</strong></p><a href="${prefix}edit">Edit profile</a>`));
      } else if (req.method === 'GET' && screen === 'edit') {
        state.events.push('edit');
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Edit profile</h1><form method="post" action="${prefix}save"><label>Value <input name="value" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></label><button>Save</button></form>`));
      } else if (req.method === 'POST' && screen === 'save') {
        state.events.push('save');
        state.value = fields.value ?? '';
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Saved</h1><a href="${prefix}home">Back to profile</a>`));
      } else res.writeHead(404).end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  ctx.page = state;
  ctx.url = `http://127.0.0.1:${server.address().port}${prefix}`;
  ctx.closeServer = () => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
    server.closeAllConnections();
  });
}

export function checkForm(ctx) {
  const want = { name: 'Morgan Reed', email: 'morgan@example.test', team: 'Design', updates: 'yes', code: ctx.nonce };
  return ctx.page?.received.some(got => Object.keys(want).every(key => got[key] === want[key]) &&
    Object.keys(got).length === Object.keys(want).length) || 'server has no submission with all five expected values';
}

export function checkFlow(ctx) {
  const events = ctx.page?.events ?? [];
  let stage = 0;
  for (const event of events) if (event === ['edit', 'save', 'home'][stage]) stage++;
  return ctx.page?.value === `Flow ${ctx.nonce}` && stage === 3 && events.at(-1) === 'home' ||
    'server has no saved value ending on the profile screen';
}
