# Running Beldex Meet (local dev)

The system has four pieces:

1. **LiveKit media server** — handles the audio/video (port `7880`)
2. **Next.js token server** — mints LiveKit join tokens at `/api/token` (port `3003`)
3. **Web app** — the browser client (served by the Next.js app)
4. **Mobile app** — Expo / React Native dev client (`mobile/`)

---

## 0. Prerequisites (one-time)

- **Node.js** 18+ and **npm**
- **Java 17** + **Android SDK**, with `ANDROID_HOME` set (for the mobile dev build)
- **LiveKit server** — the `livekit-server` binary on your PATH, or run it via the included `docker-compose.yml`
- An **Android device** (USB or Wireless debugging) or an emulator

> Your Mac's LAN IP is referred to below as `192.168.1.5` — replace it with your own
> (`ipconfig getifaddr en0`) if it differs.

---

## 1. Environment file (one-time)

From the repo root:

```bash
cp .env.example .env.local
```

`.env.local` (gitignored) holds the LiveKit credentials. The defaults match the local
LiveKit dev server:

```
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7880
```

---

## 2. Start the LiveKit media server (terminal 1)

```bash
npm run livekit
```

This runs `livekit-server --dev --bind 0.0.0.0` on port `7880`.

For reliable **cross-device** media (phone <-> browser), advertise your LAN IP for ICE:

```bash
livekit-server --dev --bind 0.0.0.0 --node-ip 192.168.1.5
```

---

## 3. Start the token server (terminal 2)

From the repo root, run Next.js on port `3003`, reachable on the LAN:

```bash
npx next dev -p 3003 -H 0.0.0.0
```

---

## 4. Web app

```bash
open http://localhost:3003
```

---

## 5. Mobile app (`mobile/`)

The app fetches its token from the Mac over the LAN. Point it at your LAN IP — either it is
already set in `mobile/config.ts` (`192.168.1.5`), or override it per-machine:

```bash
export EXPO_PUBLIC_DEV_HOST=192.168.1.5
```

**First time, or after any native / plugin / dependency change** — build & install the dev
client (from `mobile/`):

```bash
npx expo run:android
```

**Subsequent runs** (JS-only changes) — just start Metro and open the installed app:

```bash
npx expo start --dev-client
```

> The app uses LiveKit WebRTC native modules, so it needs a **dev build** — it will not run
> in Expo Go.

---

## 6. Make a call

1. Web: **New meeting** -> copy the meeting code (e.g. `warm-fox-3182`).
2. Phone: enter that code -> **Join meeting**. (Or start on the phone and join the code on web.)
3. In-call controls: **Mic**, **Camera**, **Share** (accept the Android casting prompt),
   **Chat**, **Leave**.

Both clients talk to the same token server and the same LiveKit server, so joining the same
code puts web and mobile in the same call.

---

## 7. Access the web app from other machines (LAN)

Browsers only allow camera/microphone on `https://` pages (or `localhost`), so opening
`http://<your-ip>:3003` from another computer can't use media. Use the HTTPS proxy instead.

**One-time:** create a self-signed certificate for your LAN IP (stored in `certs/`, gitignored):

```bash
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/lan-key.pem -out certs/lan-cert.pem -subj "/CN=Beldex Meet dev" -addext "subjectAltName=IP:$(ipconfig getifaddr en0),IP:127.0.0.1,DNS:localhost" -addext "extendedKeyUsage=serverAuth"
```

Re-run it if your Mac's IP changes.

**Each time**, in three terminals (instead of steps 2 and 3):

```bash
npm run livekit:lan
```

```bash
npx next dev -p 3003 -H 0.0.0.0
```

```bash
npm run lan
```

Then on the other machine open **`https://<your-ip>:3443`** and accept the certificate
warning once ("Advanced → Proceed"). The proxy serves the web app and forwards `/rtc` to
LiveKit on the same origin, so no other URL or certificate is needed. `livekit:lan`
advertises your LAN IP so audio/video (UDP 7882) reach the other machine directly.

- Your firewall must allow incoming TCP 3443 and UDP 7882 (and TCP 7881 as a fallback).
- The mobile app is unaffected: it keeps using `http://<your-ip>:3003` (native apps don't
  have the browser's https rule).
- `next.config.ts` allows this machine's LAN IPs as dev origins automatically.
- Opening a page at `http://<your-ip>:3003` from another machine redirects to the HTTPS
  address (`src/middleware.ts`; API routes are not redirected). If the proxy isn't running,
  the meeting page shows a warning with the secure link instead.

---

## Notes & gotchas

- **`10.0.2.2` is emulator-only.** A physical device must use the Mac's **LAN IP** — that is
  what `mobile/config.ts` / `EXPO_PUBLIC_DEV_HOST` controls.
- **Keep the phone unlocked / Stay awake** during builds — wireless adb drops when it sleeps.
- **Reconnect wireless adb:** `adb mdns services`, then `adb connect <ip:port>` using the
  address shown on the phone's Wireless-debugging screen.
- **Screen share** on Android uses a MediaProjection foreground service, configured via the
  `@livekit/react-native-expo-plugin` (`enableScreenShareService`) plus the
  `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PROJECTION` permissions in `app.json`.
  Changing that config requires a rebuild (`npx expo run:android`).
- **Secrets** live only in `.env.local` (gitignored). The LiveKit dev defaults are
  `devkey` / `secret`.
