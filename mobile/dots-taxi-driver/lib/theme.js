// One place for every colour, size and weight the app uses. A new screen
// reads from here and comes out looking like the rest; nothing is styled by
// hand with a literal hex. The palette is DOTS Blue: the wordmark in white on
// a deep royal blue, white cards on a grey page, blue capitals for labels,
// and green reserved for money.

export const colors = {
  brand: '#20469b',
  brandDeep: '#0a226f',
  brandMid: '#1e4399',
  brandTint: '#e8eefb',
  onBrandMuted: '#b9c8ea',

  bg: '#f5f5f5',
  card: '#ffffff',
  line: '#e3e5ea',
  rule: '#3a3a3a',

  ink: '#1c1c1e',
  muted: '#7a7f8a',
  faint: '#8a8f98',
  placeholder: '#9aa0a8',

  green: '#1e7a34',
  greenTint: '#e6f4ea',
  red: '#b0473f',
  redTint: '#fbeae8',
  amber: '#a66a1f',
  amberTint: '#fbf1e4',
  white: '#ffffff',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 18, xxl: 24 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const type = {
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1, color: colors.brand },
  labelLg: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5, color: colors.brand },
  title: { fontSize: 21, fontWeight: '800', letterSpacing: -0.2, color: colors.ink },
  screenTitle: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3, color: colors.ink },
  body: { fontSize: 15, fontWeight: '600', color: colors.ink },
  bodyRegular: { fontSize: 15, fontWeight: '400', color: colors.ink },
  small: { fontSize: 13, color: colors.muted },
  tiny: { fontSize: 12, color: colors.muted },
  money: { fontSize: 24, fontWeight: '800', letterSpacing: -0.4, color: colors.green },
  moneyXl: { fontSize: 40, fontWeight: '800', letterSpacing: -1, color: colors.ink },
};

export const shadow = {
  card: {
    shadowColor: '#141e3c',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
};
