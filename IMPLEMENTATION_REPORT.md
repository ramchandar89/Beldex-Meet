# Beldex Meet — Zoom feature-parity implementation report

_Date: 2026-11-04 · Scope: web (`src/`, Next.js 15 + LiveKit components) and mobile (`mobile/`, Expo 58 + LiveKit React Native), sharing one Next.js token/host-control server and one LiveKit media server._

## 1. Summary

The app already had working basics (join by code, mic/camera toggles, screen share, public chat, reactions, raise hand, a participant list with mute/remove/lock). Compared with Zoom it was missing the waiting room, real participant permissions, co-host/host transfer, end-meeting-for-all, scheduling, private chat, in-call audio/video settings (speaker selection), meeting info/invite in the call, and several host actions. It also had a security hole (any client could impersonate the host) and a few functional bugs.

All ten requested areas are now implemented on **both** web and mobile. Web was verified end-to-end with real multi-participant browser sessions (35 automated checks, all passing). Mobile was typechecked, linted, and tested in a live web↔iOS Simulator call covering media, public/private chat, host mute/ask-to-unmute, permissions, raise hand, co-host and end-meeting (see §6 for exactly what was and wasn't exercised).

## 2. Gap analysis (before → after)

Legend: ✅ working · ⚠️ partial / buggy · ❌ missing

| # | Zoom capability | Web before | Mobile before | Web now | Mobile now |
|---|---|---|---|---|---|
| 1 | Start an instant meeting | ✅ | ✅ | ✅ | ✅ |
| 1 | Join by code / link | ✅ | ✅ | ✅ | ✅ |
| 1 | Join with mic/camera off (pre-join choice) | ⚠️ device picks ignored | ❌ always on | ✅ devices honoured | ✅ toggles |
| 1 | Same display name joining twice | ❌ kicked the other person | ❌ same | ✅ unique identities | ✅ |
| 1 | "Host ended the meeting" / "You were removed" screen | ❌ silent redirect | ❌ silent | ✅ + Rejoin | ✅ + Rejoin |
| 2 | Mute / unmute self | ✅ | ✅ | ✅ | ✅ (blocked state explained) |
| 3 | Camera on / off, flip camera | ✅ | ✅ | ✅ | ✅ |
| 3 | Self view (see yourself) | ❌ hidden | ❌ hidden | ✅ floating, draggable, hide/mirror | ✅ floating, hide/mirror |
| 4 | Public in-meeting chat | ✅ | ✅ | ✅ | ✅ + timestamps, unread badge |
| 4 | Private (1:1) chat | ❌ | ❌ | ✅ | ✅ |
| 4 | Reactions / raise hand | ⚠️ reaction animation CSS was stripped | ✅ | ✅ | ✅ |
| 5 | Share screen / window / tab | ✅ (browser picker) | ⚠️ Android only | ✅ + "You are sharing" banner & Stop | ✅ Android; iOS in-app only (see §7) |
| 6 | Participant list with mic/camera state | ⚠️ names only | ⚠️ names only | ✅ | ✅ |
| 6 | Invite from inside the meeting | ❌ | ❌ | ✅ copy link / invitation / email / Web Share | ✅ share sheet |
| 6 | Mute one / mute all | ✅ | ✅ | ✅ | ✅ |
| 6 | Ask to unmute / ask to start video | ❌ | ❌ | ✅ | ✅ |
| 6 | Stop a participant's video | ❌ | ❌ | ✅ | ✅ |
| 6 | Rename self / rename others | ❌ | ❌ | ✅ | ✅ |
| 6 | Remove participant | ✅ | ✅ | ✅ | ✅ |
| 6 | Lower all hands | ❌ | ❌ | ✅ | ✅ |
| 7 | Schedule a meeting | ❌ | ❌ | ✅ list, start, invite, .ics, delete | ✅ list, start, invite, delete |
| 7 | End meeting for all | ❌ | ❌ | ✅ | ✅ (Zoom-style End/Leave choice) |
| 7 | Meeting info + duration timer | ❌ | ❌ | ✅ | ✅ |
| 8 | Choose microphone / camera | ✅ control-bar menus | ⚠️ flip only | ✅ + Settings panel | ✅ front/back |
| 8 | Choose speaker / audio output | ❌ | ❌ | ✅ (Chrome/Edge/Firefox) + test tone | ✅ Android route list / iOS route picker |
| 8 | Noise suppression / echo cancellation, mic level | ❌ | ❌ | ✅ | — (OS-managed) |
| 9 | Host role | ⚠️ client-asserted, spoofable | ⚠️ same | ✅ token-authenticated | ✅ |
| 9 | Co-host, make host (transfer) | ❌ | ❌ | ✅ | ✅ |
| 9 | Lock meeting | ✅ | ✅ | ✅ | ✅ |
| 9 | Waiting room (admit / deny / admit all) | ❌ | ❌ | ✅ | ✅ |
| 9 | "Allow participants to…" unmute / video / share / chat / rename | ❌ | ❌ | ✅ server-enforced | ✅ server-enforced |
| 9 | Join / leave / waiting notifications | ❌ | ❌ | ✅ | ✅ |
| 10 | Phone-width web layout | ⚠️ control bar overflowed | n/a | ✅ | n/a |
| 10 | Speaker view vs gallery view | ✅ (focus/pin) | ❌ grid only | ✅ | ✅ toggle |

## 3. Bugs fixed in existing code

1. **Host impersonation (security).** Host-control routes trusted a `requester` field from the request body, so anyone who knew the host's name could mute, remove or lock. Requests are now authenticated with the caller's own LiveKit join token (`Authorization: Bearer …`, verified server-side with `TokenVerifier`). Verified: a forged request returns 401.
2. **Duplicate names kicked people out.** Identity was the display name, so a second "Alex" disconnected the first (LiveKit `DUPLICATE_IDENTITY`). Identities are now `<name-slug>-<random>`; display names are unchanged.
3. **Pre-join device choice ignored (web).** The mic/camera picked on the pre-join screen weren't passed to the room; they now are.
4. **Lock toggle wiped other room state.** It overwrote room metadata; settings now use read-modify-write.
5. **Reaction animation never ran (web).** Tailwind v4's pipeline drops custom rules from `globals.css` (including the existing `veilFloat` keyframes); they're now inlined, following the existing in-code workaround.
6. **Web control bar overflowed at phone widths** (Leave button cut off at 390 px).

## 4. What was implemented, by area

### Server (shared by web + mobile)
- `src/lib/roomAdmin.ts` — room settings model (stored in LiveKit room metadata), host succession rule (explicit host → co-host → earliest joiner, waiting participants excluded), permission mapping to LiveKit `canPublishSources` / `canPublishData`, token-authenticated `hostRoute()` wrapper with host / co-host / member levels.
- `src/app/api/token/route.ts` — unique identities; waiting-room tokens (no publish/subscribe until admitted); per-settings publish grants; scheduled-meeting owner always becomes host and bypasses the waiting room.
- New routes under `src/app/api/room/`: `settings` (waiting room + allow-toggles, applied live to every participant), `admit` (admit / deny / admit all), `role` (make host / co-host / participant), `rename`, `end`, `hands`. `mute` gained `source: "camera"` (stop video). `lock`, `mute`, `remove` now use token auth.
- `src/lib/meetings.ts` + `src/app/api/meetings/route.ts` — scheduled meetings (create / list / delete, `.ics` export). Stored in `.data/meetings.json` (added to `.gitignore`).

### Web
- `src/app/rooms/[roomName]/meeting.ts` — shared hooks: settings, roles, authenticated host API, view preferences.
- `RoomClient.tsx` — waiting-room gate, disconnect-reason screen, device choices applied, Settings slot wired into the control bar.
- `MeetingExtras.tsx` — meeting info chip with timer + invite popover, invite button, private chat panel, ask-to-unmute/video prompts, join/leave/waiting toasts with "Admit", screen-share banner, "host disabled unmuting/chat" states, floating self view, End meeting dialog, rename dialog, phone-width layout.
- `ParticipantsPanel.tsx` — waiting room section, role tags, mic/camera state, per-person actions menu, host bar, Security + "Allow participants to" toggles.
- `SettingsPanel.tsx` — mic / speaker / camera selection, input level meter, speaker test tone, noise suppression & echo cancellation, self-view show/mirror.
- `src/app/page.tsx` — Schedule form and upcoming-meetings list (Start, Copy invitation, Add to calendar, Delete).

### Mobile
- `mobile/meeting.ts` — same settings/roles logic as web, token-authenticated host API.
- `mobile/Scheduling.tsx` — scheduled meetings list + schedule sheet (date/time steppers, so no new native module or rebuild is needed).
- `mobile/App.tsx` — join options (mic/camera), waiting room screen, ended/removed screen with Rejoin, header with lock state + timer + layout toggle, speaker view, floating self view, toasts, screen-share and restricted-audio banners, Chat with "To: Everyone / person" private messages and unread badge, People sheet with waiting room, roles, per-person actions and permission switches, More sheet (Meeting info, Invite, Speaker/Gallery view, Rename me, Settings), Settings sheet (audio output, front/back camera, self view), host End/Leave choice, ask-to-unmute prompts.

## 5. Server API (all POST bodies include `room`; host routes need `Authorization: Bearer <join token>`)

| Route | Who | Body |
|---|---|---|
| `GET /api/token?room&username[&userId]` | anyone | → `{ token, identity, waiting, serverUrl }` |
| `/api/room/mute` | host, co-host | `target?`, `source?: "camera"` (omit target = mute all) |
| `/api/room/remove` | host, co-host | `target` |
| `/api/room/lock` | host, co-host | `locked` |
| `/api/room/settings` | host, co-host | any of `waitingRoom, allowUnmute, allowVideo, allowScreenShare, allowChat, allowRename` |
| `/api/room/admit` | host, co-host | `target` or `all: true`, `deny?` |
| `/api/room/role` | host | `target`, `role: host \| cohost \| participant` |
| `/api/room/rename` | member (self) / host, co-host (anyone) | `name`, `target?` |
| `/api/room/hands` | host, co-host | — |
| `/api/room/end` | host | — |
| `GET/POST/DELETE /api/meetings` | owner | schedule CRUD; `?id&format=ics` for calendar file |

## 6. Testing

### Static checks
- Web: `npx tsc --noEmit` — clean.
- Mobile: `npx tsc --noEmit` and `npx expo lint` — clean (including React Compiler rules).

### Web — automated end-to-end (real LiveKit server, headless Chromium with fake camera/mic, up to 5 simultaneous participants)
**29/29 in-call checks passed:**
host joins with prefilled name · self view renders own camera · info chip shows code + timer · two participants receive each other's live video · remote audio track received · join toast · public chat delivered in real time · self-mute reflected to host · ask-to-unmute prompt → unmute · host server-mute · camera off reflected, ask-to-start-video → on · host stops video · raise hand banner + lower all hands · private message delivered to recipient only (third participant doesn't see it) · host rename visible to all · forged host request rejected (401) · disable screen share hides participant's Share (host keeps it) · disable unmute hides mic + banner · disable chat hides composer · screen share: sharer banner + viewer receives screen video · Settings lists mics/cameras/speakers, test tone, noise suppression toggle · waiting room: newcomer waits, host toast, admit → newcomer publishes video · waiting room deny · lock refuses new tokens (403) · make co-host gives host bar · remove shows "removed" screen · make host transfers End button + toast · new host ends meeting, everyone sees "host ended" · 390 px phone viewport has no horizontal overflow.

