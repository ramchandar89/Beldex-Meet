import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  isTrackReference,
  useChat,
  useConnectionState,
  useDataChannel,
  useIsSpeaking,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/react-native';
import {
  ConnectionState,
  DisconnectReason,
  LocalVideoTrack,
  RoomEvent,
  Track,
  type Participant,
} from 'livekit-client';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';

import { API_BASE, TOKEN_ENDPOINT, resolveServerUrl } from './config';
import { resolveAccount, type BeldexUser } from './auth';
import {
  CONTROL_TOPIC,
  DM_TOPIC,
  callHostAction,
  displayName,
  formatDuration,
  isWaiting,
  joinUrl,
  useRoles,
  type Roles,
} from './meeting';
import { ScheduledMeetings } from './Scheduling';

// Short numeric room code like "482-913".
// Codes starting with 9 are (simulated) paid rooms that charge an entry fee.
function randomRoomCode(paid: boolean) {
  const first = paid ? 9 : 1 + Math.floor(Math.random() * 8);
  const digits = `${first}${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

const isPaidRoom = (code: string) => code.startsWith('9');

type Session = {
  token: string;
  serverUrl: string;
  room: string;
  name: string;
  // Placed in the host's waiting room until admitted.
  waiting: boolean;
  // Join with mic / camera on (Zoom's "Don't connect audio" / "Turn off my video").
  audio: boolean;
  video: boolean;
};

type JoinOptions = { audio: boolean; video: boolean };

// Fetch a LiveKit token for a room and build a Session. Throws with a readable message.
async function fetchSession(
  roomName: string,
  name: string,
  userId: string | undefined,
  opts: JoinOptions = { audio: true, video: true },
): Promise<Session> {
  const displayName = name.trim() || 'Guest';
  const cleanRoom = roomName.trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (!cleanRoom) throw new Error('Enter a meeting code, or tap New meeting.');
  let url = `${TOKEN_ENDPOINT}?room=${encodeURIComponent(cleanRoom)}&username=${encodeURIComponent(displayName)}`;
  if (userId) url += `&userId=${encodeURIComponent(userId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Token request failed (${res.status})`);
  }
  const data = (await res.json()) as { token?: string; serverUrl?: string; waiting?: boolean };
  if (!data.token) throw new Error('No token returned by the server.');
  if (!data.serverUrl) {
    throw new Error('Server has no LiveKit URL configured (NEXT_PUBLIC_LIVEKIT_URL).');
  }
  return {
    token: data.token,
    serverUrl: resolveServerUrl(data.serverUrl),
    room: cleanRoom,
    name: displayName,
    waiting: data.waiting === true,
    ...opts,
  };
}

/* ------------------------- in-call shared helpers ------------------------- */

const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '😮', '🙏'];
const HAND = '✋';
const REACTION_TOPIC = 'veil-reactions';

export default function App() {
  // Simulated Beldex sign-in gates the app (in-memory for the prototype).
  const [user, setUser] = useState<BeldexUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  // A freshly created meeting waiting in the lobby (share the code, set a name, then join).
  const [lobby, setLobby] = useState<{ room: string; name: string } | null>(null);
  // Why the last call ended, when it wasn't our own choice (host ended it, removed, …).
  const [ended, setEnded] = useState<{ message: string; room: string; name: string } | null>(null);

  const signOut = () => {
    setSession(null);
    setLobby(null);
    setEnded(null);
    setUser(null);
  };

  return (
    <SafeAreaProvider>
      {!user ? (
        <LoginScreen onSignIn={setUser} />
      ) : ended ? (
        <EndedScreen
          message={ended.message}
          onRejoin={() => {
            setLobby({ room: ended.room, name: ended.name });
            setEnded(null);
          }}
          onHome={() => setEnded(null)}
        />
      ) : session ? (
        <RoomScreen
          session={session}
          onLeave={() => {
            setSession(null);
            setLobby(null);
          }}
          onEnded={(message) => setEnded({ message, room: session.room, name: session.name })}
        />
      ) : lobby ? (
        <LobbyScreen
          room={lobby.room}
          initialName={lobby.name}
          userId={user.id}
          onJoin={setSession}
          onBack={() => setLobby(null)}
        />
      ) : (
        <HomeScreen
          user={user}
          onSignOut={signOut}
          onJoin={setSession}
          onCreate={(room, name) => setLobby({ room, name })}
        />
      )}
    </SafeAreaProvider>
  );
}

/* ---------------------------------- Login --------------------------------- */

function LoginScreen({ onSignIn }: { onSignIn: (u: BeldexUser) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);

  const signIn = useCallback(() => {
    const user = resolveAccount(value);
    if (!user) {
      setError('Enter a valid BChat ID (05…) or a name.bdx handle. Try demo.bdx.');
      return;
    }
    setError('');
    setSigning(true);
    // Simulate the wallet signature round-trip.
    setTimeout(() => onSignIn(user), 600);
  }, [value, onSignIn]);

  return (
    <SafeAreaView style={styles.loginRoot}>
      <StatusBar style="light" />
      <View style={styles.loginInner}>
        <Text style={styles.loginTitle}>Meet without handing over your identity.</Text>
        <Text style={styles.loginSubtitle}>Sign in with your BChat ID. No email, no phone number.</Text>

        <TextInput
          style={styles.loginInput}
          value={value}
          onChangeText={(t) => {
            setValue(t);
            setError('');
          }}
          placeholder="BChat ID or name.bdx"
          placeholderTextColor="#7b8198"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!error && <Text style={styles.loginError}>{error}</Text>}

        <Pressable
          style={({ pressed }) => [styles.loginBtn, pressed && styles.pressed, signing && { opacity: 0.7 }]}
          disabled={signing}
          onPress={signIn}
        >
          <Text style={styles.loginBtnText}>{signing ? 'Signing…' : 'Sign with Beldex wallet'}</Text>
        </Pressable>

        <Text style={styles.loginNote}>Prototype: the wallet signature is simulated.</Text>
      </View>
    </SafeAreaView>
  );
}

/* ---------------------------------- Home ---------------------------------- */

function HomeScreen({
  user,
  onSignOut,
  onJoin,
  onCreate,
}: {
  user: BeldexUser;
  onSignOut: () => void;
  onJoin: (s: Session) => void;
  onCreate: (room: string, name: string) => void;
}) {
  const name = user.name;
  const [room, setRoom] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opts, setOpts] = useState<JoinOptions>({ audio: true, video: true });
  const [chargeFee, setChargeFee] = useState(false);
  const [feeAmount, setFeeAmount] = useState('');
  const [feeError, setFeeError] = useState('');

  const [creating, setCreating] = useState(false);

  const create = async () => {
    const code = randomRoomCode(chargeFee);
    if (chargeFee) {
      const fee = Number(feeAmount.replace(',', '.'));
      if (!feeAmount.trim() || !Number.isFinite(fee) || fee <= 0) {
        setFeeError('Enter an entry fee greater than 0.');
        return;
      }
      // Save the fee so people joining this code can see the amount.
      setCreating(true);
      try {
        const res = await fetch(`${API_BASE}/api/room/fee`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: code, fee, ownerId: user.id }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setFeeError(body.error ?? 'Could not save the entry fee. Try again.');
          return;
        }
      } catch {
        setFeeError(`Could not reach the server at ${API_BASE}.`);
        return;
      } finally {
        setCreating(false);
      }
    }
    onCreate(code, name);
  };
  // Paid room awaiting the (simulated) entry-fee confirmation, with the
  // amount the host set (null when unknown).
  const [pendingPaid, setPendingPaid] = useState<string | null>(null);
  const [pendingFee, setPendingFee] = useState<number | null>(null);

  // Join an existing meeting by code. Paid rooms (codes starting with 9)
  // first ask the user to confirm the simulated entry fee.
  const join = useCallback(async (paidConfirmed = false) => {
    const cleanRoom = room.trim().replace(/[^a-zA-Z0-9-_]/g, '');
    if (!cleanRoom) {
      setError('Enter a meeting code, or tap Create room.');
      return;
    }
    if (isPaidRoom(cleanRoom) && !paidConfirmed) {
      setError('');
      setLoading(true);
      let fee: number | null = null;
      try {
        const res = await fetch(`${API_BASE}/api/room/fee?room=${encodeURIComponent(cleanRoom)}`);
        if (res.ok) fee = (await res.json()).fee ?? null;
      } catch {
        /* show the generic paid-room notice */
      }
      setLoading(false);
      setPendingFee(fee);
      setPendingPaid(cleanRoom);
      return;
    }
    setPendingPaid(null);
    setError('');
    setLoading(true);
    try {
      onJoin(await fetchSession(cleanRoom, name, user.id, opts));
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}\n\nIs the token server reachable at:\n${TOKEN_ENDPOINT}?`
          : 'Could not connect.',
      );
    } finally {
      setLoading(false);
    }
  }, [name, room, onJoin, user.id, opts]);

  return (
    <SafeAreaView style={[styles.homeRoot, nv.root]}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.homeScroll} keyboardShouldPersistTaps="handled">
        {/* Signed-in user */}
        <View style={[styles.userPill, nv.pill]}>
          <View style={[styles.userAvatar, nv.accentBg]}>
            <Text style={[styles.userAvatarText, nv.onAccent]}>{user.name.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={[styles.userPillName, nv.text]} numberOfLines={1}>
            {user.name}
          </Text>
          <Pressable onPress={onSignOut} hitSlop={8}>
            <Text style={[styles.signOutText, nv.muted]}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={[styles.homeHeading, nv.text]}>Start or join a meeting</Text>

        {/* New meeting */}
        <View style={[styles.card, nv.card]}>
          <Text style={[styles.cardTitle, nv.text]}>New meeting</Text>
          <Pressable
            style={styles.checkRow}
            onPress={() => {
              setChargeFee((v) => !v);
              setFeeError('');
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: chargeFee }}
          >
            <Text style={[styles.checkLabel, nv.text]}>Charge entry fee</Text>
            <View style={[styles.checkbox, nv.checkbox, chargeFee && nv.checkboxOn]}>
              {chargeFee && <MaterialIcons name="check" size={18} color={NAVY.onAccent} />}
            </View>
          </Pressable>
          {chargeFee && (
            <View style={{ marginBottom: 14 }}>
              <Text style={[styles.label, nv.muted]}>Entry fee amount</Text>
              <View style={[styles.feeField, nv.input]}>
                <TextInput
                  style={[styles.feeInput, nv.text]}
                  value={feeAmount}
                  onChangeText={(t) => {
                    setFeeAmount(t.replace(/[^0-9.,]/g, ''));
                    setFeeError('');
                  }}
                  placeholder="e.g. 10"
                  placeholderTextColor={NAVY.placeholder}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                <Text style={[styles.feeUnit, nv.muted]}>BDX</Text>
              </View>
              {!!feeError && <Text style={[styles.error, { marginTop: 6 }]}>{feeError}</Text>}
            </View>
          )}
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, nv.accentBg, pressed && styles.pressed]}
            disabled={loading || creating}
            onPress={create}
          >
            <Text style={[styles.primaryBtnText, nv.onAccent]}>{creating ? 'Creating…' : 'Create room'}</Text>
          </Pressable>
        </View>

        {/* Join with a code */}
        <View style={[styles.card, nv.card, { marginTop: 16 }]}>
          <Text style={[styles.cardTitle, nv.text, { marginBottom: 14 }]}>Join with a code</Text>
          <TextInput
            style={[styles.input, nv.input]}
            value={room}
            onChangeText={(t) => {
              setRoom(t);
              setError('');
              setPendingPaid(null);
            }}
            placeholder="e.g. 482-913"
            placeholderTextColor={NAVY.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            returnKeyType="go"
            onSubmitEditing={() => join()}
          />
          <JoinOptionsRow value={opts} onChange={setOpts} textColor={NAVY.text} />
          {pendingPaid ? (
            <View style={[styles.paidBox, nv.paidBox]}>
              <Text style={[styles.paidText, nv.text]}>
                Room <Text style={{ fontWeight: '700' }}>{pendingPaid}</Text> charges an entry fee
                {pendingFee !== null && (
                  <>
                    {' '}of <Text style={{ fontWeight: '700' }}>{pendingFee} BDX</Text>
                  </>
                )}{' '}
                (simulated).
              </Text>
              <View style={styles.paidActions}>
                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, nv.accentBg, { flex: 1 }, pressed && styles.pressed]}
                  disabled={loading}
                  onPress={() => join(true)}
                >
                  <Text style={[styles.primaryBtnText, nv.onAccent]}>
                    {pendingFee !== null ? `Pay ${pendingFee} BDX & join` : 'Pay & join'}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.secondaryBtn, nv.secondaryBtn, { paddingHorizontal: 18 }, pressed && styles.pressed]}
                  disabled={loading}
                  onPress={() => setPendingPaid(null)}
                >
                  <Text style={[styles.secondaryBtnText, nv.text]}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, nv.secondaryBtn, pressed && styles.pressed]}
              disabled={loading}
              onPress={() => join()}
            >
              <Text style={[styles.secondaryBtnText, nv.text]}>Join room</Text>
            </Pressable>
          )}

          {loading && <ActivityIndicator style={{ marginTop: 16 }} color={NAVY.accent} />}
          {!!error && <Text style={styles.error}>{error}</Text>}
        </View>

        <Text style={[styles.paidHint, nv.muted]}>Joining a code that starts with 9 simulates a paid room.</Text>

        <ScheduledMeetings user={user} onStart={(code) => onCreate(code, name)} />

        <Text style={[styles.footer, { color: NAVY.placeholder }]}>Phase 1 · LiveKit · Beldex identity & payments next</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/* --------------------------------- Lobby ---------------------------------- */

