import { createFont, createTamagui, createTokens } from 'tamagui';

const font = createFont({
  family: 'System',
  size: { 1: 12, 2: 14, 3: 16, 4: 20, 5: 24, 6: 32 },
  lineHeight: { 1: 17, 2: 20, 3: 22, 4: 26, 5: 30, 6: 38 },
  weight: { 1: '400', 2: '500', 3: '700' },
  letterSpacing: { 1: 0, 2: -0.5 },
});

const tokens = createTokens({
  size: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 40, 9: 48, 10: 64, true: 16 },
  space: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 40, 9: 48, 10: 64, true: 16 },
  radius: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, true: 8 },
  zIndex: { 0: 0, 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 },
  color: {
    white: '#fff',
    black: '#000',
    gray1: '#f8f8f8',
    gray2: '#e8e8e8',
    gray3: '#d0d0d0',
    gray4: '#b0b0b0',
    gray5: '#808080',
    gray6: '#505050',
    gray7: '#303030',
    gray8: '#1a1a1a',
  },
});

const tamaguiConfig = createTamagui({
  fonts: {
    heading: font,
    body: font,
  },
  tokens,
  themes: {
    light: {
      background: tokens.color.white,
      color: tokens.color.black,
    },
    dark: {
      background: tokens.color.black,
      color: tokens.color.white,
    },
  },
});

export type AppConfig = typeof tamaguiConfig;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default tamaguiConfig;