**6/6 scheduling checks passed:** schedule from home page · defaults saved · `.ics` export valid · owner joining later still becomes host and skips the waiting room · scheduled waiting-room preference applies to later joiners · delete.

### Mobile — cross-platform call (iOS Simulator iPhone 17 Pro ↔ web host in Chromium, same LiveKit server)
All steps below were exercised live on 2026-11-04 and passed:
- Sign-in → new home screen with Microphone/Camera join switches and Scheduled meetings card.
- Phone joins the web host's meeting by code; web sees "Alice" with mic on; phone receives the web host's live video; web receives the phone's microphone audio track.
- Header shows lock/shield state, room code and running timer; floating self view shows "You" (black — the Simulator has no camera).
- Public chat web → phone, with unread badge on the phone's Chat button and timestamps.
- Private message phone → web host: delivered as "Private message from Alice", absent from public chat.
- Web host server-mutes the phone → phone's button flips to red "Unmute" and self view shows 🔇.
- Web host "Ask to unmute" → phone prompt → Unmute → web shows mic on again.
- Web host disables "Unmute themselves" → phone shows "The host has disabled unmuting" banner; tapping Unmute shows "Unmuting disabled".
- Phone raises hand → web shows ✋ banner and row tag.
- Web host makes the phone a co-host → phone's People sheet shows CO-HOST, Mute all / Lower hands / Lock room and permission switches; phone's "Lower hands" is accepted by the server (`POST /api/room/hands 200`, token-authenticated) and clears the hand on web.
- Web host "End meeting for all" → both web and phone show "The host ended the meeting." with Rejoin / Back to home.

