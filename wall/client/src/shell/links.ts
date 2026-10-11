// Rail items that open another Android app instead of a screen (milestone 7). Listed in `screens:`
// in config.yaml like a screen. Fully Kiosk starts the app through its JavaScript interface; the
// app must be allowed in Fully Kiosk's kiosk-mode app list.
export interface RailLink { id: string; title: string; icon: string; androidPackage: string }

export const links: RailLink[] = [
  // Device control stays in Google Home, so nothing is managed in two places.
  { id: 'google-home', title: 'Home', icon: 'home', androidPackage: 'com.google.android.apps.chromecast.app' },
];