// After "New meeting": show the code to share, set a name, then join.
function LobbyScreen({
  room,
  initialName,
  userId,
  onJoin,
  onBack,
}: {
  room: string;
  initialName: string;
  userId: string;
  onJoin: (s: Session) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opts, setOpts] = useState<JoinOptions>({ audio: true, video: true });

  const join = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      onJoin(await fetchSession(room, name, userId, opts));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setLoading(false);
    }
  }, [room, name, userId, opts, onJoin]);

  const shareCode = useCallback(() => {
    Share.share({
      message: `Join my Beldex Meet — meeting code: ${room}\n${joinUrl(room)}`,
    }).catch(() => {});
  }, [room]);

  return (
    <SafeAreaView style={styles.homeRoot}>
      <StatusBar style="dark" />
      <View style={styles.homeInner}>
        <Text style={styles.title}>Meeting ready</Text>
        <Text style={styles.subtitle}>Share this code so another person can join</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Meeting code</Text>
          <View style={styles.codeBox}>
            <Text selectable style={styles.codeText}>
              {room}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            onPress={shareCode}
          >
            <Text style={styles.secondaryBtnText}>Share code</Text>
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.dividerText}>YOUR NAME</Text>
            <View style={styles.line} />
          </View>

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Alex"
            placeholderTextColor="#9ca3af"
            autoCapitalize="words"
          />
          <JoinOptionsRow value={opts} onChange={setOpts} />
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            disabled={loading}
            onPress={join}
          >
            <Text style={styles.primaryBtnText}>Join meeting</Text>
          </Pressable>
          <Pressable style={styles.backBtn} onPress={onBack}>
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>

          {loading && <ActivityIndicator style={{ marginTop: 16 }} color="#4f46e5" />}
          {!!error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>
    </SafeAreaView>
  );
}

// "Join with microphone / camera" toggles shown before joining.
function JoinOptionsRow({
  value,
  onChange,
  textColor,
}: {
  value: JoinOptions;
  onChange: (v: JoinOptions) => void;
  textColor?: string;
}) {
  const label = [styles.joinOptText, textColor ? { color: textColor } : null];
  return (
    <View style={styles.joinOpts}>
      <View style={styles.joinOpt}>
        <Text style={label}>Microphone on</Text>
        <Switch value={value.audio} onValueChange={(audio) => onChange({ ...value, audio })} />
      </View>
      <View style={styles.joinOpt}>
        <Text style={label}>Camera on</Text>
        <Switch value={value.video} onValueChange={(video) => onChange({ ...value, video })} />
      </View>
    </View>
  );
}

function EndedScreen({
  message,
  onRejoin,
  onHome,
}: {
  message: string;
  onRejoin: () => void;
  onHome: () => void;
}) {
  return (
    <SafeAreaView style={styles.homeRoot}>
      <StatusBar style="dark" />
      <View style={styles.homeInner}>
        <Text style={styles.title}>Meeting ended</Text>
        <Text style={styles.subtitle}>{message}</Text>
        <View style={styles.card}>
          <Pressable style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]} onPress={onHome}>
            <Text style={styles.primaryBtnText}>Back to home</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, { marginTop: 12 }, pressed && styles.pressed]}
            onPress={onRejoin}
          >
            <Text style={styles.secondaryBtnText}>Rejoin</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

// Why the call ended, when it wasn't our own choice.
function endedMessage(reason?: DisconnectReason): string | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      return null;
    case DisconnectReason.ROOM_DELETED:
      return 'The host ended the meeting.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the meeting by the host.';
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this meeting from another device.';
    default:
      return 'You were disconnected from the meeting.';
  }
}

/* ---------------------------------- Room ---------------------------------- */

