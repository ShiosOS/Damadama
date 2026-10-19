export type TodayHandle = {
  refreshAfterCreate: () => Promise<(() => boolean) | null>;
};
