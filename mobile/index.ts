import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';
import { LogBox } from 'react-native';

import App from './App';

// On the iOS simulator (and any device without a real camera) a published
// camera track has no resolution, so livekit-client logs
// "could not determine track dimensions, using defaults". It's harmless and
// never fires on real camera hardware — hide the dev-only LogBox redbox so it
// doesn't interrupt development. No-op in production builds.
LogBox.ignoreLogs(['could not determine track dimensions']);

// Must run before any LiveKit/WebRTC usage: installs the WebRTC globals.
registerGlobals();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
