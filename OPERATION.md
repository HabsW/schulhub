# SchulHub — Betrieb (Produktion)

This guide covers running SchulHub in **production mode** on this CachyOS machine:
starting/stopping, auto-start, Cloudflare Tunnel + HTTPS, Microsoft login, and
troubleshooting. It assumes the setup below is already done where noted.

---

## 1. Quick reference (commands)

| Task | Command |
|---|---|
| Start the app | `systemctl --user start schulhub` |
| Stop the app | `systemctl --user stop schulhub` |
| Restart the app | `systemctl --user restart schulhub` |
| Check status | `systemctl --user status schulhub` |
| Follow the log | `journalctl --user -u schulhub -f` |
| See last log lines | `journalctl --user -u schulhub -n 100` |
| Start the tunnel | `systemctl --user start cloudflared` |
| Follow tunnel log | `journalctl --user -u cloudflared -f` |

The app itself is started with `node src/server.js` (this is `npm start`).
**Do not** use `npm run dev` for production — that is the local demo/test mode
(red banner, demo data, no Microsoft login).

> Production mode refuses to start with an incomplete or unsafe configuration
> and prints a German message telling you exactly what to fix. See
> “Troubleshooting” below.

---

## 2. Start and stop the production app

A systemd **user service** is already installed and enabled:

- Service file: `~/.config/systemd/user/schulhub.service`
- It runs `/usr/bin/node src/server.js` in `/home/habsw/schulhub`, restarts
  automatically on crash, and reads configuration from `schulhub/.env`.

```bash
systemctl --user start schulhub      # start
systemctl --user stop schulhub       # stop
systemctl --user restart schulhub    # restart (after changing .env)
systemctl --user status schulhub     # is it running?
journalctl --user -u schulhub -f     # live log
```

After you edit `.env`, always restart:

```bash
systemctl --user restart schulhub
```

To **stop it and keep it from auto-starting**:

```bash
systemctl --user disable --now schulhub
```

To turn auto-start back on:

```bash
systemctl --user enable --now schulhub
```

---

## 3. Restart after reboot (auto-start)

By default the service starts when you **log in** to your desktop (KDE Plasma).
It is already enabled for that.

If you want the app to start **after a reboot without logging in** (a real
server), enable “linger” for your user once:

```bash
sudo loginctl enable-linger habsw
```

After that, the `schulhub` service starts at boot. To verify after a reboot:

```bash
systemctl --user is-active schulhub
```

(If the Cloudflare tunnel is also enabled — see below — it, too, starts at boot.)

---

## 4. Cloudflare Tunnel + HTTPS

### 4.1 The two-domain rule (important)

SchulHub requires **two separate domains** on purpose. Apps run on their own
domain so that a malicious app **cannot set cookies for the Hub** (a real
security boundary, not a formality). The Hub and the apps may **not** share a
registrable domain — so `apps.example.com` under a Hub on `example.com` is
**rejected** by the server.

You need:

1. **Hub domain** — e.g. `hub.meine-schule.de` (this is `BASE_URL` in `.env`)
2. **Apps domain** — a *second* domain, e.g. `meine-schule-apps.de`, with a
   **wildcard** DNS record `*.meine-schule-apps.de` (this is `APPS_DOMAIN`)

If you currently have only one domain, add a second one in Cloudflare (a cheap
`…-apps` domain is enough) — the whole architecture depends on it.

### 4.2 One-time setup (only if you haven't yet)

`cloudflared` is already installed at `~/.local/bin/cloudflared`.

```bash
# 1) Authorise this machine (opens a browser; click "authorise"):
cloudflared tunnel login

# 2) Create a tunnel — prints a TUNNEL_UUID and creates ~/.cloudflared/<UUID>.json
cloudflared tunnel create schulhub

# 3) Edit the config: replace the placeholders
nano ~/.cloudflared/config.yml
#    tunnel: <TUNNEL_UUID>
#    credentials-file: /home/habsw/.cloudflared/<TUNNEL_UUID>.json
#    hostname: <HUB_DOMAIN>            -> service http://localhost:3000
#    hostname: "*.<APPS_DOMAIN>"       -> service http://localhost:3000

# 4) Point DNS at the tunnel (creates the public DNS records in Cloudflare):
cloudflared tunnel route dns schulhub <HUB_DOMAIN>
cloudflared tunnel route dns schulhub "*.<APPS_DOMAIN>"

# 5) Test it in the foreground (Ctrl-C to stop):
cloudflared tunnel run schulhub
```

