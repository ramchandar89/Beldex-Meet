// Simulated Beldex / BChat identity for the prototype (mobile).
// No real wallet signature yet — sign-in resolves a BChat ID or .bdx name to a
// display name. Phase 2 will replace this with a real Beldex wallet signature.

export type BeldexUser = { id: string; name: string };

// Demo accounts for testing. Enter one of these on the login screen.
export const DEMO_ACCOUNTS: Record<string, string> = {
  'alice.bdx': 'Alice',
  'bob.bdx': 'Bob',
  'carol.bdx': 'Carol',
  'demo.bdx': 'Demo User',
  '05a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00': 'Demo Wallet',
};

const NAME_RE = /^[a-z0-9_-]+\.bdx$/i;
const ID_RE = /^05[0-9a-f]{64}$/i;

function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a login input to a user, or null if it is not a valid BChat ID / name.
 * Accepts the demo accounts, any `name.bdx`, or any 66-char `05…` BChat ID.
 */
export function resolveAccount(input: string): BeldexUser | null {
  const value = input.trim();
  if (!value) return null;
  const key = value.toLowerCase();
  if (DEMO_ACCOUNTS[key]) return { id: key, name: DEMO_ACCOUNTS[key] };
  if (NAME_RE.test(value)) return { id: key, name: titleCase(value.replace(/\.bdx$/i, '')) };
  if (ID_RE.test(value)) return { id: key, name: `Wallet ${value.slice(2, 8)}` };
  return null;
}
