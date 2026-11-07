import { Platform } from 'react-native';

/**
 * Where the app fetches a LiveKit access token + server URL from.
 * This is your Next.js `/api/token` endpoint (it returns `{ token, serverUrl }`).
 *
 * Host mapping while developing against the LOCAL Next.js server (port 3003):
 *   - Android emulator -> the host Mac is reachable at 10.0.2.2 (NOT localhost)
 *   - iOS simulator    -> localhost works
 *   - Physical device  -> use your Mac's LAN IP (e.g. http://192.168.x.x:3003/api/token)
 *
 * For production, point this at your deployed app:
 *   https://your-app.vercel.app/api/token
 *
 * IMPORTANT: the LiveKit server the token is minted for (returned as `serverUrl`)
 * must be reachable from the phone. A local LiveKit server is hard to reach from a
 * device/emulator — use LiveKit Cloud (wss://<project>.livekit.cloud) for real calls.
 */
/**
 * Host of the local Next.js dev server, as reachable from the mobile client.
 *   - Physical device (over Wi-Fi/adb) -> the Mac's LAN IP
 *   - Android emulator can also reach the Mac via its LAN IP
 *   - iOS simulator shares the host's localhost
 * Override at runtime with EXPO_PUBLIC_DEV_HOST so this isn't pinned to one machine.
 */
const DEV_HOST =
  process.env.EXPO_PUBLIC_DEV_HOST ??
  (Platform.OS === 'android' ? '192.168.1.5' : 'localhost');

export const API_BASE = `http://${DEV_HOST}:3003`;
export const TOKEN_ENDPOINT = `${API_BASE}/api/token`;

/**
 * On the Android emulator, `localhost` / `127.0.0.1` point at the emulator itself,
 * not the host Mac. The LiveKit `serverUrl` the token endpoint returns
 * (e.g. ws://localhost:7880) must be rewritten to the emulator's host alias
 * 10.0.2.2 so the media WebSocket actually reaches the LiveKit server on the Mac.
 * The iOS simulator shares the host's localhost, so it is left untouched.
 */
export function resolveServerUrl(serverUrl: string): string {
  if (Platform.OS === 'android') {
    return serverUrl.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, `//${DEV_HOST}`);
  }
  return serverUrl;
}