If step 5 works, run it permanently as a user service:

```bash
# Install and enable the cloudflared user service (start at login):
systemctl --user enable --now cloudflared

# Or let cloudflared manage its own service:
# cloudflared service install
```

Then update `.env` to the public HTTPS address and restart the app:

```
BASE_URL=https://<HUB_DOMAIN>
APPS_DOMAIN=<APPS_DOMAIN>
TRUST_PROXY=1
```

```bash
systemctl --user restart schulhub
```

### 4.3 Managing the tunnel

| Task | Command |
|---|---|
| Start / stop / restart | `systemctl --user start|stop|restart cloudflared` |
| Status | `systemctl --user status cloudflared` |
| Live log | `journalctl --user -u cloudflared -f` |
| List tunnels | `cloudflared tunnel list` |
| Delete a tunnel | `cloudflared tunnel delete <name>` |

You can also manage tunnels and DNS in the Cloudflare **Zero Trust →
Networks → Tunnels** dashboard.

---

## 5. Microsoft login

Microsoft sign-in is **already implemented** in SchulHub (OpenID Connect
authorization-code flow with PKCE, handled by `@azure/msal-node` on the server).
The only thing that must match your setup is the Entra **app registration** and
the `.env` values.

### 5.1 App registration in Microsoft Entra

Your app registration lives in a **personal/test tenant** (“Joshua”), not the
school's own tenant. That's fine — SchulHub uses the **`common` endpoint**, so
Microsoft lets **any** account through, and SchulHub's e-mail-domain lists
(Section 5.2) are what actually keep strangers out. You must set the account
type to the broadest value:

1. Go to <https://entra.microsoft.com> → **Identity → Applications →
   App registrations** → open your app (`1137e0a9-…`).
2. Under **Authentication** set:
   - **Supported account types** = **“Accounts in any organizational directory
     and personal Microsoft accounts”** ← required, otherwise `common` fails
     with `AADSTS50194`
   - **Redirect URI** (platform *Web*): `https://<HUB_DOMAIN>/auth/callback`
     (and keep `http://localhost:3000/auth/callback` for local testing).
3. **Certificates & secrets** → make sure a client secret is present; copy its
   **Value** (shown only once) into `CLIENT_SECRET`.
4. **API permissions** → only `Microsoft Graph → User.Read` is needed by
   default; SchulHub itself only requests `openid profile email`.

> **Security model:** Microsoft authenticates the account; SchulHub then checks
> the e-mail domain against `STUDENT_EMAIL_DOMAINS` / `STAFF_EMAIL_DOMAINS` /
> `ADMIN_EMAILS` and refuses anything else. So even though the login itself is
> open to “everyone”, only `@schueler-fes-stuttgart.de` and `@fes-stuttgart.de`
> (plus the admin address) can actually get in.

### 5.2 `.env` values

```bash
nano /home/habsw/schulhub/.env
```

| Variable | Meaning |
|---|---|
| `CLIENT_ID` / `TENANT_ID` / `CLIENT_SECRET` | from the app registration (already filled in) |
| `ALLOW_ANY_ACCOUNT` | `true` = sign in over `common` (required here because the app is in a personal tenant) |
| `STUDENT_EMAIL_DOMAINS` | comma list → role *Schüler/in* (currently `schueler-fes-stuttgart.de`) |
| `STAFF_EMAIL_DOMAINS` | comma list → role *Lehrkraft* (currently `fes-stuttgart.de`) |
| `ADMIN_EMAILS` | exact e-mail(s) that become *Admin* on first sign-in (currently `david.giese@schueler-fes-stuttgart.de`) |
| `BASE_URL` | public HTTPS address of the Hub |
| `APPS_DOMAIN` | second domain for apps (wildcard DNS) |
| `SESSION_SECRET` | long random string (already generated) |
| `TRUST_PROXY` | `1` (one proxy = cloudflared) |

**Role logic:** a first sign-in gets its role from the e-mail domain. Unknown
domains are refused. `ADMIN_EMAILS` always wins.

After changing `.env`, restart:

```bash
systemctl --user restart schulhub
```