Not exercised on a device: Android (code path is shared; Android-only pieces are the audio-output list and MediaProjection screen share, which predates this work), mobile screen sharing, mobile waiting-room flow, mobile scheduling UI interactions, and real camera video from the phone (Simulator limitation). The host was saturated (load average 150–350) during the run, so typing in the Simulator occasionally dropped characters — an environment artefact, not an app bug.

## 7. Pending / not implemented

- **iOS full-device screen sharing.** iOS requires a Broadcast Upload Extension (a separate native target, app group and entitlements). The LiveKit Expo plugin doesn't generate one, so iOS currently shares the app's own screen only. Android shares the whole device screen. Adding the extension needs a custom config plugin and a native rebuild.
- **Cloud recording, live captions/transcription, breakout rooms, polls, whiteboard, virtual backgrounds** — beyond the requested scope. Recording would need LiveKit Egress; captions need a speech-to-text agent; virtual backgrounds on web can use `@livekit/track-processors`.
- **Persistent chat history** — chat is in-memory for the meeting, as before.
- **Scheduled-meeting storage** is a JSON file on the Next.js server (fine for one instance; use a database for production). Sign-in remains the existing simulated BChat flow, so "owner" is whoever signs in with that ID.
- **Soft-enforced items:** "Allow rename" is enforced by the rename API, but LiveKit lets a participant call `setName` directly (raise-hand needs the same metadata permission). Chat/reaction blocking is enforced by LiveKit (`canPublishData`).
- **Web gallery grid** still reserves a slot for your own (hidden) tile — existing behaviour from `VideoConference`; you now see yourself in the floating self view.