function RoomScreen({
  session,
  onLeave,
  onEnded,
}: {
  session: Session;
  onLeave: () => void;
  onEnded: (message: string) => void;
}) {
  const [ready, setReady] = useState(false);
  const [permError, setPermError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.CAMERA,
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          ]);
          const ok =
            granted[PermissionsAndroid.PERMISSIONS.CAMERA] === 'granted' &&
            granted[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted';
          if (!ok && active) {
            setPermError('Camera and microphone permission are required to join.');
            return;
          }
        }
        await AudioSession.startAudioSession();
        if (active) setReady(true);
      } catch (e) {
        if (active) setPermError(e instanceof Error ? e.message : 'Audio setup failed.');
      }
    })();
    return () => {
      active = false;
      AudioSession.stopAudioSession();
    };
  }, []);

  if (permError) {
    return (
      <SafeAreaView style={styles.roomRoot}>
        <View style={styles.centerFill}>
          <Text style={styles.roomMsg}>{permError}</Text>
          <Pressable style={styles.leaveBtn} onPress={onLeave}>
            <Text style={styles.leaveBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!ready) {
    return (
      <SafeAreaView style={styles.roomRoot}>
        <View style={styles.centerFill}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.roomMsg}>Connecting…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={session.serverUrl}
      token={session.token}
      connect
      // People in the waiting room can't publish; media starts once admitted.
      audio={!session.waiting && session.audio}
      video={!session.waiting && session.video}
      options={{ adaptiveStream: { pixelDensity: 'screen' } }}
      onDisconnected={onLeave}
    >
      <MeetingGate session={session} onLeave={onLeave} onEnded={onEnded} />
    </LiveKitRoom>
  );
}

// Shows the waiting room until the host admits us, then the meeting. Also
// reports why the call ended (host ended it, removed, …).
function MeetingGate({
  session,
  onLeave,
  onEnded,
}: {
  session: Session;
  onLeave: () => void;
  onEnded: (message: string) => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const connection = useConnectionState();
  const { admitted } = useRoles();
  // Until connected, trust the token response; afterwards the participant
  // attribute (cleared by the host on admit) is the source of truth.
  const waiting =
    connection === ConnectionState.Connected ? isWaiting(localParticipant) : session.waiting;
  const canPublish = localParticipant.permissions?.canPublish ?? false;
  const wasWaiting = useRef(session.waiting);

  useEffect(() => {
    const onDisconnected = (reason?: DisconnectReason) => {
      const message = endedMessage(reason);
      if (message) onEnded(message);
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, onEnded]);

  // Admitted from the waiting room: turn on the mic/camera chosen before
  // joining once the publish permission has arrived.
  useEffect(() => {
    if (waiting) {
      wasWaiting.current = true;
      return;
    }
    if (!wasWaiting.current || !canPublish) return;
    wasWaiting.current = false;
    if (session.audio) localParticipant.setMicrophoneEnabled(true).catch(() => {});
    if (session.video) localParticipant.setCameraEnabled(true).catch(() => {});
  }, [waiting, canPublish, session.audio, session.video, localParticipant]);

  if (waiting) {
    return (
      <SafeAreaView style={styles.roomRoot}>
        <StatusBar style="light" />
        <View style={styles.centerFill}>
          <Text style={{ fontSize: 48 }}>⏳</Text>
          <Text style={styles.waitTitle}>
            {admitted.length === 0 ? 'Waiting for the host to start this meeting' : 'Please wait'}
          </Text>
          <Text style={styles.roomMsg}>
            {admitted.length === 0
              ? "You'll be let in once the host joins and admits you."
              : 'The meeting host will let you in soon.'}
          </Text>
          <Text style={styles.waitMeta}>
            {session.room} · joining as {session.name}
          </Text>
          <Pressable
            style={styles.leaveBtn}
            onPress={() => {
              room.disconnect();
              onLeave();
            }}
          >
            <Text style={styles.leaveBtnText}>Leave</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
  return <RoomView session={session} onLeave={onLeave} />;
}

type FloatingReaction = { id: number; emoji: string; left: number };
type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
type DirectMessage = { id: number; from: string; to: string; text: string; ts: number };
export type ChatItem = {
  key: string;
  fromName: string;
  mine: boolean;
  text: string;
  ts: number;
  // Set for private messages: who the other side is.
  privateWith?: string;
};

// LiveKit TrackSource numbers (protocol enum) used in publish permissions.
const SOURCE_CAMERA = 1;
const SOURCE_MIC = 2;
const SOURCE_SCREEN = 3;

function canPublishSource(p: Participant, source: number): boolean {
  const perm = p.permissions;
  if (!perm) return true;
  const sources = perm.canPublishSources as unknown as number[];
  return perm.canPublish && (sources.length === 0 || sources.includes(source));
}

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

function RoomView({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const roomName = session.room;
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled, cameraTrack } =
    useLocalParticipant();
  const roles = useRoles();
  const { settings, admitted, waiting, raisedHands, privileged, isHost } = roles;
  const me = localParticipant.identity;
  const iRaisedHand = raisedHands.has(me);
  const chatBlocked = !privileged && !settings.allowChat;

  const [chatOpen, setChatOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Participant | null>(null);
  const [chatTo, setChatTo] = useState<string>(''); // '' = everyone
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [layout, setLayout] = useState<'gallery' | 'speaker'>('gallery');
  const [selfView, setSelfView] = useState({ show: true, mirror: true });
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const nextId = useRef(1);

  const api = useCallback(
    (path: string, body: Record<string, unknown> = {}) => callHostAction(session.token, roomName, path, body),
    [session.token, roomName],
  );
  const byIdentity = useCallback(
    (id: string) => admitted.find((p) => p.identity === id) ?? room.getParticipantByIdentity(id),
    [admitted, room],
  );
  const nameOf = useCallback((id: string) => displayName(byIdentity(id)), [byIdentity]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 3500);
  }, []);

  const allTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // Show only other participants — hide the local user's own camera and
  // screen-share tiles (they see themselves in the floating self view), and
  // anyone still in the waiting room.
  const tracks = allTracks.filter(
    (t) => !t.participant?.isLocal && !(t.participant && isWaiting(t.participant)),
  );

  // Speaker view: a screen share if there is one, else whoever is talking
  // (remembering the last speaker through silences).
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  useEffect(() => {
    const onSpeakers = (speakers: Participant[]) => {
      const remote = speakers.find((p) => !p.isLocal);
      if (remote) setLastSpeaker(remote.identity);
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room]);
  const mainTrack =
    tracks.find((t) => isTrackReference(t) && t.source === Track.Source.ScreenShare) ??
    tracks.find((t) => t.participant?.identity === lastSpeaker && t.source === Track.Source.Camera) ??
    tracks[0];
  const thumbs = tracks.filter((t) => t !== mainTrack);

  /* ------------------------------- reactions ------------------------------ */

  const spawn = useCallback((emoji: string) => {
    const id = nextId.current++;
    const left = 8 + Math.random() * 78;
    setFloating((f) => [...f, { id, emoji, left }]);
    setTimeout(() => setFloating((f) => f.filter((r) => r.id !== id)), 3200);
  }, []);

  const { send } = useDataChannel(REACTION_TOPIC, (msg) => {
    try {
      const data = decode(msg.payload) as { emoji?: string };
      if (data.emoji) spawn(data.emoji);
    } catch {
      /* ignore */
    }
  });

  const sendReaction = useCallback(
    async (emoji: string) => {
      spawn(emoji);
      setReactOpen(false);
      try {
        await send(encode({ emoji }), { reliable: true, topic: REACTION_TOPIC });
      } catch {
        /* best effort */
      }
    },
    [send, spawn],
  );

  /* --------------------------------- chat --------------------------------- */

  // Public chat lives here (not in the modal) so unread counts work while it's closed.
  const { chatMessages, send: sendChat } = useChat();
  const chatOpenRef = useRef(chatOpen);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  const openChat = useCallback((to?: string) => {
    if (to !== undefined) setChatTo(to);
    setUnread(0);
    setChatOpen(true);
  }, []);
  const seenPublic = useRef(0);
  useEffect(() => {
    const fresh = chatMessages.slice(seenPublic.current).filter((m) => m.from?.identity !== me);
    seenPublic.current = chatMessages.length;
    if (fresh.length && !chatOpenRef.current) setUnread((n) => n + fresh.length);
  }, [chatMessages, me]);

  const { send: sendDmData } = useDataChannel(DM_TOPIC, (msg) => {
    const from = msg.from?.identity;
    if (!from) return;
    try {
      const data = decode(msg.payload) as { text?: string };
      if (!data.text) return;
      setDms((d) => [...d, { id: nextId.current++, from, to: me, text: data.text!, ts: Date.now() }]);
      if (!chatOpenRef.current) {
        setUnread((n) => n + 1);
        toast(`Private message from ${nameOf(from)}`, { label: 'Reply', run: () => openChat(from) });
      }
    } catch {
      /* ignore malformed */
    }
  });

  const sendMessage = useCallback(
    async (text: string) => {
      if (!chatTo) {
        await sendChat(text);
        return;
      }
      await sendDmData(encode({ text }), { reliable: true, topic: DM_TOPIC, destinationIdentities: [chatTo] });
      setDms((d) => [...d, { id: nextId.current++, from: me, to: chatTo, text, ts: Date.now() }]);
    },
    [chatTo, sendChat, sendDmData, me],
  );

  const chatItems = useMemo<ChatItem[]>(() => {
    const pub: ChatItem[] = chatMessages.map((m) => ({
      key: `p-${m.id ?? m.timestamp}-${m.from?.identity ?? ''}`,
      fromName: m.from?.isLocal ? 'You' : displayName(m.from),
      mine: !!m.from?.isLocal,
      text: m.message,
      ts: m.timestamp,
    }));
    const priv: ChatItem[] = dms.map((m) => ({
      key: `d-${m.id}`,
      fromName: m.from === me ? 'You' : nameOf(m.from),
      mine: m.from === me,
      text: m.text,
      ts: m.ts,
      privateWith: nameOf(m.from === me ? m.to : m.from),
    }));
    return [...pub, ...priv].sort((a, b) => a.ts - b.ts);
  }, [chatMessages, dms, me, nameOf]);

  /* ---------------------- host requests (ask to unmute) -------------------- */

  const rolesRef = useRef(roles);
  useEffect(() => {
    rolesRef.current = roles;
  }, [roles]);

  const { send: sendControl } = useDataChannel(CONTROL_TOPIC, (msg) => {
    const from = msg.from?.identity;
    // Only honour requests from the current host / co-hosts.
    if (!from || rolesRef.current.roleOf(from) === null) return;
    try {
      const data = decode(msg.payload) as { type?: string };
      const video = data.type === 'ask-video';
      if (data.type !== 'ask-unmute' && !video) return;
      Alert.alert(
        `${nameOf(from)} is asking you to ${video ? 'start your video' : 'unmute'}`,
        undefined,
        [
          { text: video ? 'Later' : 'Stay muted', style: 'cancel' },
          {
            text: video ? 'Start video' : 'Unmute',
            onPress: () =>
              (video
                ? localParticipant.setCameraEnabled(true)
                : localParticipant.setMicrophoneEnabled(true)
              ).catch(() => {}),
          },
        ],
      );
    } catch {
      /* ignore malformed */
    }
  });

  const askTo = useCallback(
    async (identity: string, what: 'unmute' | 'video') => {
      try {
        await sendControl(encode({ type: what === 'unmute' ? 'ask-unmute' : 'ask-video' }), {
          reliable: true,
          topic: CONTROL_TOPIC,
          destinationIdentities: [identity],
        });
        toast(`Asked ${nameOf(identity)} to ${what === 'unmute' ? 'unmute' : 'start video'}`);
      } catch {
        toast("Couldn't send the request");
      }
    },
    [sendControl, toast, nameOf],
  );

  /* ---------------------------- notifications ----------------------------- */

  useEffect(() => {
    const onJoin = (p: Participant) => {
      if (isWaiting(p)) {
        if (rolesRef.current.privileged) {
          toast(`${displayName(p)} is in the waiting room`, {
            label: 'Admit',
            run: () => api('admit', { target: p.identity }).catch(() => {}),
          });
        }
      } else {
        toast(`${displayName(p)} joined`);
      }
    };
    const onLeft = (p: Participant) => {
      if (!isWaiting(p)) toast(`${displayName(p)} left`);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room, toast, api]);

  // Announce role changes that affect us (not the initial role of whoever
  // starts the meeting).
  const prevRole = useRef<string | null>(null);
  const myRole = roles.roleOf(me) ?? '';
  const othersHere = admitted.length > 1;
  useEffect(() => {
    if (prevRole.current !== null && othersHere && myRole !== prevRole.current) {
      if (myRole === 'host') toast('You are now the host');
      if (myRole === 'cohost') toast('You are now a co-host');
    }
    prevRole.current = myRole;
  }, [myRole, othersHere, toast]);

  // If we became host/co-host while our publish rights were restricted (e.g.
  // the host left and the role fell to us), ask the server to re-apply them.
  const synced = useRef(false);
  const perms = localParticipant.permissions;
  useEffect(() => {
    if (!privileged || !perms) {
      synced.current = false;
      return;
    }
    const restricted = !perms.canPublishData || (perms.canPublishSources?.length ?? 0) < 4;
    if (restricted && !synced.current) {
      synced.current = true;
      api('settings').catch(() => {
        synced.current = false;
      });
    }
  }, [privileged, perms, roles.tick, api]);

  /* ------------------------------- controls ------------------------------- */

  const blockedAlert = (what: string) =>
    Alert.alert(`${what} disabled`, `The host has disabled this for participants.`);

  const toggleMic = useCallback(() => {
    if (!isMicrophoneEnabled && !canPublishSource(localParticipant, SOURCE_MIC)) {
      blockedAlert('Unmuting');
      return;
    }
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {});
  }, [localParticipant, isMicrophoneEnabled]);
  const toggleCam = useCallback(() => {
    if (!isCameraEnabled && !canPublishSource(localParticipant, SOURCE_CAMERA)) {
      blockedAlert('Video');
      return;
    }
    localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => {});
  }, [localParticipant, isCameraEnabled]);
  const toggleScreen = useCallback(async () => {
    if (!isScreenShareEnabled && !canPublishSource(localParticipant, SOURCE_SCREEN)) {
      blockedAlert('Screen sharing');
      return;
    }
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
    } catch {
      // User dismissed the capture prompt, or capture failed — ignore.
    }
  }, [localParticipant, isScreenShareEnabled]);
  const setCameraFacing = useCallback(
    async (next: 'user' | 'environment') => {
      const pub = localParticipant.getTrackPublication(Track.Source.Camera);
      const videoTrack = pub?.videoTrack as LocalVideoTrack | undefined;
      if (!videoTrack) return;
      try {
        await videoTrack.restartTrack({ facingMode: next });
        setFacing(next);
      } catch {
        // Simulators have no real camera to flip — ignore.
      }
    },
    [localParticipant],
  );
  const flipCamera = useCallback(
    () => setCameraFacing(facing === 'user' ? 'environment' : 'user'),
    [facing, setCameraFacing],
  );
  const toggleHand = useCallback(async () => {
    try {
      await localParticipant.setAttributes({ handRaised: iRaisedHand ? '' : 'true' });
    } catch {
      /* ignore */
    }
  }, [localParticipant, iRaisedHand]);
  const leave = useCallback(() => {
    room.disconnect();
    onLeave();
  }, [room, onLeave]);
  const endForAll = useCallback(() => {
    api('end').catch((e) => Alert.alert('Could not end the meeting', e instanceof Error ? e.message : ''));
  }, [api]);
  // Zoom-style: the host chooses between ending for everyone and just leaving.
  const onLeavePress = useCallback(() => {
    if (!isHost) return leave();
    Alert.alert('End this meeting?', 'To leave without ending it, tap Leave — the host role passes to someone else.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave meeting', onPress: leave },
      { text: 'End for all', style: 'destructive', onPress: endForAll },
    ]);
  }, [isHost, leave, endForAll]);

  const invitation = `${displayName(localParticipant)} is inviting you to a Beldex Meet meeting.\n\nJoin: ${joinUrl(roomName)}\nMeeting code: ${roomName}`;
  const invite = useCallback(() => {
    Share.share({ message: invitation }).catch(() => {});
  }, [invitation]);

  const raisedList = admitted.filter((p) => raisedHands.has(p.identity));
  const selfTrack = cameraTrack
    ? { participant: localParticipant, source: Track.Source.Camera, publication: cameraTrack }
    : undefined;

  return (
    <SafeAreaView style={styles.roomRoot}>
      <StatusBar style="light" />
      <View style={styles.roomHeader}>
        <Pressable style={styles.roomTitleBtn} onPress={() => setInfoOpen(true)} accessibilityLabel="Meeting information">
          <MaterialIcons name={settings.locked ? 'lock' : 'verified-user'} size={16} color={settings.locked ? '#f87171' : '#22c55e'} />
          <Text style={styles.roomTitle} numberOfLines={1}>
            {roomName}
          </Text>
          <Text style={styles.roomTimer}>{formatDuration(now - startedAt)}</Text>
        </Pressable>
        <Pressable
          onPress={() => setLayout((l) => (l === 'gallery' ? 'speaker' : 'gallery'))}
          hitSlop={8}
          accessibilityLabel={layout === 'gallery' ? 'Switch to speaker view' : 'Switch to gallery view'}
        >
          <MaterialIcons name={layout === 'gallery' ? 'person' : 'grid-view'} size={22} color="#cbd5e1" />
        </Pressable>
        <Text style={styles.roomCount}>{admitted.length} in call</Text>
      </View>

      {raisedList.length > 0 && (
        <View style={styles.handBanner}>
          <Text style={styles.handBannerText} numberOfLines={1}>
            {HAND} {raisedList.map((p) => p.name || p.identity).join(', ')}
          </Text>
        </View>
      )}
      {isScreenShareEnabled && (
        <View style={[styles.handBanner, styles.shareBanner]}>
          <Text style={styles.handBannerText}>You are sharing your screen</Text>
          <Pressable onPress={toggleScreen} style={styles.bannerBtn}>
            <Text style={styles.bannerBtnText}>Stop</Text>
          </Pressable>
        </View>
      )}
      {!privileged && !settings.allowUnmute && (
        <View style={[styles.handBanner, styles.mutedBanner]}>
          <Text style={styles.handBannerText}>🔇 The host has disabled unmuting</Text>
        </View>
      )}

      <View style={styles.stage}>
        {tracks.length === 0 ? (
          <View style={styles.centerFill}>
            <Text style={styles.roomMsg}>Waiting for others to join…</Text>
            <Pressable style={styles.inviteBtn} onPress={invite}>
              <MaterialIcons name="person-add" size={18} color="#fff" />
              <Text style={styles.leaveBtnText}>Invite</Text>
            </Pressable>
          </View>
        ) : layout === 'speaker' && mainTrack ? (
          <View style={{ flex: 1 }}>
            <View style={styles.mainWrap}>
              <Tile
                track={mainTrack}
                variant="main"
                raised={raisedHands.has(mainTrack.participant?.identity ?? '')}
              />
            </View>
            {thumbs.length > 0 && (
              <FlatList
                horizontal
                data={thumbs}
                keyExtractor={(item, i) => trackKey(item, i)}
                contentContainerStyle={styles.thumbRow}
                renderItem={({ item }) => (
                  <Tile track={item} variant="thumb" raised={raisedHands.has(item.participant?.identity ?? '')} />
                )}
              />
            )}
          </View>
        ) : (
          <FlatList
            data={tracks}
            keyExtractor={(item, i) => trackKey(item, i)}
            numColumns={2}
            columnWrapperStyle={{ gap: 8 }}
            contentContainerStyle={styles.grid}
            renderItem={({ item }) => (
              <Tile track={item} raised={raisedHands.has(item.participant?.identity ?? '')} />
            )}
          />
        )}

        {selfView.show && (
          <Pressable style={styles.selfView} onLongPress={() => setSelfView((v) => ({ ...v, show: false }))}>
            {isCameraEnabled && selfTrack ? (
              <VideoTrack trackRef={selfTrack} style={styles.video} objectFit="cover" mirror={selfView.mirror && facing === 'user'} zOrder={1} />
            ) : (
              <View style={styles.avatarWrap}>
                <Text style={styles.avatarText}>{displayName(localParticipant).charAt(0).toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.selfTag}>
              <Text style={styles.nameTagText}>You{isMicrophoneEnabled ? '' : ' 🔇'}</Text>
            </View>
          </Pressable>
        )}

        <FloatingReactions items={floating} />

        <View style={styles.toasts} pointerEvents="box-none">
          {toasts.map((t) => (
            <View key={t.id} style={styles.toast}>
              <Text style={styles.toastText}>{t.text}</Text>
              {t.action && (
                <Pressable
                  style={styles.toastBtn}
                  onPress={() => {
                    t.action!.run();
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                  }}
                >
                  <Text style={styles.toastBtnText}>{t.action.label}</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      </View>

      {reactOpen && (
        <View style={styles.reactBar}>
          {REACTIONS.map((e) => (
            <Pressable key={e} style={styles.reactBtn} onPress={() => sendReaction(e)}>
              <Text style={styles.reactEmoji}>{e}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.controlBar}>
        <View style={styles.controlRow}>
          <ControlButton
            icon={isMicrophoneEnabled ? 'mic' : 'mic-off'}
            label={isMicrophoneEnabled ? 'Mute' : 'Unmute'}
            active={isMicrophoneEnabled}
            onPress={toggleMic}
          />
          <ControlButton
            icon={isCameraEnabled ? 'videocam' : 'videocam-off'}
            label="Camera"
            active={isCameraEnabled}
            onPress={toggleCam}
          />
          <ControlButton icon="flip-camera-ios" label="Flip" onPress={flipCamera} />
          <ControlButton
            icon={isScreenShareEnabled ? 'stop-screen-share' : 'screen-share'}
            label="Share"
            accent={isScreenShareEnabled}
            onPress={toggleScreen}
          />
          <ControlButton icon="call-end" label={isHost ? 'End' : 'Leave'} danger onPress={onLeavePress} />
        </View>
        <View style={styles.controlRow}>
          <ControlButton
            icon="back-hand"
            label="Hand"
            accent={iRaisedHand}
            onPress={toggleHand}
          />
          <ControlButton
            icon="add-reaction"
            label="React"
            accent={reactOpen}
            onPress={() => (chatBlocked ? blockedAlert('Reactions') : setReactOpen((v) => !v))}
          />
          <ControlButton icon="chat" label="Chat" badge={unread} onPress={() => openChat()} />
          <ControlButton
            icon="people"
            label="People"
            badge={privileged ? waiting.length : 0}
            onPress={() => setPeopleOpen(true)}
          />
          <ControlButton icon="more-horiz" label="More" onPress={() => setMoreOpen(true)} />
        </View>
      </View>

      <ChatModal
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        items={chatItems}
        peers={admitted.filter((p) => p.identity !== me)}
        to={chatTo}
        setTo={setChatTo}
        blocked={chatBlocked}
        onSend={sendMessage}
      />
      <ParticipantsModal
        visible={peopleOpen}
        onClose={() => setPeopleOpen(false)}
        roles={roles}
        localIdentity={me}
        api={api}
        askTo={askTo}
        onMessage={(id) => {
          setPeopleOpen(false);
          openChat(id);
        }}
        onRename={(p) => {
          setPeopleOpen(false);
          setRenameTarget(p);
        }}
        onInvite={invite}
        onEnd={() => {
          setPeopleOpen(false);
          onLeavePress();
        }}
      />
      <SheetMenu
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        items={[
          { icon: 'info-outline', label: 'Meeting info', onPress: () => setInfoOpen(true) },
          { icon: 'person-add', label: 'Invite others', onPress: invite },
          {
            icon: layout === 'gallery' ? 'person' : 'grid-view',
            label: layout === 'gallery' ? 'Speaker view' : 'Gallery view',
            onPress: () => setLayout((l) => (l === 'gallery' ? 'speaker' : 'gallery')),
          },
          ...(settings.allowRename || privileged
            ? [{ icon: 'edit' as const, label: 'Rename me', onPress: () => setRenameTarget(localParticipant) }]
            : []),
          { icon: 'settings', label: 'Settings', onPress: () => setSettingsOpen(true) },
        ]}
      />
      <SettingsModal
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        facing={facing}
        setFacing={setCameraFacing}
        selfView={selfView}
        setSelfView={setSelfView}
      />
      <InfoModal
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        roomName={roomName}
        hostName={nameOf(roles.hostIdentity ?? '')}
        duration={formatDuration(now - startedAt)}
        security={
          [settings.locked && 'Locked', settings.waitingRoom && 'Waiting room on'].filter(Boolean).join(' · ') ||
          'Open'
        }
        onShare={invite}
      />
      <RenameModal
        key={renameTarget?.identity ?? 'none'}
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSave={(name) => api('rename', { target: renameTarget!.identity, name })}
      />
    </SafeAreaView>
  );
}

function FloatingReactions({ items }: { items: FloatingReaction[] }) {
  return (
    <View style={styles.floatLayer} pointerEvents="none">
      {items.map((r) => (
        <ReactionBubble key={r.id} emoji={r.emoji} left={r.left} />
      ))}
    </View>
  );
}

function ReactionBubble({ emoji, left }: { emoji: string; left: number }) {
  // Lazy state (not a ref) so the value can be read during render for interpolation.
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: 3200, useNativeDriver: true }).start();
  }, [progress]);
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -260] });
  const opacity = progress.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 1, 0] });
  return (
    <Animated.Text
      style={[styles.floatEmoji, { left: `${left}%`, opacity, transform: [{ translateY }] }]}
    >
      {emoji}
    </Animated.Text>
  );
}

function Tile({
  track,
  raised,
  variant = 'grid',
}: {
  track: TrackReferenceOrPlaceholder;
  raised?: boolean;
  variant?: 'grid' | 'main' | 'thumb';
}) {
  const name = track.participant?.name || track.participant?.identity || 'Guest';
  const speaking = useIsSpeaking(track.participant);
  // A screen-share track is always a real reference (withPlaceholder: false) and should
  // render regardless of the sharer's camera state. A camera tile renders only when that
  // participant's camera is on; otherwise it falls back to the avatar placeholder.
  const isScreenShare = isTrackReference(track) && track.source === Track.Source.ScreenShare;
  const showVideo = isTrackReference(track) && (isScreenShare || track.participant?.isCameraEnabled);
  const micOff = track.participant && !track.participant.isMicrophoneEnabled;
  return (
    <View
      style={[
        styles.tile,
        variant === 'main' && styles.tileMain,
        variant === 'thumb' && styles.tileThumb,
        speaking && !isScreenShare && styles.tileSpeaking,
      ]}
    >
      {showVideo ? (
        <VideoTrack
          trackRef={track}
          style={styles.video}
          objectFit={isScreenShare ? 'contain' : 'cover'}
        />
      ) : (
        <View style={styles.avatarWrap}>
          <View style={[styles.avatar, variant === 'thumb' && styles.avatarSmall]}>
            <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        </View>
      )}
      {raised && !isScreenShare && (
        <View style={styles.handBadge}>
          <Text style={styles.handBadgeText}>{HAND}</Text>
        </View>
      )}
      <View style={styles.nameTag}>
        <Text style={styles.nameTagText} numberOfLines={1}>
          {micOff && !isScreenShare ? '🔇 ' : ''}
          {name}
          {isScreenShare ? ' · screen' : ''}
          {track.participant?.isLocal ? ' (you)' : ''}
        </Text>
      </View>
    </View>
  );
}

const PERMISSIONS: { key: 'allowUnmute' | 'allowVideo' | 'allowScreenShare' | 'allowChat' | 'allowRename'; label: string }[] = [
  { key: 'allowUnmute', label: 'Unmute themselves' },
  { key: 'allowVideo', label: 'Start video' },
  { key: 'allowScreenShare', label: 'Share screen' },
  { key: 'allowChat', label: 'Chat & react' },
  { key: 'allowRename', label: 'Rename themselves' },
];

function ParticipantsModal({
  visible,
  onClose,
  roles,
  localIdentity,
  api,
  askTo,
  onMessage,
  onRename,
  onInvite,
  onEnd,
}: {
  visible: boolean;
  onClose: () => void;
  roles: Roles;
  localIdentity: string;
  api: (path: string, body?: Record<string, unknown>) => Promise<void>;
  askTo: (identity: string, what: 'unmute' | 'video') => void;
  onMessage: (identity: string) => void;
  onRename: (p: Participant) => void;
  onInvite: () => void;
  onEnd: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { settings, admitted, waiting, hostIdentity, isHost, privileged, raisedHands, roleOf } = roles;

  const act = useCallback(
    async (path: string, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      setError('');
      setExpanded(null);
      try {
        await api(path, extra);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  // You first, then the host, co-hosts, raised hands, then by name.
  const rank = (p: Participant) =>
    p.identity === localIdentity ? 0 : p.identity === hostIdentity ? 1 : roleOf(p.identity) ? 2 : raisedHands.has(p.identity) ? 3 : 4;
  const sorted = [...admitted].sort((a, b) => rank(a) - rank(b) || displayName(a).localeCompare(displayName(b)));

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.chatBackdrop}>
        <View style={styles.chatSheet}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Participants ({admitted.length})</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close participants">
              <MaterialIcons name="close" size={24} color="#94a3b8" />
            </Pressable>
          </View>

          {privileged && (
            <View style={[styles.hostBar, { flexWrap: 'wrap' }]}>
              <HostButton label="Mute all" disabled={busy} onPress={() => act('mute')} />
              {raisedHands.size > 0 && (
                <HostButton label="Lower hands" disabled={busy} onPress={() => act('hands')} />
              )}
              <HostButton
                label={settings.locked ? 'Unlock room' : 'Lock room'}
                on={settings.locked}
                disabled={busy}
                onPress={() => act('lock', { locked: !settings.locked })}
              />
              {isHost && <HostButton label="End meeting" on disabled={busy} onPress={onEnd} />}
            </View>
          )}
          {!!error && <Text style={styles.peopleError}>{error}</Text>}

          <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
            {privileged && waiting.length > 0 && (
              <>
                <View style={styles.sectionHead}>
                  <Text style={styles.sectionHeadText}>Waiting room ({waiting.length})</Text>
                  <Pressable onPress={() => act('admit', { all: true })} disabled={busy} hitSlop={8}>
                    <Text style={styles.sectionLink}>Admit all</Text>
                  </Pressable>
                </View>
                {waiting.map((p) => (
                  <View key={p.identity} style={styles.peopleRow}>
                    <Text style={styles.peopleName} numberOfLines={1}>
                      {displayName(p)}
                    </Text>
                    <View style={styles.peopleActions}>
                      <MiniButton label="Admit" primary disabled={busy} onPress={() => act('admit', { target: p.identity })} />
                      <MiniButton label="Deny" danger disabled={busy} onPress={() => act('admit', { target: p.identity, deny: true })} />
                    </View>
                  </View>
                ))}
                <View style={styles.sectionHead}>
                  <Text style={styles.sectionHeadText}>In the meeting ({admitted.length})</Text>
                </View>
              </>
            )}

            {sorted.map((p) => {
              const you = p.identity === localIdentity;
              const role = roleOf(p.identity);
              const canManage = privileged && !you && !(role === 'host' && !isHost);
              const micOn = p.isMicrophoneEnabled;
              const camOn = p.isCameraEnabled;
              const open = expanded === p.identity;
              const canRename = canManage || (you && (settings.allowRename || privileged));
              return (
                <View key={p.identity} style={styles.peopleCard}>
                  <View style={styles.peopleRowInner}>
                    <Text style={styles.peopleName} numberOfLines={1}>
                      {displayName(p)}
                      {you ? ' (you)' : ''}
                      {role === 'host' ? '  ·  HOST' : role === 'cohost' ? '  ·  CO-HOST' : ''}
                      {raisedHands.has(p.identity) ? `  ${HAND}` : ''}
                    </Text>
                    <MaterialIcons name={micOn ? 'mic' : 'mic-off'} size={18} color={micOn ? '#e2e8f0' : '#f87171'} />
                    <MaterialIcons name={camOn ? 'videocam' : 'videocam-off'} size={18} color={camOn ? '#e2e8f0' : '#f87171'} />
                    {(canManage || canRename || !you) && (
                      <Pressable
                        onPress={() => setExpanded(open ? null : p.identity)}
                        hitSlop={8}
                        accessibilityLabel={`More actions for ${displayName(p)}`}
                      >
                        <MaterialIcons name={open ? 'expand-less' : 'more-vert'} size={22} color="#94a3b8" />
                      </Pressable>
                    )}
                  </View>
                  {open && (
                    <View style={styles.peopleMenu}>
                      {canManage &&
                        (micOn ? (
                          <MiniButton label="Mute" disabled={busy} onPress={() => act('mute', { target: p.identity })} />
                        ) : (
                          <MiniButton label="Ask to unmute" onPress={() => { setExpanded(null); askTo(p.identity, 'unmute'); }} />
                        ))}
                      {canManage &&
                        (camOn ? (
                          <MiniButton label="Stop video" disabled={busy} onPress={() => act('mute', { target: p.identity, source: 'camera' })} />
                        ) : (
                          <MiniButton label="Ask to start video" onPress={() => { setExpanded(null); askTo(p.identity, 'video'); }} />
                        ))}
                      {!you && <MiniButton label="Message" onPress={() => onMessage(p.identity)} />}
                      {canRename && <MiniButton label="Rename" onPress={() => onRename(p)} />}
                      {isHost && !you && (
                        <MiniButton label="Make host" disabled={busy} onPress={() => act('role', { target: p.identity, role: 'host' })} />
                      )}
                      {isHost && !you && (
                        <MiniButton
                          label={role === 'cohost' ? 'Remove co-host' : 'Make co-host'}
                          disabled={busy}
                          onPress={() => act('role', { target: p.identity, role: role === 'cohost' ? 'participant' : 'cohost' })}
                        />
                      )}
                      {canManage && (
                        <MiniButton label="Remove" danger disabled={busy} onPress={() => act('remove', { target: p.identity })} />
                      )}
                    </View>
                  )}
                </View>
              );
            })}

            {privileged && (
              <View style={styles.permsBox}>
                <Text style={styles.sectionHeadText}>Security</Text>
                <SwitchRow
                  label="Enable waiting room"
                  value={settings.waitingRoom}
                  disabled={busy}
                  onChange={(v) => act('settings', { waitingRoom: v })}
                />
                <Text style={[styles.sectionHeadText, { marginTop: 10 }]}>Allow participants to</Text>
                {PERMISSIONS.map(({ key, label }) => (
                  <SwitchRow
                    key={key}
                    label={label}
                    value={settings[key]}
                    disabled={busy}
                    onChange={(v) => act('settings', { [key]: v })}
                  />
                ))}
              </View>
            )}
          </ScrollView>

          <View style={styles.sheetFooter}>
            <Pressable style={({ pressed }) => [styles.footerBtn, pressed && styles.pressed]} onPress={onInvite}>
              <MaterialIcons name="person-add" size={18} color="#fff" />
              <Text style={styles.hostBtnText}>Invite</Text>
            </Pressable>
            {!privileged && hostIdentity && (
              <Pressable
                style={({ pressed }) => [styles.footerBtn, pressed && styles.pressed]}
                onPress={() => onMessage(hostIdentity)}
              >
                <MaterialIcons name="chat" size={18} color="#fff" />
                <Text style={styles.hostBtnText}>Message host</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HostButton({
  label,
  on,
  disabled,
  onPress,
}: {
  label: string;
  on?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.hostBtn, { flexBasis: '40%' }, on && styles.hostBtnOn, pressed && styles.pressed]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.hostBtnText}>{label}</Text>
    </Pressable>
  );
}

function MiniButton({
  label,
  primary,
  danger,
  disabled,
  onPress,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.miniBtn,
        primary && styles.miniPrimary,
        danger && styles.miniDanger,
        pressed && styles.pressed,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.miniBtnText}>{label}</Text>
    </Pressable>
  );
}

function SwitchRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch value={value} disabled={disabled} onValueChange={onChange} />
    </View>
  );
}

function ControlButton({
  icon,
  label,
  active,
  danger,
  accent,
  badge,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  active?: boolean;
  danger?: boolean;
  accent?: boolean;
  badge?: number;
  onPress: () => void;
}) {
  const off = active === false;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.ctrl,
        off && styles.ctrlOff,
        accent && styles.ctrlAccent,
        danger && styles.ctrlDanger,
        pressed && styles.ctrlPressed,
      ]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <MaterialIcons name={icon} size={20} color="#fff" />
      <Text style={styles.ctrlText} numberOfLines={1}>
        {label}
      </Text>
      {!!badge && (
        <View style={styles.ctrlBadge}>
          <Text style={styles.ctrlBadgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

function ChatModal({
  visible,
  onClose,
  items,
  peers,
  to,
  setTo,
  blocked,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  items: ChatItem[];
  peers: Participant[];
  to: string;
  setTo: (identity: string) => void;
  blocked: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const insets = useSafeAreaInsets();
  const [kb, setKb] = useState(0);

  useEffect(() => {
    // Lift by the gap from the screen bottom to the keyboard's top edge. Using the
    // absolute keyboard position (screenY) is frame-accurate under Android edge-to-edge,
    // where endCoordinates.height can undercount by the nav-bar height.
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const screenH = Dimensions.get('screen').height;
      setKb(Math.max(0, screenH - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // A private recipient who left falls back to everyone.
  const recipient = peers.some((p) => p.identity === to) ? to : '';
  const ordered = useMemo(() => [...items].reverse(), [items]);

  const onSendPress = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError('');
    try {
      if (recipient !== to) setTo(recipient);
      await onSend(text);
    } catch (e) {
      setDraft(text);
      setError(e instanceof Error ? e.message : 'Message not sent');
    }
  }, [draft, onSend, recipient, to, setTo]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.chatBackdrop}>
        <View style={[styles.chatSheet, kb > 0 && { flex: 1, height: undefined, marginBottom: kb }]}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Chat</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close chat">
              <MaterialIcons name="close" size={24} color="#94a3b8" />
            </Pressable>
          </View>
          <FlatList
            data={ordered}
            inverted
            keyExtractor={(m) => m.key}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => (
              <View style={[styles.msg, item.privateWith ? styles.msgPrivate : null]}>
                <Text style={styles.msgFrom}>
                  {item.privateWith
                    ? item.mine
                      ? `You → ${item.privateWith} (privately)`
                      : `${item.fromName} → You (privately)`
                    : item.fromName}
                  <Text style={styles.msgTime}>
                    {'  '}
                    {new Date(item.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </Text>
                </Text>
                <Text style={styles.msgText}>{item.text}</Text>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.chatEmpty}>No messages yet.</Text>}
          />
          {blocked ? (
            <Text style={[styles.chatEmpty, { paddingBottom: 16 + insets.bottom }]}>The host has disabled chat</Text>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.toRow}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.toLabel}>To:</Text>
                {[{ identity: '', label: 'Everyone' }, ...peers.map((p) => ({ identity: p.identity, label: displayName(p) }))].map(
                  (r) => (
                    <Pressable
                      key={r.identity || 'everyone'}
                      onPress={() => setTo(r.identity)}
                      style={[styles.toChip, recipient === r.identity && styles.toChipOn]}
                    >
                      <Text style={styles.toChipText}>{r.label}</Text>
                    </Pressable>
                  ),
                )}
              </ScrollView>
              {!!error && <Text style={styles.peopleError}>{error}</Text>}
              <View style={[styles.chatInputRow, { paddingBottom: 12 + (kb > 0 ? 0 : insets.bottom) }]}>
                <TextInput
                  style={styles.chatInput}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={recipient ? 'Private message' : 'Message everyone'}
                  placeholderTextColor="#9ca3af"
                  onSubmitEditing={onSendPress}
                  returnKeyType="send"
                />
                <Pressable style={styles.sendBtn} onPress={onSendPress} accessibilityLabel="Send">
                  <MaterialIcons name="send" size={20} color="#fff" />
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// Bottom action sheet (works the same on iOS and Android).
function SheetMenu({
  visible,
  onClose,
  items,
}: {
  visible: boolean;
  onClose: () => void;
  items: { icon: keyof typeof MaterialIcons.glyphMap; label: string; onPress: () => void }[];
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.chatBackdrop} onPress={onClose}>
        <View style={[styles.menuSheet, { paddingBottom: 12 + insets.bottom }]}>
          {items.map((it) => (
            <Pressable
              key={it.label}
              style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
              onPress={() => {
                onClose();
                it.onPress();
              }}
            >
              <MaterialIcons name={it.icon} size={22} color="#e2e8f0" />
              <Text style={styles.menuItemText}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

function SettingsModal({
  visible,
  onClose,
  facing,
  setFacing,
  selfView,
  setSelfView,
}: {
  visible: boolean;
  onClose: () => void;
  facing: 'user' | 'environment';
  setFacing: (f: 'user' | 'environment') => void;
  selfView: { show: boolean; mirror: boolean };
  setSelfView: (v: { show: boolean; mirror: boolean }) => void;
}) {
  const [outputs, setOutputs] = useState<string[]>([]);
  const [output, setOutput] = useState<string | null>(null);

  // Android lists the available routes (speaker, earpiece, headset, bluetooth);
  // iOS uses the system route picker instead.
  useEffect(() => {
    if (!visible || Platform.OS !== 'android') return;
    AudioSession.getAudioOutputs()
      .then(setOutputs)
      .catch(() => setOutputs([]));
  }, [visible]);

  const pickOutput = async (id: string) => {
    try {
      await AudioSession.selectAudioOutput(id);
      setOutput(id);
    } catch (e) {
      Alert.alert('Could not switch audio output', e instanceof Error ? e.message : '');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.chatBackdrop}>
        <View style={[styles.chatSheet, { height: undefined, maxHeight: '85%' }]}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Settings</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close settings">
              <MaterialIcons name="close" size={24} color="#94a3b8" />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 32 }}>
            <Text style={styles.sectionHeadText}>Audio output</Text>
            {Platform.OS === 'ios' ? (
              <Pressable
                style={({ pressed }) => [styles.footerBtn, pressed && styles.pressed]}
                onPress={() => AudioSession.showAudioRoutePicker().catch(() => {})}
              >
                <MaterialIcons name="speaker" size={18} color="#fff" />
                <Text style={styles.hostBtnText}>Choose speaker / Bluetooth / AirPlay</Text>
              </Pressable>
            ) : outputs.length === 0 ? (
              <Text style={styles.chatEmpty}>Using the system default output.</Text>
            ) : (
              <View style={styles.segment}>
                {outputs.map((o) => (
                  <Pressable
                    key={o}
                    onPress={() => pickOutput(o)}
                    style={[styles.toChip, output === o && styles.toChipOn]}
                  >
                    <Text style={styles.toChipText}>{o.charAt(0).toUpperCase() + o.slice(1)}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={[styles.sectionHeadText, { marginTop: 12 }]}>Camera</Text>
            <View style={styles.segment}>
              {(['user', 'environment'] as const).map((f) => (
                <Pressable key={f} onPress={() => setFacing(f)} style={[styles.toChip, facing === f && styles.toChipOn]}>
                  <Text style={styles.toChipText}>{f === 'user' ? 'Front' : 'Back'}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.sectionHeadText, { marginTop: 12 }]}>Self view</Text>
            <SwitchRow label="Show my video" value={selfView.show} onChange={(show) => setSelfView({ ...selfView, show })} />
            <SwitchRow label="Mirror my video" value={selfView.mirror} onChange={(mirror) => setSelfView({ ...selfView, mirror })} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function InfoModal({
  visible,
  onClose,
  roomName,
  hostName,
  duration,
  security,
  onShare,
}: {
  visible: boolean;
  onClose: () => void;
  roomName: string;
  hostName: string;
  duration: string;
  security: string;
  onShare: () => void;
}) {
  const rows: [string, string][] = [
    ['Meeting code', roomName],
    ['Host', hostName],
    ['Duration', duration],
    ['Invite link', joinUrl(roomName)],
    ['Security', security],
  ];
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={[styles.chatBackdrop, { justifyContent: 'center', padding: 24 }]} onPress={onClose}>
        <Pressable style={styles.dialog} onPress={() => {}}>
          <Text style={styles.chatTitle}>{roomName}</Text>
          {rows.map(([k, v]) => (
            <View key={k} style={{ marginTop: 10 }}>
              <Text style={styles.infoLabel}>{k}</Text>
              <Text selectable style={styles.infoValue}>
                {v}
              </Text>
            </View>
          ))}
          <Pressable style={[styles.primaryBtn, { marginTop: 18 }]} onPress={onShare}>
            <Text style={styles.primaryBtnText}>Share invitation</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RenameModal({
  target,
  onClose,
  onSave,
}: {
  target: Participant | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(() => (target ? displayName(target) : ''));
  const [error, setError] = useState('');
  const save = async () => {
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    }
  };
  return (
    <Modal visible={!!target} animationType="fade" transparent onRequestClose={onClose}>
      <View style={[styles.chatBackdrop, { justifyContent: 'center', padding: 24 }]}>
        <View style={styles.dialog}>
          <Text style={styles.chatTitle}>Rename</Text>
          <TextInput
            style={[styles.chatInput, { marginTop: 12, flex: 0 }]}
            value={name}
            onChangeText={setName}
            autoFocus
            maxLength={64}
            onSubmitEditing={save}
            placeholderTextColor="#9ca3af"
          />
          {!!error && <Text style={styles.peopleError}>{error}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Pressable style={[styles.primaryBtn, { flex: 1 }]} onPress={save}>
              <Text style={styles.primaryBtnText}>Save</Text>
            </Pressable>
            <Pressable style={[styles.hostBtn, { flex: 1, justifyContent: 'center' }]} onPress={onClose}>
              <Text style={styles.hostBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function trackKey(item: TrackReferenceOrPlaceholder, index: number) {
  const pid = item.participant?.identity ?? 'p';
  const src = isTrackReference(item) ? item.source : 'ph';
  return `${pid}-${src}-${index}`;
}

/* --------------------------------- Styles --------------------------------- */

const styles = StyleSheet.create({
  homeRoot: { flex: 1, backgroundColor: '#f8fafc' },
  homeInner: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 34, fontWeight: '700', color: '#0f172a', textAlign: 'center' },
  subtitle: { fontSize: 15, color: '#64748b', textAlign: 'center', marginTop: 6, marginBottom: 28 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  label: { fontSize: 13, color: '#475569', marginBottom: 6, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0f172a',
    marginBottom: 14,
  },
  primaryBtn: { backgroundColor: '#4f46e5', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#0f172a', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  codeBox: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 14,
    backgroundColor: '#f8fafc',
  },
  codeText: { fontSize: 22, fontWeight: '700', color: '#4f46e5', letterSpacing: 1 },
  backBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 6 },
  backBtnText: { color: '#64748b', fontWeight: '600', fontSize: 15 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 18, gap: 10 },
  line: { flex: 1, height: 1, backgroundColor: '#e2e8f0' },
  dividerText: { fontSize: 11, color: '#94a3b8', fontWeight: '600', letterSpacing: 1 },
  error: { color: '#dc2626', marginTop: 14, fontSize: 13, lineHeight: 18 },
  footer: { textAlign: 'center', color: '#94a3b8', fontSize: 12, marginTop: 24 },

  signedInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  signedInText: { color: '#64748b', fontSize: 13 },
  signedInName: { color: '#0f172a', fontWeight: '600' },
  signOutText: { color: '#4f46e5', fontSize: 13, fontWeight: '600' },

  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 999,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 18,
  },
  userAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#818cf8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatarText: { color: '#1e1b4b', fontSize: 16, fontWeight: '700' },
  userPillName: { flex: 1, color: '#0f172a', fontSize: 17, fontWeight: '700' },
  homeHeading: { fontSize: 30, fontWeight: '800', color: '#0f172a', marginTop: 22, marginBottom: 16 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    marginBottom: 4,
  },
  checkLabel: { fontSize: 16, color: '#0f172a' },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#cbd5e1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  paidBox: {
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#eef2ff',
    borderRadius: 12,
    padding: 14,
  },
  paidText: { color: '#0f172a', fontSize: 14, lineHeight: 20 },
  paidActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  feeField: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingRight: 14,
  },
  feeInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  feeUnit: { fontSize: 14, fontWeight: '700' },
  paidHint: { color: '#64748b', fontSize: 13, marginTop: 14, marginBottom: 16 },

  loginRoot: { flex: 1, backgroundColor: '#0b1120' },
  loginInner: { flex: 1, padding: 28, justifyContent: 'center' },
  loginTitle: { color: '#ffffff', fontSize: 34, fontWeight: '800', lineHeight: 40, letterSpacing: -0.5 },
  loginSubtitle: { color: '#aab3d4', fontSize: 17, marginTop: 16 },
  loginInput: {
    marginTop: 28,
    backgroundColor: '#1b2238',
    borderWidth: 1,
    borderColor: '#2c3550',
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 18,
    fontSize: 17,
    color: '#ffffff',
  },
  loginError: { color: '#f87171', fontSize: 13, marginTop: 12, lineHeight: 18 },
  loginBtn: {
    marginTop: 16,
    backgroundColor: '#8b85f8',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  loginBtnText: { color: '#1e1b4b', fontSize: 17, fontWeight: '700' },
  loginNote: { color: '#7c8499', fontSize: 13, marginTop: 16 },

  roomRoot: { flex: 1, backgroundColor: '#0b0f17' },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  roomMsg: { color: '#e2e8f0', fontSize: 15, textAlign: 'center' },
  roomHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  roomTitle: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  roomCount: { color: '#94a3b8', fontSize: 13 },
  grid: { padding: 8, gap: 8 },
  tile: {
    flex: 1,
    aspectRatio: 3 / 4,
    backgroundColor: '#1e293b',
    borderRadius: 14,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  video: { flex: 1 },
  avatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#e2e8f0', fontSize: 26, fontWeight: '700' },
  nameTag: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    maxWidth: '90%',
  },
  nameTagText: { color: '#fff', fontSize: 12 },
  controlBar: {
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#0b0f17',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  controlRow: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  ctrl: {
    flex: 1,
    maxWidth: 76,
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    gap: 4,
  },
  ctrlOff: { backgroundColor: '#b91c1c' },
  ctrlAccent: { backgroundColor: '#2563eb' },
  ctrlDanger: { backgroundColor: '#dc2626' },
  ctrlPressed: { opacity: 0.7 },
  ctrlText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  leaveBtn: { backgroundColor: '#dc2626', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  leaveBtnText: { color: '#fff', fontWeight: '600' },

  chatBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  chatSheet: { height: '85%', backgroundColor: '#0f172a', borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  chatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  chatTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  chatClose: { color: '#818cf8', fontSize: 15, fontWeight: '600' },
  chatEmpty: { color: '#64748b', textAlign: 'center', marginTop: 24 },
  msg: { backgroundColor: '#1e293b', borderRadius: 10, padding: 10 },
  msgFrom: { color: '#818cf8', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  msgText: { color: '#e2e8f0', fontSize: 14 },
  chatInputRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#2563eb',
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  stage: { flex: 1 },
  floatLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  floatEmoji: { position: 'absolute', bottom: 8, fontSize: 38 },
  handBanner: {
    marginHorizontal: 16,
    marginBottom: 4,
    backgroundColor: 'rgba(79,70,229,0.92)',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 14,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  handBannerText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  tileSpeaking: { borderWidth: 2, borderColor: '#22c55e' },
  handBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  handBadgeText: { fontSize: 16 },
  reactBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0b0f17',
  },
  reactBtn: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  reactEmoji: { fontSize: 24 },
  hostBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  hostBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  hostBtnOn: { backgroundColor: '#b91c1c', borderColor: '#dc2626' },
  hostBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  peopleError: { color: '#f87171', fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
  peopleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  peopleName: { color: '#e2e8f0', fontSize: 14, flex: 1 },
  peopleActions: { flexDirection: 'row', gap: 6 },
  miniBtn: {
    backgroundColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  miniDanger: { backgroundColor: '#7f1d1d' },
  miniBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  homeScroll: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  joinOpts: { gap: 6, marginBottom: 12 },
  joinOpt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  joinOptText: { color: '#334155', fontSize: 14 },

  waitTitle: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  waitMeta: { color: '#64748b', fontSize: 12 },
  roomTitleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: 12 },
  roomTimer: { color: '#a5b4fc', fontSize: 13, fontVariant: ['tabular-nums'] },
  shareBanner: { backgroundColor: 'rgba(22,163,74,0.95)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  mutedBanner: { backgroundColor: 'rgba(30,41,59,0.95)' },
  bannerBtn: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  bannerBtnText: { color: '#166534', fontWeight: '700', fontSize: 12 },
  inviteBtn: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    backgroundColor: '#4f46e5',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  mainWrap: { flex: 1, padding: 8 },
  tileMain: { aspectRatio: undefined, flex: 1 },
  tileThumb: { flex: 0, width: 90, aspectRatio: 3 / 4 },
  thumbRow: { gap: 8, paddingHorizontal: 8, paddingBottom: 8 },
  avatarSmall: { width: 36, height: 36, borderRadius: 18 },
  selfView: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 92,
    height: 128,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#334155',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  selfTag: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  toasts: { position: 'absolute', left: 8, right: 8, bottom: 8, gap: 6 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(15,23,42,0.95)',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  toastText: { color: '#e2e8f0', fontSize: 13, flexShrink: 1 },
  toastBtn: { backgroundColor: '#4f46e5', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  toastBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  ctrlBadge: {
    position: 'absolute',
    top: 4,
    right: 8,
    backgroundColor: '#ef4444',
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  msgPrivate: { backgroundColor: '#312e81' },
  msgTime: { color: '#64748b', fontWeight: '400' },
  toRow: { gap: 6, paddingHorizontal: 12, paddingTop: 10, alignItems: 'center' },
  toLabel: { color: '#94a3b8', fontSize: 13, marginRight: 2 },
  toChip: {
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#1e293b',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toChipOn: { backgroundColor: '#4f46e5', borderColor: '#6366f1' },
  toChipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  sectionHeadText: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  sectionLink: { color: '#818cf8', fontWeight: '700', fontSize: 13 },
  peopleCard: { backgroundColor: '#1e293b', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  peopleRowInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  peopleMenu: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  miniPrimary: { backgroundColor: '#4f46e5' },
  permsBox: { marginTop: 12, gap: 2, borderTopWidth: 1, borderTopColor: '#1e293b', paddingTop: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  switchLabel: { color: '#e2e8f0', fontSize: 15 },
  sheetFooter: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: '#1e293b' },
  footerBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 11,
  },
  menuSheet: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  menuItemText: { color: '#e2e8f0', fontSize: 16 },
  dialog: { backgroundColor: '#0f172a', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#334155' },
  infoLabel: { color: '#94a3b8', fontSize: 12 },
  infoValue: { color: '#e2e8f0', fontSize: 15 },
});

/* ------------------------- Home screen navy theme -------------------------- */

const NAVY = {
  bg: '#0d1530',
  card: '#172250',
  field: '#131c42',
  border: '#2b3766',
  accent: '#8b7cff',
  onAccent: '#17133d',
  text: '#eef1ff',
  muted: '#aab2d8',
  placeholder: '#6e7699',
};

const nv = StyleSheet.create({
  root: { backgroundColor: NAVY.bg },
  pill: { backgroundColor: NAVY.card, borderColor: NAVY.border },
  card: { backgroundColor: NAVY.card, borderColor: NAVY.border },
  text: { color: NAVY.text },
  muted: { color: NAVY.muted },
  accentBg: { backgroundColor: NAVY.accent },
  onAccent: { color: NAVY.onAccent },
  input: { backgroundColor: NAVY.field, borderColor: NAVY.border, color: NAVY.text },
  secondaryBtn: { backgroundColor: NAVY.field, borderColor: NAVY.border },
  checkbox: { backgroundColor: '#3a3a3a', borderColor: '#8a8a8a' },
  checkboxOn: { backgroundColor: NAVY.accent, borderColor: NAVY.accent },
  paidBox: { backgroundColor: 'rgba(139,124,255,0.12)', borderColor: 'rgba(139,124,255,0.5)' },
});