### 5.3 Verify the login works locally

With `.env` still pointing at `http://localhost:3000`:

```bash
curl -sI http://localhost:3000/auth/login | grep -i location
# should show: Location: https://login.microsoftonline.com/common/oauth2/...
```

Then open <http://localhost:3000>, click **Mit Microsoft-Schulkonto anmelden**,
and sign in. `common` in the URL confirms that accounts outside the “Joshua”
tenant (i.e. your school accounts) are allowed through to the domain check.

---

## 6. Troubleshooting

### The server will not start
`systemctl --user status schulhub` / `journalctl --user -u schulhub -e` shows a
German message listing exactly what is wrong. Common ones:

- **“SESSION_SECRET fehlt …”** → `.env` is missing or has a placeholder value.
- **“TENANT_ID, CLIENT_ID und CLIENT_SECRET müssen gesetzt sein.”** → fill the
  Microsoft values in `.env`.
- **“STUDENT_EMAIL_DOMAINS und/oder STAFF_EMAIL_DOMAINS …”** → add at least one
  domain list.
- **“BASE_URL muss mit https:// beginnen …”** → for anything other than
  `localhost`, `BASE_URL` must be `https://`. Until Cloudflare is set up, keep
  `BASE_URL=http://localhost:3000`.
- **“Hub und Apps liegen unter derselben Domain …”** → you used one domain for
  both. Use a **second** domain for `APPS_DOMAIN` (see 4.1).
- **“Port 3000 ist schon belegt.”** → something else is on port 3000. Find it
  with `ss -tlnp | grep 3000`.

### Login loops back / “Bitte melde dich an”
- Cookies are disabled, or the site is not HTTPS but `BASE_URL` is https (or the
  reverse). Check that `TRUST_PROXY=1` and the public URL is HTTPS.
- The redirect URI in Entra does not match `<BASE_URL>/auth/callback` exactly.

### Login fails with a Microsoft error
- `AADSTS50194` → “Supported account types” is still *single tenant*. Set it to
  “Accounts in any organizational directory and personal Microsoft accounts”
  (see 5.1) — otherwise `common` cannot authenticate school accounts.
- `AADSTS50011` → the redirect URI in Entra does not match the URL you used.
- `access_denied` → the user cancelled, or admin consent is required.

### “Mit dieser E-Mail-Adresse ist keine Anmeldung möglich”
The account signed in successfully, but its e-mail domain is not in
`STUDENT_EMAIL_DOMAINS`, `STAFF_EMAIL_DOMAINS`, or `ADMIN_EMAILS`. Add the domain.

### “Die Datenbank … fehlt, aber im Datenordner liegen schon Dateien”
The `data/hub.sqlite` file is gone while `data/blobs`/`data/userfiles` still have
content. Restore a backup (`npm run restore -- <file.zip>`) or, to start over
completely, move the whole `data/` folder away.

### App is running but the tunnel gives 404 / bad host
- Cloudflare: make sure the ingress in `~/.cloudflared/config.yml` covers the
  exact hostnames, and the DNS records point at the tunnel.
- SchulHub answers only for `BASE_URL`’s host and `*.<APPS_DOMAIN>`. Any other
  `Host` header is refused with “Unbekannte Adresse.” — that is by design.

### Reset everything
Stop the app, move `data/` away, and start again:

```bash
systemctl --user stop schulhub
mv /home/habsw/schulhub/data /home/habsw/schulhub/data-backup-$(date +%F)
systemctl --user start schulhub
```

---

## 7. Current state / still to do

**Done and live:**
- Hub: `https://habsw.de` · Apps: `https://*.v1d.eu`
- Cloudflare Tunnel `schulhub` (service `cloudflared`) + the app (service `schulhub`) run as systemd user services and auto-start.
- `BASE_URL=https://habsw.de`, `APPS_DOMAIN=v1d.eu`, `TRUST_PROXY=1`.
- `STUDENT_EMAIL_DOMAINS=schueler-fes-stuttgart.de`,
  `STAFF_EMAIL_DOMAINS=fes-stuttgart.de`,
  `ADMIN_EMAILS=david.giese@schueler-fes-stuttgart.de`.
- `ALLOW_ANY_ACCOUNT=true` (the app registration is in a personal tenant, so login runs over `common` and the domain lists do the filtering).
