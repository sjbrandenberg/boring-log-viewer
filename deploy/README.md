# Deploying to www.uclageo.com/boring-log-viewer

Written for Rocky Linux 9 with Apache (httpd) and SELinux disabled. There are
two parts:

- **The static page** (`public/`), served by Apache.
- **The render API** (`server/`), a Node process on `127.0.0.1:3000`. Apache
  forwards `/boring-log-viewer/api/` to it.

## What this touches on the server

Everything here adds new things rather than changing existing ones:

- a new folder, `/gmdatabase/sites/uclageo.com/boring-log-viewer`;
- a new systemd service, listening only on localhost;
- and, only if needed, a new Apache config file,
  `/etc/httpd/conf.d/boring-log-viewer.conf`.

The repository's `.htaccess` applies only to `/boring-log-viewer/`, so even a
mistake in it can't affect other sites. The one change with wider reach is
installing Node, covered in step 1.

## 1. Check the server and install Node

```sh
getenforce                                    # expect: Disabled
ls -d /gmdatabase/sites/uclageo.com/coastal_database    # confirms the document root
ls -d /gmdatabase/sites/uclageo.com/boring-log-viewer   # expect: No such file or directory
sudo ss -ltnp | grep ':3000 ' || echo "port 3000 free"
rpm -q ntopng ntop                            # expect: not installed
httpd -M 2>/dev/null | grep -E 'rewrite|proxy_module|proxy_http'   # all three are loaded by default on Rocky
```

Node 22 or newer is required. Before installing or upgrading it, check whether
anything else on the server already uses Node. Replacing the system Node could
break it.

```sh
command -v node && node -v
ps aux | grep -v grep | grep -i node
systemctl list-units --type=service | grep -i node
```

If nothing else uses Node, install version 22 from Rocky's own repositories
(AppStream). There's no need to add the NodeSource repository:

```sh
sudo dnf module reset -y nodejs
sudo dnf module enable -y nodejs:22
sudo dnf install -y nodejs
node -v                                       # v22.x
```

If another program needs an older Node, don't change the system Node. Install
Node 22 in a separate folder (for example, the official tarball unpacked in
`/opt/node22`) and point `ExecStart` in the service file at `/opt/node22/bin/node`.

## 2. Clone and build

```sh
APP=/gmdatabase/sites/uclageo.com/boring-log-viewer
sudo git clone https://github.com/sjbrandenberg/boring-log-viewer.git "$APP"
cd "$APP"
sudo npm ci
sudo npm run build          # creates public/
sudo npm test               # should end with: pass 51, fail 0
```

The files are owned by root and readable by everyone, so Apache and the
`apache` user that runs the service can read them without owning them.

If `npm ci` or the tests report a missing `@resvg/resvg-js-linux-…` package,
run `sudo npm install` once. That fetches the Linux build of the image library;
the lockfile was made on Windows.

Now open <https://www.uclageo.com/boring-log-viewer/>. The page should load and
draw the example. `/api/` won't work until steps 3 and 4.

## 3. Run the API as a service

The service file's defaults already match this layout (the path above, the
`apache` user, `/usr/bin/node`):

```sh
sudo cp "$APP/deploy/boring-log-viewer.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now boring-log-viewer
systemctl status boring-log-viewer --no-pager     # expect: active (running)
curl -s http://127.0.0.1:3000/api/health          # expect: {"status":"ok","version":"0.1.0",...}
```

If it isn't running, `journalctl -u boring-log-viewer -n 50` shows why.
Settings are the `Environment=` lines in the service file: `PORT`, `HOST`,
`RATE_LIMIT` (requests per minute per client) and `LOG_LEVEL`. It also has
optional `MemoryMax` and `CPUQuota` caps, commented out.

## 4. Connect Apache to the API

Rocky's Apache already loads `mod_rewrite`, `mod_proxy` and `mod_proxy_http`,
and SELinux is disabled, so the repository's `.htaccess` should forward
`/boring-log-viewer/api/` to the service with no extra configuration. Test it:

```sh
curl -s https://www.uclageo.com/boring-log-viewer/api/health
curl -s -X POST -H "Content-Type: application/json" --data-binary @"$APP/tests/fixtures/coastal-style.json" \
     "https://www.uclageo.com/boring-log-viewer/api/render?format=png" -o /tmp/test.png && file /tmp/test.png
# expect: PNG image data, 1636 x 1630
```

### Only if the page or the API doesn't work

Add a config file just for this folder. Don't change `AllowOverride` for the
whole document root: other folders may contain `.htaccess` files that are
ignored today and would suddenly start applying.

```sh
sudo tee /etc/httpd/conf.d/boring-log-viewer.conf >/dev/null <<'EOF'
# Let the repository's .htaccess work in this folder only.
<Directory "/gmdatabase/sites/uclageo.com/boring-log-viewer">
    AllowOverride All
    Options -Indexes
</Directory>

# Uncomment if /boring-log-viewer/api/ still returns 404 after the block above.
#ProxyPass        /boring-log-viewer/api/ http://127.0.0.1:3000/api/
#ProxyPassReverse /boring-log-viewer/api/ http://127.0.0.1:3000/api/
EOF
sudo apachectl configtest && sudo systemctl reload httpd
```

`apachectl configtest` checks the configuration before anything changes; if
it reports an error, the live sites are untouched. `reload` doesn't drop
current visitors.

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| The page shows a file listing or README instead of the viewer | `.htaccess` is being ignored. Add the `<Directory>` block from step 4. |
| The page is 404 or blank | `npm run build` wasn't run, so `public/` doesn't exist. |
| `/api/…` gives 503 Service Unavailable | Apache reaches the proxy but the service is down. Check `systemctl status boring-log-viewer`. |
| `/api/…` gives 404 | The proxy isn't active. Uncomment the `ProxyPass` lines in step 4. |
| Port 3000 is taken | Change `PORT` in the service file and `3000` in `.htaccess`. Commit that change to the repository rather than editing on the server, or later `git pull`s will conflict. |
| API requests fail after SELinux is turned on | Port 3000 is labeled for ntop. Move the API to an unlabeled port, label it `http_port_t`, and run `setsebool -P httpd_can_network_relay 1`. |

## 6. Updating

```sh
cd /gmdatabase/sites/uclageo.com/boring-log-viewer
sudo git pull
sudo npm ci
sudo npm run build
sudo systemctl restart boring-log-viewer
```

If the update changed `deploy/boring-log-viewer.service`, copy it again and run
`sudo systemctl daemon-reload` before restarting.
