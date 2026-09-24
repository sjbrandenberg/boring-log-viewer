# Deploying to www.uclageo.com/boring-log-viewer

There are two parts:

- **The static page** (`public/`), served by Apache.
- **The render API** (`server/`), a Node process on `127.0.0.1:3000`. Apache
  forwards `/boring-log-viewer/api/` to it.

## First install

```sh
git clone https://github.com/sjbrandenberg/boring-log-viewer.git   # into the directory served as /boring-log-viewer
cd boring-log-viewer
npm ci
npm run build          # writes public/
npm test               # optional: runs the test suite on the server
```

Then start the API (see below) and check:

```sh
curl http://127.0.0.1:3000/api/health                         # the Node process
curl https://www.uclageo.com/boring-log-viewer/api/health      # through Apache
```

## Each update

```sh
git pull
npm ci
npm run build
# then restart the API: systemctl restart boring-log-viewer   (or: pm2 restart boring-log-viewer)
```

## Keeping the API running

Use one of these.

- **systemd** (needs root): `deploy/boring-log-viewer.service` has install
  instructions at the top. Edit `WorkingDirectory`, `User` and the node path
  first.
- **pm2** (no root needed):
  ```sh
  npm install -g pm2
  PORT=3000 pm2 start server/index.js --name boring-log-viewer
  pm2 save
  pm2 startup      # prints the command that restarts pm2 at boot
  ```

Settings (environment variables): `PORT` (default 3000), `HOST` (default
127.0.0.1), `RATE_LIMIT` (requests per minute per client, default 60),
`LOG_LEVEL` (default info).

## Apache

The repository's `.htaccess` handles both parts when the directory allows
overrides (`AllowOverride All`, as for the CakePHP apps):

- `api/...` is proxied to Node. This needs `mod_proxy` and `mod_proxy_http`.
  Without them the rule is skipped and `/api/` returns 404.
- Everything else is served from `public/`.

If `.htaccess` proxying isn't allowed, put this in the virtual host instead. It
must come before anything else that handles `/boring-log-viewer`.

```apache
ProxyPass        /boring-log-viewer/api/ http://127.0.0.1:3000/api/
ProxyPassReverse /boring-log-viewer/api/ http://127.0.0.1:3000/api/
```

The API trusts `X-Forwarded-For` only from 127.0.0.1, so rate limiting applies
to the real client and not to Apache. If Apache runs on a different machine,
change `trustProxy` in `server/app.js`.
